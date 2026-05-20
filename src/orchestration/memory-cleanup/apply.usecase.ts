import type pg from "pg";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { encryptMemoryContent, hashMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import type { MemoryCleanupRepository } from "../../infrastructure/repositories/memory-cleanup.repository.js";
import type { CleanupApplyDeps, CleanupProposalInput } from "./types.js";

interface ApplyDeps extends CleanupApplyDeps {
  cleanupRepository: MemoryCleanupRepository;
}

async function verifyOwnedActiveMemories(client: pg.PoolClient, auth: AuthContext, ids: string[]): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id
     FROM memory_records
     WHERE tenant_id = $1
       AND user_id = $2
       AND deleted_at IS NULL
       AND id = ANY($3::uuid[])`,
    [auth.tenantId, auth.userId, ids]
  );
  const found = new Set(result.rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`Memory ownership check failed for ${missing.join(",")}`);
  }
}

function actionName(type: CleanupProposalInput["proposalType"]): string {
  return `cleanup_${type}`;
}

function bucketMetadata(proposal: CleanupProposalInput): Record<string, unknown> {
  if (!proposal.bucket) return {};
  return {
    cleanup_bucket: proposal.bucket,
    cleanup_bucket_reason: proposal.bucketReason ?? proposal.rationale,
    cleanup_bucket_confidence: proposal.bucketConfidence ?? proposal.confidence,
    cleanup_bucketed_at: new Date().toISOString(),
  };
}

function retentionForBucket(bucket: CleanupProposalInput["bucket"]): {
  tier: string;
  importance: number;
  decayRate: number;
  lifecycle: string;
} | null {
  if (bucket === "permanent") {
    return { tier: "permanent", importance: 0.95, decayRate: 0, lifecycle: "protected" };
  }
  if (bucket === "long_term") {
    return { tier: "long_term", importance: 0.6, decayRate: 0.01, lifecycle: "active" };
  }
  if (bucket === "short_term") {
    return { tier: "short_term", importance: 0.35, decayRate: 0.08, lifecycle: "active" };
  }
  return null;
}

async function updateBucketMetadata(
  client: pg.PoolClient,
  auth: AuthContext,
  memoryId: string,
  proposal: CleanupProposalInput
): Promise<void> {
  const metadata = bucketMetadata(proposal);
  if (Object.keys(metadata).length === 0) return;
  const retention = retentionForBucket(proposal.bucket);
  if (!retention) return;
  await client.query(
    `UPDATE memory_records
     SET summary_json = summary_json || $4::jsonb,
         tier = $5,
         segment = COALESCE(category, memory_type),
         importance = GREATEST(importance, $6),
         decay_rate = $7,
         lifecycle = CASE WHEN lifecycle = 'archived' THEN lifecycle ELSE $8 END
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND deleted_at IS NULL`,
    [
      memoryId,
      auth.tenantId,
      auth.userId,
      JSON.stringify(metadata),
      retention.tier,
      retention.importance,
      retention.decayRate,
      retention.lifecycle,
    ]
  );
}

async function logMemoryEvent(client: pg.PoolClient, auth: AuthContext, input: {
  memoryId: string | null;
  action: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO memory_events
     (tenant_id, user_id, memory_id, action, actor_type, auth_mode, metadata)
     VALUES ($1, $2, $3, $4, 'system', $5, $6::jsonb)`,
    [auth.tenantId, auth.userId, input.memoryId, input.action, auth.authMode, JSON.stringify(input.metadata)]
  );
}

export class ApplyCleanupProposalUseCase {
  constructor(private readonly deps: ApplyDeps) {}

