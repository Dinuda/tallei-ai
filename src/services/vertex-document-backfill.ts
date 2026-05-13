import { config } from "../config/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { getPlanForTenant } from "../infrastructure/auth/tenancy.js";
import { decryptMemoryContent } from "../infrastructure/crypto/memory-crypto.js";
import { pool } from "../infrastructure/db/index.js";
import { VertexDocumentSearchRepository } from "../infrastructure/repositories/document-search.repository.js";
import { createLogger } from "../observability/index.js";
import { runAsyncSafe } from "../shared/async-safe.js";

interface BackfillCandidateRow {
  id: string;
  tenant_id: string;
  user_id: string;
  ref_handle: string;
  title: string | null;
  content_ciphertext: string;
  summary_json: unknown;
  created_at: string;
}

const backfillLogger = createLogger({ baseFields: { component: "vertex_document_backfill_worker" } });
const searchRepository = new VertexDocumentSearchRepository();

const VERTEX_BACKFILL_WORKER_ENABLED = config.vertexDocumentBackfillWorkerEnabled;
const VERTEX_BACKFILL_WORKER_POLL_MS = Math.max(5_000, config.vertexDocumentBackfillWorkerPollMs);
const VERTEX_BACKFILL_WORKER_BATCH_SIZE = Math.max(1, config.vertexDocumentBackfillWorkerBatchSize);
const VERTEX_BACKFILL_MAX_ATTEMPTS = Math.max(1, config.vertexDocumentBackfillMaxAttempts);

let workerRunning = false;
let workerTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

function summaryRecord(summaryJson: unknown): Record<string, unknown> {
  if (!summaryJson || typeof summaryJson !== "object" || Array.isArray(summaryJson)) return {};
  return { ...(summaryJson as Record<string, unknown>) };
}

