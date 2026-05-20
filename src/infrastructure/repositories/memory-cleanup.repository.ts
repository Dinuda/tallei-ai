import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../db/index.js";
import type {
  CleanupBucket,
  CleanupAiUsage,
  CleanupProposalInput,
  CleanupProposalStatus,
  CleanupRiskLevel,
  CleanupRunReason,
  CleanupRunStatus,
  MemoryCleanupProposalView,
  MemoryCleanupRunView,
  MemoryCleanupSummary,
} from "../../orchestration/memory-cleanup/types.js";
import type { MemoryRecordRow } from "./memory.repository.js";

interface CleanupRunRow {
  id: string;
  status: CleanupRunStatus;
  run_reason: CleanupRunReason;
  dry_run: boolean;
  summary_json: unknown;
}

interface CleanupProposalRow {
  id: string;
  proposal_type: CleanupProposalInput["proposalType"];
  status: CleanupProposalStatus;
  source_memory_ids: string[];
  target_memory_id: string | null;
  proposed_content: string | null;
  rationale: string;
  risk_level: CleanupRiskLevel;
  confidence: string | number;
  cleanup_bucket: CleanupBucket | null;
  cleanup_bucket_reason: string | null;
  cleanup_bucket_confidence: string | number | null;
  consolidator_json?: unknown;
  adversary_json?: unknown;
  debate_json?: unknown;
  judge_json?: unknown;
  apply_json?: unknown;
}

function readSummary(value: unknown): MemoryCleanupSummary {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<MemoryCleanupSummary> : {};
  const usageRow = row.usage && typeof row.usage === "object" && !Array.isArray(row.usage)
    ? row.usage as Partial<CleanupAiUsage>
    : null;
  return {
    proposed: Number(row.proposed ?? 0),
    contested: Number(row.contested ?? 0),
    approved: Number(row.approved ?? 0),
    rejected: Number(row.rejected ?? 0),
    applied: Number(row.applied ?? 0),
    failed: Number(row.failed ?? 0),
    kept: Number(row.kept ?? 0),
    bucketed: Number(row.bucketed ?? 0),
    shortTerm: Number(row.shortTerm ?? 0),
    longTerm: Number(row.longTerm ?? 0),
    permanent: Number(row.permanent ?? 0),
    promoted: Number(row.promoted ?? 0),
    merged: Number(row.merged ?? 0),
    rewritten: Number(row.rewritten ?? 0),
    pruned: Number(row.pruned ?? 0),
    durationMs: typeof row.durationMs === "number" ? row.durationMs : undefined,
    aiCalls: typeof row.aiCalls === "number" ? row.aiCalls : undefined,
    selectedMemories: typeof row.selectedMemories === "number" ? row.selectedMemories : undefined,
    batches: typeof row.batches === "number" ? row.batches : undefined,
    remainingUnreviewed: typeof row.remainingUnreviewed === "number" ? row.remainingUnreviewed : undefined,
    usage: usageRow ? {
      calls: Number(usageRow.calls ?? 0),
      promptTokens: Number(usageRow.promptTokens ?? 0),
      completionTokens: Number(usageRow.completionTokens ?? 0),
      totalTokens: Number(usageRow.totalTokens ?? 0),
      estimatedPromptTokens: Number(usageRow.estimatedPromptTokens ?? 0),
      estimatedCompletionTokens: Number(usageRow.estimatedCompletionTokens ?? 0),
      estimatedTotalTokens: Number(usageRow.estimatedTotalTokens ?? 0),
      estimatedCostUsd: Number(usageRow.estimatedCostUsd ?? 0),
      models: usageRow.models && typeof usageRow.models === "object" && !Array.isArray(usageRow.models)
        ? Object.fromEntries(Object.entries(usageRow.models).map(([model, count]) => [model, Number(count ?? 0)]))
        : {},
    } : undefined,
    skipped: typeof row.skipped === "boolean" ? row.skipped : undefined,
    skipReason: typeof row.skipReason === "string" ? row.skipReason : undefined,
  };
}

