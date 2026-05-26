import { randomUUID } from "crypto";

import { config } from "../config/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import { getPlanForTenant } from "../infrastructure/auth/tenancy.js";
import { createLogger } from "../observability/index.js";
import type { ChatGptImportRequest, ChatGptImportResult } from "../orchestration/memory/chatgpt-import.usecase.js";
import { runAsyncSafe } from "../shared/async-safe.js";
import { deleteImportArtifact, sweepOrphanedImportArtifacts } from "./chatgpt-import-storage.js";
import { importChatGptMemories, persistChatGptImportPreview } from "./memory.js";

type ChatGptImportJobDbStatus = "pending" | "processing" | "done" | "failed";
export type ChatGptImportJobStatus = "pending" | "processing" | "done" | "failed";

export interface ChatGptImportJobProgress {
  stage:
    | "queued"
    | "ingesting"
    | "filtering"
    | "aggregating"
    | "extracting"
    | "promoting"
    | "persisting"
    | "processing"
    | "complete"
    | "failed";
  message?: string;
  summary?: {
    parsed: number;
    selected: number;
    skipped: number;
    hardDropped: number;
    keepHigh: number;
    keepWeak: number;
    dropped: number;
    extracted: number;
    accepted: number;
    duplicates: number;
    conflicts: number;
    invalid: number;
    persisted: number;
    embedded: number;
  };
}

export interface ChatGptImportJobState {
  ref: string;
  status: ChatGptImportJobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  created_at: string;
  completed_at: string | null;
  progress: ChatGptImportJobProgress;
  result: ChatGptImportResult | null;
  error: { message: string } | null;
}

interface ChatGptImportJobRow {
  ref: string;
  status: ChatGptImportJobDbStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  created_at: string;
  completed_at: string | null;
  progress_json: unknown;
  result_json: unknown;
  error_json: unknown;
}

interface ClaimedChatGptImportJobRow {
  ref: string;
  tenant_id: string;
  user_id: string;
  request_json: unknown;
  storage_ref: string | null;
  attempt_count: number;
  max_attempts: number;
}

const CHATGPT_IMPORT_WORKER_ENABLED = config.chatGptImportWorkerEnabled;
const CHATGPT_IMPORT_WORKER_POLL_MS = Math.max(50, config.chatGptImportWorkerPollMs);
const CHATGPT_IMPORT_WORKER_BATCH_SIZE = Math.max(1, config.chatGptImportWorkerBatchSize);
const CHATGPT_IMPORT_WORKER_CONCURRENCY = Math.max(1, config.chatGptImportWorkerConcurrency);
const CHATGPT_IMPORT_WORKER_MAX_ATTEMPTS = Math.max(1, config.chatGptImportWorkerMaxAttempts);
const CHATGPT_IMPORT_RETRY_BASE_MS = Math.max(250, config.chatGptImportWorkerRetryBaseMs);
const CHATGPT_IMPORT_RETRY_MAX_MS = Math.max(CHATGPT_IMPORT_RETRY_BASE_MS, config.chatGptImportWorkerRetryMaxMs);

let importWorkerRunning = false;
let importWorkerTimer: ReturnType<typeof setInterval> | null = null;
let importPollInFlight = false;