function summaryAttempts(summaryJson: unknown): number {
  const summary = summaryRecord(summaryJson);
  const raw = summary["vertex_index_attempts"];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function updateVertexIndexMarker(input: {
  tenantId: string;
  userId: string;
  documentId: string;
  summaryJson: unknown;
  attempts: number;
  ok: boolean;
  error?: string;
}): Promise<void> {
  const summary = summaryRecord(input.summaryJson);
  const nextSummary: Record<string, unknown> = {
    ...summary,
    vertex_index_attempts: input.attempts,
    vertex_index_last_attempt_at: nowIso(),
  };
  if (input.ok) {
    nextSummary["vertex_indexed_at"] = nowIso();
    nextSummary["vertex_index_last_error"] = null;
    nextSummary["vertex_index_failed_at"] = null;
  } else {
    nextSummary["vertex_index_last_error"] = (input.error ?? "unknown").slice(0, 320);
    nextSummary["vertex_index_failed_at"] = nowIso();
  }

  await pool.query(
    `UPDATE documents
     SET summary_json = $1::jsonb
     WHERE tenant_id = $2
       AND user_id = $3
       AND id = $4
       AND deleted_at IS NULL`,
    [JSON.stringify(nextSummary), input.tenantId, input.userId, input.documentId]
  );
}

async function loadBackfillCandidates(limit: number): Promise<BackfillCandidateRow[]> {
  const result = await pool.query<BackfillCandidateRow>(
    `SELECT
       id,
       tenant_id,
       user_id,
       ref_handle,
       title,
       content_ciphertext,
       summary_json,
       created_at::text AS created_at
     FROM documents
     WHERE deleted_at IS NULL
       AND status = 'ready'
       AND (summary_json->>'vertex_indexed_at') IS NULL
       AND (
         CASE
           WHEN (summary_json->>'vertex_index_attempts') ~ '^[0-9]+$'
             THEN (summary_json->>'vertex_index_attempts')::int
           ELSE 0
         END
       ) < $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [VERTEX_BACKFILL_MAX_ATTEMPTS, limit]
  );
  return result.rows;
}

async function processCandidate(
  row: BackfillCandidateRow,
  planCache: Map<string, AuthContext["plan"]>
): Promise<"success" | "failed"> {
  const attempts = summaryAttempts(row.summary_json) + 1;
  try {
    let plan = planCache.get(row.tenant_id);
    if (!plan) {
      plan = await getPlanForTenant(row.tenant_id);
      planCache.set(row.tenant_id, plan);
    }
    const auth: AuthContext = {
      userId: row.user_id,
      tenantId: row.tenant_id,
      authMode: "internal",
      plan,
    };
    const content = decryptMemoryContent(row.content_ciphertext);
    await searchRepository.indexDocument({
      auth,
      documentId: row.id,
      ref: row.ref_handle,
      title: row.title,
      content,
      summary: summaryRecord(row.summary_json),
      createdAt: row.created_at,
    });
    await updateVertexIndexMarker({
      tenantId: row.tenant_id,
      userId: row.user_id,
      documentId: row.id,
      summaryJson: row.summary_json,
      attempts,
      ok: true,
    });
    return "success";
  } catch (error) {
    await updateVertexIndexMarker({
      tenantId: row.tenant_id,
      userId: row.user_id,
      documentId: row.id,
      summaryJson: row.summary_json,
      attempts,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

export async function runVertexDocumentBackfillOnce(): Promise<{
  scanned: number;
  success: number;
  failed: number;
}> {
  if (!config.vertexSearchDataStore) {
    return { scanned: 0, success: 0, failed: 0 };
  }
  const startedAt = Date.now();
  const rows = await loadBackfillCandidates(VERTEX_BACKFILL_WORKER_BATCH_SIZE);
  const planCache = new Map<string, AuthContext["plan"]>();
  let success = 0;
  let failed = 0;

  for (const row of rows) {
    const state = await processCandidate(row, planCache);
    if (state === "success") success += 1;
    else failed += 1;
  }

  backfillLogger.info("Vertex document backfill batch completed", {
    event: "vertex_document_backfill_batch",
    scanned: rows.length,
    success,
    failed,
    duration_ms: Date.now() - startedAt,
  });

  return {
    scanned: rows.length,
    success,
    failed,
  };
}

async function pollBackfillQueueOnce(): Promise<void> {
  if (!workerRunning || pollInFlight) return;
  pollInFlight = true;
  try {
    await runVertexDocumentBackfillOnce();
  } finally {
    pollInFlight = false;
  }
}

export function startVertexDocumentBackfillWorker(): void {
  if (!VERTEX_BACKFILL_WORKER_ENABLED) {
    backfillLogger.info("Vertex document backfill worker disabled by config", {
      event: "vertex_document_backfill_worker_disabled",
    });
    return;
  }
  if (!config.vertexDocumentSearchEnabled && !config.vertexDocumentSearchShadowEnabled) {
    backfillLogger.info("Vertex document backfill worker disabled; vertex search flag not enabled", {
      event: "vertex_document_backfill_worker_skipped_flag_off",
    });
    return;
  }
  if (workerRunning) return;
  workerRunning = true;
  workerTimer = setInterval(() => {
    runAsyncSafe(
      () => pollBackfillQueueOnce(),
      "vertex document backfill worker poll"
    );
  }, VERTEX_BACKFILL_WORKER_POLL_MS);
  workerTimer.unref?.();
  runAsyncSafe(() => pollBackfillQueueOnce(), "vertex document backfill worker initial poll");
  backfillLogger.info("Vertex document backfill worker started", {
    event: "vertex_document_backfill_worker_started",
    poll_ms: VERTEX_BACKFILL_WORKER_POLL_MS,
    batch_size: VERTEX_BACKFILL_WORKER_BATCH_SIZE,
    max_attempts: VERTEX_BACKFILL_MAX_ATTEMPTS,
  });
}

export function stopVertexDocumentBackfillWorker(): void {
  workerRunning = false;
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