function mapProposal(row: CleanupProposalRow): MemoryCleanupProposalView {
  return {
    id: row.id,
    proposalType: row.proposal_type,
    status: row.status,
    sourceMemoryIds: row.source_memory_ids,
    targetMemoryId: row.target_memory_id,
    proposedContent: row.proposed_content,
    rationale: row.rationale,
    riskLevel: row.risk_level,
    confidence: Number(row.confidence),
    bucket: row.cleanup_bucket,
    bucketReason: row.cleanup_bucket_reason,
    bucketConfidence: row.cleanup_bucket_confidence === null ? null : Number(row.cleanup_bucket_confidence),
    trace: {
      consolidator: row.consolidator_json ?? {},
      adversary: row.adversary_json ?? {},
      debate: row.debate_json ?? [],
      judge: row.judge_json ?? {},
      apply: row.apply_json ?? {},
    },
  };
}

export class MemoryCleanupRepository {
  async listCandidateMemories(auth: AuthContext, input: {
    limit: number;
    includeReviewed?: boolean;
    excludeMemoryIds?: string[];
  }): Promise<MemoryRecordRow[]> {
    const includeReviewed = input.includeReviewed === true;
    const excludeMemoryIds = input.excludeMemoryIds ?? [];
    const result = await pool.query<MemoryRecordRow>(
      `SELECT mr.*
       FROM memory_records mr
       ${includeReviewed ? "" : `
       LEFT JOIN memory_cleanup_memory_reviews mcr
         ON mcr.tenant_id = mr.tenant_id
        AND mcr.user_id = mr.user_id
        AND mcr.memory_id = mr.id
       `}
       WHERE mr.tenant_id = $1
         AND mr.user_id = $2
         AND mr.deleted_at IS NULL
         AND mr.superseded_by IS NULL
         ${includeReviewed ? "" : "AND mcr.memory_id IS NULL"}
         AND (cardinality($4::uuid[]) = 0 OR mr.id <> ALL($4::uuid[]))
       ORDER BY mr.is_pinned DESC, mr.last_referenced_at DESC NULLS LAST, mr.created_at DESC
       LIMIT $3`,
      [auth.tenantId, auth.userId, input.limit, excludeMemoryIds]
    );
    return result.rows;
  }