const logger = createLogger({ baseFields: { component: "chatgpt_import_jobs" } });

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mapJobRow(row: ChatGptImportJobRow): ChatGptImportJobState {
  const progress: ChatGptImportJobProgress = (() => {
    const record = asRecord(row.progress_json);
    if (!record) return { stage: "queued" } as ChatGptImportJobProgress;
    const stage = record["stage"];
    const message = typeof record["message"] === "string" ? record["message"] : undefined;
    const summaryRecord = asRecord(record["summary"]);
    const isKnownStage = stage === "queued"
      || stage === "ingesting"
      || stage === "filtering"
      || stage === "aggregating"
      || stage === "extracting"
      || stage === "promoting"
      || stage === "persisting"
      || stage === "processing"
      || stage === "complete"
      || stage === "failed";
    if (
      isKnownStage
      && summaryRecord
    ) {
      return {
        stage: stage as ChatGptImportJobProgress["stage"],
        message,
        summary: {
          parsed: Number(summaryRecord["parsed"] ?? 0),
          selected: Number(summaryRecord["selected"] ?? 0),
          skipped: Number(summaryRecord["skipped"] ?? 0),
          hardDropped: Number(summaryRecord["hardDropped"] ?? 0),
          keepHigh: Number(summaryRecord["keepHigh"] ?? 0),
          keepWeak: Number(summaryRecord["keepWeak"] ?? 0),
          dropped: Number(summaryRecord["dropped"] ?? 0),
          extracted: Number(summaryRecord["extracted"] ?? 0),
          accepted: Number(summaryRecord["accepted"] ?? 0),
          duplicates: Number(summaryRecord["duplicates"] ?? 0),
          conflicts: Number(summaryRecord["conflicts"] ?? 0),
          invalid: Number(summaryRecord["invalid"] ?? 0),
          persisted: Number(summaryRecord["persisted"] ?? 0),
          embedded: Number(summaryRecord["embedded"] ?? 0),
        },
      };
    }
    if (isKnownStage) {
      return {
        stage: stage as ChatGptImportJobProgress["stage"],
        message,
      };
    }
    return { stage: "queued" } as ChatGptImportJobProgress;
  })();

  const result = (() => {
    const record = asRecord(row.result_json);
    if (!record) return null;
    return record as unknown as ChatGptImportResult;
  })();

  const error = (() => {
    const record = asRecord(row.error_json);
    if (!record) return null;
    const message = typeof record["message"] === "string"
      ? record["message"]
      : "Import failed";
    return { message };
  })();

  return {
    ref: row.ref,
    status: row.status,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at,
    last_attempt_at: row.last_attempt_at,
    created_at: row.created_at,
    completed_at: row.completed_at,
    progress,
    result,
    error,
  };
}

export function computeChatGptImportRetryDelayMs(
  attemptCount: number,
  baseMs = CHATGPT_IMPORT_RETRY_BASE_MS,
  maxMs = CHATGPT_IMPORT_RETRY_MAX_MS
): number {
  const attempt = Math.max(1, attemptCount);
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(maxMs, exponential);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(capped * 0.3)));
  return capped + jitter;
}

export function isRetryableChatGptImportError(message: string): boolean {
  return !/validation failed|input is required|unsupported file|no importable|invalid json|zod|unprocessable entity/i.test(message);
}

async function claimNextPendingJob(): Promise<ClaimedChatGptImportJobRow | null> {
  const result = await pool.query<ClaimedChatGptImportJobRow>(
    `WITH next_job AS (
       SELECT ref
       FROM chatgpt_import_jobs
       WHERE status = 'pending'
         AND next_attempt_at <= NOW()
         AND attempt_count < max_attempts
       ORDER BY next_attempt_at ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE chatgpt_import_jobs j
     SET status = 'processing',
         error_json = NULL,
         progress_json = jsonb_build_object('stage', 'processing'),
         last_attempt_at = NOW(),
         attempt_count = j.attempt_count + 1,
         updated_at = NOW()
     FROM next_job
     WHERE j.ref = next_job.ref
     RETURNING
       j.ref,
       j.tenant_id,
       j.user_id,
       j.request_json,
       j.storage_ref,
       j.attempt_count,
       j.max_attempts`
  );
  return result.rows[0] ?? null;
}

async function cleanupJobStorage(job: ClaimedChatGptImportJobRow): Promise<void> {
  const requestRecord = asRecord(job.request_json);
  const mode = requestRecord?.["mode"];
  if (mode === "conversation_json_files") {
    const refs = requestRecord?.["storageRefs"];
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (typeof ref === "string") {
          await deleteImportArtifact(ref);
        }
      }
    }
    return;
  }
  await deleteImportArtifact(job.storage_ref);
}