  async execute(input: {
    auth: AuthContext;
    proposalId: string;
    proposal: CleanupProposalInput;
  }): Promise<{ applied: boolean; applyJson: Record<string, unknown> }> {
    const client = await pool.connect();
    const touchedIds = [...new Set([
      ...input.proposal.sourceMemoryIds,
      ...(input.proposal.targetMemoryId ? [input.proposal.targetMemoryId] : []),
    ])];

    try {
      await client.query("BEGIN");
      await verifyOwnedActiveMemories(client, input.auth, touchedIds);

      const applyJson: Record<string, unknown> = {
        proposalType: input.proposal.proposalType,
        appliedAt: new Date().toISOString(),
        touchedMemoryIds: touchedIds,
      };

      if (input.proposal.proposalType === "bucket") {
        const memoryId = input.proposal.sourceMemoryIds[0];
        if (!memoryId || !input.proposal.bucket) throw new Error("Bucket proposal missing memory or bucket");
        await updateBucketMetadata(client, input.auth, memoryId, input.proposal);
        applyJson.bucketedMemoryId = memoryId;
        applyJson.bucket = input.proposal.bucket;
        await logMemoryEvent(client, input.auth, {
          memoryId,
          action: "cleanup_bucket",
          metadata: {
            proposalId: input.proposalId,
            bucket: input.proposal.bucket,
            rationale: input.proposal.rationale,
          },
        });
      }

      if (input.proposal.proposalType === "keep") {
        await logMemoryEvent(client, input.auth, {
          memoryId: input.proposal.sourceMemoryIds[0] ?? null,
          action: "cleanup_keep",
          metadata: { proposalId: input.proposalId, rationale: input.proposal.rationale },
        });
      }

      if (input.proposal.proposalType === "promote") {
        const memoryId = input.proposal.sourceMemoryIds[0];
        await client.query(
          `UPDATE memory_records
           SET is_pinned = TRUE,
               tier = 'permanent',
               segment = COALESCE(category, memory_type),
               importance = GREATEST(importance, 0.9500),
               decay_rate = 0.000000,
               lifecycle = 'protected',
               summary_json = summary_json || $4::jsonb
           WHERE id = $1
             AND tenant_id = $2
             AND user_id = $3`,
          [
            memoryId,
            input.auth.tenantId,
            input.auth.userId,
            JSON.stringify({
              cleanup_bucket: "permanent",
              cleanup_bucket_reason: input.proposal.bucketReason ?? "Promoted memory is permanent.",
              cleanup_bucket_confidence: input.proposal.bucketConfidence ?? input.proposal.confidence,
              cleanup_bucketed_at: new Date().toISOString(),
            }),
          ]
        );
        applyJson.promotedMemoryId = memoryId;
        await logMemoryEvent(client, input.auth, {
          memoryId,
          action: "cleanup_promote",
          metadata: { proposalId: input.proposalId, rationale: input.proposal.rationale },
        });
      }

      if (input.proposal.proposalType === "rewrite") {
        const memoryId = input.proposal.sourceMemoryIds[0];
        if (!input.proposal.proposedContent) throw new Error("Rewrite proposal missing proposed content");
        const encrypted = encryptMemoryContent(input.proposal.proposedContent);
        const contentHash = hashMemoryContent(input.proposal.proposedContent);
        await client.query(
          `UPDATE memory_records
           SET content_ciphertext = $4,
               content_hash = $5,
               summary_json = summary_json || $6::jsonb
           WHERE id = $1
             AND tenant_id = $2
             AND user_id = $3`,
          [
            memoryId,
            input.auth.tenantId,
            input.auth.userId,
            encrypted,
            contentHash,
            JSON.stringify({
              cleanup_rewrite: {
                proposalId: input.proposalId,
                rewrittenAt: new Date().toISOString(),
              },
              ...bucketMetadata(input.proposal),
            }),
          ]
        );
        await updateBucketMetadata(client, input.auth, memoryId, input.proposal);
        applyJson.rewrittenMemoryId = memoryId;
        await logMemoryEvent(client, input.auth, {
          memoryId,
          action: "cleanup_rewrite",
          metadata: { proposalId: input.proposalId, rationale: input.proposal.rationale },
        });
      }

      if (input.proposal.proposalType === "merge") {
        const targetMemoryId = input.proposal.targetMemoryId;
        if (!targetMemoryId) throw new Error("Merge proposal missing target memory");
        if (input.proposal.proposedContent) {
          const encrypted = encryptMemoryContent(input.proposal.proposedContent);
          const contentHash = hashMemoryContent(input.proposal.proposedContent);
          await client.query(
            `UPDATE memory_records
             SET content_ciphertext = $4,
                 content_hash = $5,
                 summary_json = summary_json || $6::jsonb
             WHERE id = $1
               AND tenant_id = $2
               AND user_id = $3`,
            [
              targetMemoryId,
              input.auth.tenantId,
              input.auth.userId,
              encrypted,
              contentHash,
              JSON.stringify({
                cleanup_merge_target: {
                  proposalId: input.proposalId,
                  mergedAt: new Date().toISOString(),
                },
                ...bucketMetadata(input.proposal),
              }),
            ]
          );
        }
        await updateBucketMetadata(client, input.auth, targetMemoryId, input.proposal);
        const redundantIds = input.proposal.sourceMemoryIds.filter((id) => id !== targetMemoryId);
        if (redundantIds.length > 0) {
          await client.query(
            `UPDATE memory_records
             SET superseded_by = $4
             WHERE tenant_id = $1
               AND user_id = $2
               AND id = ANY($3::uuid[])
               AND deleted_at IS NULL`,
            [input.auth.tenantId, input.auth.userId, redundantIds, targetMemoryId]
          );
        }
        applyJson.targetMemoryId = targetMemoryId;
        applyJson.supersededMemoryIds = redundantIds;
        await logMemoryEvent(client, input.auth, {
          memoryId: targetMemoryId,
          action: "cleanup_merge",
          metadata: { proposalId: input.proposalId, supersededMemoryIds: redundantIds, rationale: input.proposal.rationale },
        });
      }

      if (input.proposal.proposalType === "prune") {
        const memoryId = input.proposal.sourceMemoryIds[0];
        await client.query(
          `UPDATE memory_records
           SET deleted_at = NOW()
           WHERE id = $1
             AND tenant_id = $2
             AND user_id = $3
             AND deleted_at IS NULL`,
          [memoryId, input.auth.tenantId, input.auth.userId]
        );
        applyJson.prunedMemoryId = memoryId;
        await logMemoryEvent(client, input.auth, {
          memoryId,
          action: "cleanup_prune",
          metadata: { proposalId: input.proposalId, rationale: input.proposal.rationale },
        });
      }

      await client.query("COMMIT");
      this.deps.invalidateRecallCache(input.auth);
      this.deps.invalidateBm25Cache(input.auth);
      await this.deps.bumpRecallStamp(input.auth).catch(() => {});
      return { applied: true, applyJson };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const applyJson = {
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      await this.deps.cleanupRepository.updateProposal({
        auth: input.auth,
        proposalId: input.proposalId,
        status: "failed",
        applyJson,
      }).catch(() => {});
      try {
        await pool.query(
          `INSERT INTO memory_events
           (tenant_id, user_id, action, actor_type, auth_mode, metadata)
           VALUES ($1, $2, 'cleanup_apply_failed', 'system', $3, $4::jsonb)`,
          [input.auth.tenantId, input.auth.userId, input.auth.authMode, JSON.stringify({ proposalId: input.proposalId, ...applyJson })]
        );
      } catch {
        // Best-effort failure event.
      }
      return { applied: false, applyJson };
    } finally {
      client.release();
    }
  }
}