  async countUnreviewedMemories(auth: AuthContext): Promise<number> {
    const result = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM memory_records mr
       LEFT JOIN memory_cleanup_memory_reviews mcr
         ON mcr.tenant_id = mr.tenant_id
        AND mcr.user_id = mr.user_id
        AND mcr.memory_id = mr.id
       WHERE mr.tenant_id = $1
         AND mr.user_id = $2
         AND mr.deleted_at IS NULL
         AND mr.superseded_by IS NULL
         AND mcr.memory_id IS NULL`,
      [auth.tenantId, auth.userId]
    );
    return result.rows[0]?.total ?? 0;
  }

  async markMemoriesReviewed(input: {
    auth: AuthContext;
    runId: string;
    memoryIds: string[];
    status: "reviewed" | "applied" | "skipped";
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (input.memoryIds.length === 0) return;
    await pool.query(
      `INSERT INTO memory_cleanup_memory_reviews
       (tenant_id, user_id, memory_id, last_run_id, status, metadata_json)
       SELECT $1, $2, unnest($3::uuid[]), $4, $5, $6::jsonb
       ON CONFLICT (tenant_id, user_id, memory_id)
       DO UPDATE SET
         last_run_id = EXCLUDED.last_run_id,
         status = EXCLUDED.status,
         reviewed_at = NOW(),
         metadata_json = EXCLUDED.metadata_json`,
      [
        input.auth.tenantId,
        input.auth.userId,
        [...new Set(input.memoryIds)],
        input.runId,
        input.status,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
  }

  async resetMemoryReviewFlags(auth: AuthContext): Promise<number> {
    const result = await pool.query(
      `DELETE FROM memory_cleanup_memory_reviews
       WHERE tenant_id = $1
         AND user_id = $2`,
      [auth.tenantId, auth.userId]
    );
    return result.rowCount ?? 0;
  }

  async resetMemoryBucketMetadata(auth: AuthContext): Promise<number> {
    const result = await pool.query(
      `UPDATE memory_records
       SET summary_json = summary_json
         - 'cleanup_bucket'
         - 'cleanup_bucket_reason'
         - 'cleanup_bucket_confidence'
         - 'cleanup_bucketed_at',
           tier = CASE
             WHEN is_pinned = TRUE OR memory_type = 'preference'
               OR lower(COALESCE(category, '')) IN ('identity', 'auth', 'billing', 'security', 'legal', 'payment', 'credentials', 'account')
               THEN 'permanent'
             WHEN memory_type IN ('event', 'note') THEN 'short_term'
             ELSE 'long_term'
           END,
           segment = COALESCE(category, memory_type),
           importance = CASE
             WHEN is_pinned = TRUE OR memory_type = 'preference' THEN 0.9500
             WHEN lower(COALESCE(category, '')) IN ('identity', 'auth', 'billing', 'security', 'legal', 'payment', 'credentials', 'account') THEN 0.9500
             WHEN memory_type IN ('decision', 'checkpoint') THEN 0.7500
             WHEN memory_type IN ('event', 'note') THEN 0.3500
             ELSE 0.6000
           END,
           decay_rate = CASE
             WHEN is_pinned = TRUE OR memory_type = 'preference'
               OR lower(COALESCE(category, '')) IN ('identity', 'auth', 'billing', 'security', 'legal', 'payment', 'credentials', 'account')
               THEN 0.000000
             WHEN memory_type IN ('event', 'note') THEN 0.080000
             ELSE 0.010000
           END,
           lifecycle = CASE
             WHEN is_pinned = TRUE OR memory_type = 'preference'
               OR lower(COALESCE(category, '')) IN ('identity', 'auth', 'billing', 'security', 'legal', 'payment', 'credentials', 'account')
               THEN 'protected'
             ELSE 'active'
           END
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL`,
      [auth.tenantId, auth.userId]
    );
    return result.rowCount ?? 0;
  }

  async hasRunningDailyCleanup(auth: AuthContext): Promise<boolean> {
    const result = await pool.query<{ id: string }>(
      `SELECT id
       FROM memory_cleanup_runs
       WHERE tenant_id = $1
         AND user_id = $2
         AND run_reason = 'daily_intelligence'
         AND status = 'running'
       LIMIT 1`,
      [auth.tenantId, auth.userId]
    );
    return result.rows.length > 0;
  }

  async hasCompletedDailyCleanupToday(auth: AuthContext): Promise<boolean> {
    const result = await pool.query<{ id: string }>(
      `SELECT id
       FROM memory_cleanup_runs
       WHERE tenant_id = $1
         AND user_id = $2
         AND run_reason = 'daily_intelligence'
         AND status = 'completed'
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       LIMIT 1`,
      [auth.tenantId, auth.userId]
    );
    return result.rows.length > 0;
  }

  async createRun(input: {
    auth: AuthContext;
    runReason: CleanupRunReason;
    dryRun: boolean;
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO memory_cleanup_runs
       (id, tenant_id, user_id, status, run_reason, dry_run)
       VALUES ($1, $2, $3, 'running', $4, $5)`,
      [id, input.auth.tenantId, input.auth.userId, input.runReason, input.dryRun]
    );
    return id;
  }

  async updateRunSnapshot(input: {
    auth: AuthContext;
    runId: string;
    snapshot: unknown;
  }): Promise<void> {
    await pool.query(
      `UPDATE memory_cleanup_runs
       SET snapshot_json = $4::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`,
      [input.runId, input.auth.tenantId, input.auth.userId, JSON.stringify(input.snapshot)]
    );
  }

  async completeRun(input: {
    auth: AuthContext;
    runId: string;
    status: "completed" | "failed";
    summary: MemoryCleanupSummary;
    error?: unknown;
  }): Promise<void> {
    await pool.query(
      `UPDATE memory_cleanup_runs
       SET status = $4,
           summary_json = $5::jsonb,
           error_json = $6::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`,
      [
        input.runId,
        input.auth.tenantId,
        input.auth.userId,
        input.status,
        JSON.stringify(input.summary),
        JSON.stringify(input.error ?? {}),
      ]
    );
  }

  async createProposal(input: {
    auth: AuthContext;
    runId: string;
    proposal: CleanupProposalInput;
    status?: CleanupProposalStatus;
    consolidatorJson?: unknown;
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO memory_cleanup_proposals
       (id, run_id, tenant_id, user_id, proposal_type, status, source_memory_ids, target_memory_id, proposed_content, rationale, risk_level, confidence, cleanup_bucket, cleanup_bucket_reason, cleanup_bucket_confidence, consolidator_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
      [
        id,
        input.runId,
        input.auth.tenantId,
        input.auth.userId,
        input.proposal.proposalType,
        input.status ?? "proposed",
        input.proposal.sourceMemoryIds,
        input.proposal.targetMemoryId,
        input.proposal.proposedContent,
        input.proposal.rationale,
        input.proposal.riskLevel,
        input.proposal.confidence,
        input.proposal.bucket ?? null,
        input.proposal.bucketReason ?? null,
        input.proposal.bucketConfidence ?? null,
        JSON.stringify(input.consolidatorJson ?? {}),
      ]
    );
    return id;
  }

  async updateProposal(input: {
    auth: AuthContext;
    proposalId: string;
    status: CleanupProposalStatus;
    proposal?: CleanupProposalInput;
    adversaryJson?: unknown;
    debateJson?: unknown;
    judgeJson?: unknown;
    applyJson?: unknown;
  }): Promise<void> {
    await pool.query(
      `UPDATE memory_cleanup_proposals
       SET status = $4,
           proposal_type = COALESCE($5, proposal_type),
           source_memory_ids = COALESCE($6::uuid[], source_memory_ids),
           target_memory_id = COALESCE($7::uuid, target_memory_id),
           proposed_content = COALESCE($8, proposed_content),
           rationale = COALESCE($9, rationale),
           risk_level = COALESCE($10, risk_level),
           confidence = COALESCE($11, confidence),
           cleanup_bucket = COALESCE($12, cleanup_bucket),
           cleanup_bucket_reason = COALESCE($13, cleanup_bucket_reason),
           cleanup_bucket_confidence = COALESCE($14, cleanup_bucket_confidence),
           adversary_json = adversary_json || $15::jsonb,
           debate_json = CASE WHEN $16::jsonb = '{}'::jsonb THEN debate_json ELSE $16::jsonb END,
           judge_json = judge_json || $17::jsonb,
           apply_json = apply_json || $18::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`,
      [
        input.proposalId,
        input.auth.tenantId,
        input.auth.userId,
        input.status,
        input.proposal?.proposalType ?? null,
        input.proposal?.sourceMemoryIds ?? null,
        input.proposal?.targetMemoryId ?? null,
        input.proposal?.proposedContent ?? null,
        input.proposal?.rationale ?? null,
        input.proposal?.riskLevel ?? null,
        input.proposal?.confidence ?? null,
        input.proposal?.bucket ?? null,
        input.proposal?.bucketReason ?? null,
        input.proposal?.bucketConfidence ?? null,
        JSON.stringify(input.adversaryJson ?? {}),
        JSON.stringify(input.debateJson ?? {}),
        JSON.stringify(input.judgeJson ?? {}),
        JSON.stringify(input.applyJson ?? {}),
      ]
    );
  }

  async listRuns(auth: AuthContext, limit = 25): Promise<MemoryCleanupRunView[]> {
    const result = await pool.query<CleanupRunRow>(
      `SELECT id, status, run_reason, dry_run, summary_json
       FROM memory_cleanup_runs
       WHERE tenant_id = $1
         AND user_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [auth.tenantId, auth.userId, limit]
    );
    return Promise.all(result.rows.map((row) => this.getRunView(auth, row.id))).then((runs) =>
      runs.filter((run): run is MemoryCleanupRunView => Boolean(run))
    );
  }

  async getRunView(auth: AuthContext, runId: string): Promise<MemoryCleanupRunView | null> {
    const runResult = await pool.query<CleanupRunRow>(
      `SELECT id, status, run_reason, dry_run, summary_json
       FROM memory_cleanup_runs
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3
       LIMIT 1`,
      [runId, auth.tenantId, auth.userId]
    );
    const run = runResult.rows[0];
    if (!run) return null;

    const proposalsResult = await pool.query<CleanupProposalRow>(
      `SELECT id, proposal_type, status, source_memory_ids, target_memory_id, proposed_content, rationale, risk_level, confidence,
              cleanup_bucket, cleanup_bucket_reason, cleanup_bucket_confidence,
              consolidator_json, adversary_json, debate_json, judge_json, apply_json
       FROM memory_cleanup_proposals
       WHERE run_id = $1
         AND tenant_id = $2
         AND user_id = $3
       ORDER BY created_at ASC`,
      [runId, auth.tenantId, auth.userId]
    );

    return {
      id: run.id,
      status: run.status,
      runReason: run.run_reason,
      dryRun: run.dry_run,
      summary: readSummary(run.summary_json),
      proposals: proposalsResult.rows.map(mapProposal),
    };
  }
}