async function setJobDone(
  job: ClaimedChatGptImportJobRow,
  result: ChatGptImportResult
): Promise<void> {
  await pool.query(
    `UPDATE chatgpt_import_jobs
     SET status = 'done',
         result_json = $1::jsonb,
         progress_json = $2::jsonb,
         error_json = NULL,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE ref = $3
       AND tenant_id = $4
       AND user_id = $5`,
    [
      JSON.stringify(result),
      JSON.stringify({
        stage: "complete",
        summary: result.summary,
      }),
      job.ref,
      job.tenant_id,
      job.user_id,
    ]
  );
  const requestRecord = asRecord(job.request_json);
  if (requestRecord?.["mode"] !== "conversation_json_files") {
    await cleanupJobStorage(job);
  }
}

async function setJobRetryOrFailed(
  job: ClaimedChatGptImportJobRow,
  errorMessage: string
): Promise<void> {
  const retryable = isRetryableChatGptImportError(errorMessage);
  const shouldRetry = retryable && job.attempt_count < job.max_attempts;
  const nextAttemptDelayMs = shouldRetry ? computeChatGptImportRetryDelayMs(job.attempt_count) : 0;

  await pool.query(
    `UPDATE chatgpt_import_jobs
     SET status = $1,
         error_json = $2::jsonb,
         progress_json = $3::jsonb,
         next_attempt_at = CASE
           WHEN $4::boolean THEN NOW() + ($5::text)::interval
           ELSE NOW()
         END,
         completed_at = CASE
           WHEN $4::boolean THEN NULL
           ELSE NOW()
         END,
         updated_at = NOW()
     WHERE ref = $6
       AND tenant_id = $7
       AND user_id = $8`,
    [
      shouldRetry ? "pending" : "failed",
      JSON.stringify({ message: errorMessage }),
      JSON.stringify({
        stage: shouldRetry ? "queued" : "failed",
        message: errorMessage,
      }),
      shouldRetry,
      `${Math.max(0, nextAttemptDelayMs)} milliseconds`,
      job.ref,
      job.tenant_id,
      job.user_id,
    ]
  );

  logger.info("ChatGPT import job attempt completed", {
    event: "chatgpt_import_job_attempt",
    tenant_id: job.tenant_id,
    user_id: job.user_id,
    ref: job.ref,
    status: shouldRetry ? "retry_scheduled" : "failed_terminal",
    attempt_count: job.attempt_count,
    max_attempts: job.max_attempts,
    retryable,
    next_retry_in_ms: shouldRetry ? nextAttemptDelayMs : 0,
    error: errorMessage.slice(0, 240),
  });

  if (!shouldRetry) {
    await cleanupJobStorage(job);
  }
}

async function processClaimedJob(job: ClaimedChatGptImportJobRow): Promise<void> {
  const requestRecord = asRecord(job.request_json);
  if (!requestRecord) {
    await setJobRetryOrFailed(job, "Malformed request payload for ChatGPT import job");
    return;
  }

  const mode = requestRecord["mode"];
  const isBulkFile = mode === "bulk_file" && typeof requestRecord["storageRef"] === "string";
  const isConversationJsonFiles = mode === "conversation_json_files"
    && Array.isArray(requestRecord["storageRefs"])
    && requestRecord["storageRefs"].length > 0;
  if (!isBulkFile && !isConversationJsonFiles && typeof requestRecord["input"] !== "string") {
    await setJobRetryOrFailed(job, "Malformed request payload for ChatGPT import job");
    return;
  }

  const request = requestRecord as unknown as ChatGptImportRequest;
  const plan = await getPlanForTenant(job.tenant_id);
  const auth: AuthContext = {
    tenantId: job.tenant_id,
    userId: job.user_id,
    authMode: "internal",
    plan,
  };

  try {
    const result = await importChatGptMemories(auth, {
      ...request,
      onProgress: async (progress) => {
        await pool.query(
          `UPDATE chatgpt_import_jobs
           SET progress_json = $1::jsonb,
               updated_at = NOW()
           WHERE ref = $2
             AND tenant_id = $3
             AND user_id = $4`,
          [
            JSON.stringify({
              stage: progress.stage,
              message: progress.message,
            }),
            job.ref,
            job.tenant_id,
            job.user_id,
          ]
        );
      },
    });
    await setJobDone(job, result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await setJobRetryOrFailed(job, errorMessage);
  }
}

export async function pollChatGptImportQueueOnce(): Promise<void> {
  if (!importWorkerRunning) return;
  if (importPollInFlight) return;
  importPollInFlight = true;
  try {
    await Promise.all(Array.from({ length: CHATGPT_IMPORT_WORKER_CONCURRENCY }, async () => {
      for (let i = 0; i < CHATGPT_IMPORT_WORKER_BATCH_SIZE; i += 1) {
        const claimed = await claimNextPendingJob();
        if (!claimed) break;
        await processClaimedJob(claimed);
      }
    }));
  } finally {
    importPollInFlight = false;
  }
}

export function startChatGptImportWorker(): void {
  if (!CHATGPT_IMPORT_WORKER_ENABLED) {
    console.log("[workers] chatgpt import worker disabled by config");
    return;
  }
  if (importWorkerRunning) return;
  importWorkerRunning = true;
  importWorkerTimer = setInterval(() => {
    runAsyncSafe(
      () => pollChatGptImportQueueOnce(),
      "chatgpt import worker poll"
    );
  }, CHATGPT_IMPORT_WORKER_POLL_MS);
  importWorkerTimer.unref?.();
  runAsyncSafe(() => pollChatGptImportQueueOnce(), "chatgpt import worker initial poll");
  runAsyncSafe(async () => {
    await sweepOrphanedImportArtifacts();
  }, "chatgpt import storage sweep");
  logger.info("ChatGPT import worker started", {
    event: "chatgpt_import_worker_started",
    poll_ms: CHATGPT_IMPORT_WORKER_POLL_MS,
    batch_size: CHATGPT_IMPORT_WORKER_BATCH_SIZE,
    concurrency: CHATGPT_IMPORT_WORKER_CONCURRENCY,
    max_attempts: CHATGPT_IMPORT_WORKER_MAX_ATTEMPTS,
    retry_base_ms: CHATGPT_IMPORT_RETRY_BASE_MS,
    retry_max_ms: CHATGPT_IMPORT_RETRY_MAX_MS,
  });
}

export function stopChatGptImportWorker(): void {
  importWorkerRunning = false;
  if (importWorkerTimer) {
    clearInterval(importWorkerTimer);
    importWorkerTimer = null;
  }
}

export async function enqueueChatGptImportJob(
  auth: AuthContext,
  request: ChatGptImportRequest
): Promise<{ ref: string; status: "pending" }> {
  const ref = `cimp_${randomUUID().replace(/-/g, "")}`;
  const isConversationJsonFiles = request.mode === "conversation_json_files"
    && request.storageRefs
    && request.storageRefs.length > 0;
  const storageRef = request.mode === "bulk_file"
    ? request.storageRef ?? null
    : isConversationJsonFiles
      ? request.storageRefs![0] ?? null
      : null;
  const originalFilename = request.mode === "bulk_file"
    ? request.originalFilename ?? null
    : isConversationJsonFiles
      ? request.originalFilenames?.join(", ") ?? null
      : null;
  const requestPayload = request.mode === "bulk_file"
    ? {
        mode: "bulk_file",
        storageRef: request.storageRef,
        originalFilename: request.originalFilename,
        input: request.input ?? "",
        apply: request.apply === true,
      }
    : isConversationJsonFiles
      ? {
          mode: "conversation_json_files",
          storageRefs: request.storageRefs,
          originalFilenames: request.originalFilenames,
          importProfile: request.importProfile ?? "inclusive",
          input: request.input ?? "",
          apply: request.apply === true,
        }
      : request;

  await pool.query(
    `INSERT INTO chatgpt_import_jobs
     (ref, tenant_id, user_id, status, request_json, storage_ref, original_filename, progress_json, attempt_count, max_attempts, next_attempt_at)
     VALUES ($1, $2, $3, 'pending', $4::jsonb, $5, $6, $7::jsonb, 0, $8, NOW())`,
    [
      ref,
      auth.tenantId,
      auth.userId,
      JSON.stringify(requestPayload),
      storageRef,
      originalFilename,
      JSON.stringify({ stage: "queued" }),
      CHATGPT_IMPORT_WORKER_MAX_ATTEMPTS,
    ]
  );
  runAsyncSafe(() => pollChatGptImportQueueOnce(), "chatgpt import worker nudge");
  return { ref, status: "pending" };
}

export async function getChatGptImportJobStatus(
  auth: AuthContext,
  ref: string
): Promise<ChatGptImportJobState | null> {
  const result = await pool.query<ChatGptImportJobRow>(
    `SELECT
       ref,
       status,
       attempt_count,
       max_attempts,
       next_attempt_at::text AS next_attempt_at,
       last_attempt_at::text AS last_attempt_at,
       created_at::text AS created_at,
       completed_at::text AS completed_at,
       progress_json,
       result_json,
       error_json
     FROM chatgpt_import_jobs
     WHERE tenant_id = $1
       AND user_id = $2
       AND ref = $3
     LIMIT 1`,
    [auth.tenantId, auth.userId, ref]
  );

  const row = result.rows[0];
  if (!row) return null;
  return mapJobRow(row);
}

interface ChatGptImportJobPersistRow {
  ref: string;
  status: ChatGptImportJobDbStatus;
  request_json: unknown;
  result_json: unknown;
  storage_ref: string | null;
  tenant_id: string;
  user_id: string;
}

export async function persistChatGptImportJob(
  auth: AuthContext,
  ref: string
): Promise<{ persisted: number; duplicates: number; conflicts: number }> {
  const result = await pool.query<ChatGptImportJobPersistRow>(
    `SELECT ref, status, request_json, result_json, storage_ref, tenant_id, user_id
     FROM chatgpt_import_jobs
     WHERE tenant_id = $1
       AND user_id = $2
       AND ref = $3
     LIMIT 1`,
    [auth.tenantId, auth.userId, ref]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Import job not found");
  }
  if (row.status !== "done") {
    throw new Error("Import job must be complete before persisting preview");
  }

  const importResult = (() => {
    const record = asRecord(row.result_json);
    if (!record) return null;
    return record as unknown as ChatGptImportResult;
  })();
  if (!importResult || importResult.preview.length === 0) {
    throw new Error("Import preview is empty");
  }
  if (importResult.summary.accepted <= 0) {
    throw new Error("No accepted preview items to persist");
  }

  const persistResult = await persistChatGptImportPreview(auth, {
    preview: importResult.preview,
    batchId: importResult.batchId,
    mode: importResult.mode,
    importSource: importResult.importSource
      ?? (importResult.mode === "claude_export" ? "claude" : "chatgpt"),
    onProgress: async (progress) => {
      await pool.query(
        `UPDATE chatgpt_import_jobs
         SET progress_json = $1::jsonb,
             updated_at = NOW()
         WHERE ref = $2
           AND tenant_id = $3
           AND user_id = $4`,
        [
          JSON.stringify({
            stage: progress.stage,
            message: progress.message,
            summary: importResult.summary,
          }),
          ref,
          auth.tenantId,
          auth.userId,
        ]
      );
    },
  });

  const updatedResult: ChatGptImportResult = {
    ...importResult,
    summary: {
      ...importResult.summary,
      persisted: persistResult.persisted,
      embedded: persistResult.persisted,
      duplicates: importResult.summary.duplicates + persistResult.duplicates,
    },
    duplicates: [...importResult.duplicates, ...persistResult.duplicateRows],
    preview: [],
  };

  await pool.query(
    `UPDATE chatgpt_import_jobs
     SET result_json = $1::jsonb,
         progress_json = $2::jsonb,
         updated_at = NOW()
     WHERE ref = $3
       AND tenant_id = $4
       AND user_id = $5`,
    [
      JSON.stringify(updatedResult),
      JSON.stringify({
        stage: "complete",
        summary: updatedResult.summary,
        message: `Persisted ${persistResult.persisted} memory(ies)`,
      }),
      ref,
      auth.tenantId,
      auth.userId,
    ]
  );

  await cleanupJobStorage({
    ref: row.ref,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    request_json: row.request_json,
    storage_ref: row.storage_ref,
    attempt_count: 0,
    max_attempts: 0,
  });

  return {
    persisted: persistResult.persisted,
    duplicates: persistResult.duplicates,
    conflicts: importResult.summary.conflicts,
  };
}
