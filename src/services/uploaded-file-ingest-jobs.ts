import { randomUUID } from "crypto";

import { config } from "../config/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { createLogger } from "../observability/index.js";
import { pool } from "../infrastructure/db/index.js";
import { runAsyncSafe } from "../shared/async-safe.js";
import { getPlanForTenant } from "../infrastructure/auth/tenancy.js";
import { ingestUploadedFileToDocument, type UploadedFileRef } from "./uploaded-file-ingest.js";

type UploadedFileIngestJobDbStatus = "pending" | "processing" | "done" | "failed";
export type UploadedFileIngestJobStatus = "pending" | "done" | "failed";

export interface UploadedFileIngestJobPending {
  ref: string;
  status: "pending";
  filename: string;
  conversation_id: string | null;
}

export interface UploadedFileIngestJobError {
  file_id: string;
  filename: string;
  error: string;
}

export interface UploadedFileIngestJobDocument {
  ref: string;
  title: string;
  filename: string | null;
  conversation_id: string | null;
  blob: {
    provider: "uploadthing";
    key: string;
    url: string;
    source_file_id: string;
  } | null;
}

export interface UploadedFileIngestJobState {
  ref: string;
  status: UploadedFileIngestJobStatus;
  filename: string;
  openai_file_id: string;
  mime_type: string | null;
  conversation_id: string | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  created_at: string;
  completed_at: string | null;
  error: string | null;
  document: UploadedFileIngestJobDocument | null;
}

interface UploadIngestJobRow {
  ref: string;
  status: UploadedFileIngestJobDbStatus;
  filename: string;
  openai_file_id: string;
  download_link: string | null;
  mime_type: string | null;
  title: string | null;
  conversation_id: string | null;
  attempt_count?: number;
  max_attempts?: number;
  next_attempt_at?: string | null;
  last_attempt_at?: string | null;
  created_at: string;
  completed_at: string | null;
  error: string | null;
  document_ref: string | null;
  document_title: string | null;
  document_filename: string | null;
  document_conversation_id: string | null;
  blob_provider: string | null;
  blob_key: string | null;
  blob_url: string | null;
  blob_source_file_id: string | null;
}

interface ClaimedUploadIngestJobRow {
  ref: string;
  tenant_id: string;
  user_id: string;
  openai_file_id: string;
  download_link: string | null;
  filename: string;
  mime_type: string | null;
  title: string | null;
  conversation_id: string | null;
  attempt_count?: number;
  max_attempts?: number;
}

const UPLOAD_INGEST_WORKER_ENABLED = config.uploadIngestWorkerEnabled;
const UPLOAD_INGEST_WORKER_POLL_MS = Math.max(50, config.uploadIngestWorkerPollMs);
const UPLOAD_INGEST_WORKER_BATCH_SIZE = Math.max(1, config.uploadIngestWorkerBatchSize);
const UPLOAD_INGEST_WORKER_CONCURRENCY = Math.max(1, config.uploadIngestWorkerConcurrency);
const UPLOAD_INGEST_WORKER_MAX_ATTEMPTS = Math.max(1, config.uploadIngestWorkerMaxAttempts);
const UPLOAD_INGEST_RETRY_BASE_MS = Math.max(250, config.uploadIngestWorkerRetryBaseMs);
const UPLOAD_INGEST_RETRY_MAX_MS = Math.max(UPLOAD_INGEST_RETRY_BASE_MS, config.uploadIngestWorkerRetryMaxMs);
let uploadIngestWorkerRunning = false;
let uploadIngestWorkerTimer: ReturnType<typeof setInterval> | null = null;
let uploadIngestPollInFlight = false;
const uploadIngestLogger = createLogger({ baseFields: { component: "uploaded_file_ingest_jobs" } });
let retryColumnsAvailable: boolean | null = null;
let retryColumnsCheckInFlight: Promise<boolean> | null = null;

export function computeUploadIngestRetryDelayMs(
  attemptCount: number,
  baseMs = UPLOAD_INGEST_RETRY_BASE_MS,
  maxMs = UPLOAD_INGEST_RETRY_MAX_MS
): number {
  const attempt = Math.max(1, attemptCount);
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(maxMs, exponential);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(capped * 0.3)));
  return capped + jitter;
}

export function isRetryableUploadIngestError(message: string): boolean {
  return !/unsupported|not supported|legacy \.doc|empty content|missing download_link/i.test(message);
}

function mapJobRow(row: UploadIngestJobRow): UploadedFileIngestJobState {
  const status: UploadedFileIngestJobStatus = row.status === "processing" ? "pending" : row.status;
  const hasBlob =
    row.blob_provider === "uploadthing"
    && typeof row.blob_key === "string"
    && typeof row.blob_url === "string"
    && typeof row.blob_source_file_id === "string";

  const document = row.document_ref
    ? {
      ref: row.document_ref,
      title: row.document_title ?? row.document_filename ?? row.document_ref,
      filename: row.document_filename,
      conversation_id: row.document_conversation_id,
      blob: hasBlob
        ? {
          provider: "uploadthing" as const,
          key: row.blob_key!,
          url: row.blob_url!,
          source_file_id: row.blob_source_file_id!,
        }
        : null,
    }
    : null;

  const attemptCount = typeof row.attempt_count === "number" ? row.attempt_count : 0;
  const maxAttempts = typeof row.max_attempts === "number" ? row.max_attempts : UPLOAD_INGEST_WORKER_MAX_ATTEMPTS;
  return {
    ref: row.ref,
    status,
    filename: row.filename,
    openai_file_id: row.openai_file_id,
    mime_type: row.mime_type,
    conversation_id: row.conversation_id,
    attempt_count: attemptCount,
    max_attempts: maxAttempts,
    next_attempt_at: row.next_attempt_at ?? null,
    last_attempt_at: row.last_attempt_at ?? null,
    created_at: row.created_at,
    completed_at: row.completed_at,
    error: row.error,
    document,
  };
}

async function hasRetryColumns(): Promise<boolean> {
  if (retryColumnsAvailable !== null) return retryColumnsAvailable;
  if (retryColumnsCheckInFlight) return retryColumnsCheckInFlight;

  retryColumnsCheckInFlight = (async () => {
    try {
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'uploaded_file_ingest_jobs'
           AND column_name IN ('attempt_count', 'max_attempts', 'next_attempt_at', 'last_attempt_at')`
      );
      const count = Number(result.rows[0]?.count ?? "0");
      retryColumnsAvailable = count >= 4;
      return retryColumnsAvailable;
    } catch {
      retryColumnsAvailable = false;
      return false;
    } finally {
      retryColumnsCheckInFlight = null;
    }
  })();

  return retryColumnsCheckInFlight;
}

async function setJobDone(input: {
  tenantId: string;
  userId: string;
  ref: string;
  documentRef: string;
}): Promise<void> {
  const documentResult = await pool.query<{ id: string }>(
    `SELECT id
     FROM documents
     WHERE tenant_id = $1
       AND user_id = $2
       AND ref_handle = $3
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.tenantId, input.userId, input.documentRef]
  );

  await pool.query(
    `UPDATE uploaded_file_ingest_jobs
     SET status = 'done',
         document_id = $1,
         error = NULL,
         next_attempt_at = NOW(),
         completed_at = NOW()
     WHERE tenant_id = $2
       AND user_id = $3
       AND ref = $4`,
    [documentResult.rows[0]?.id ?? null, input.tenantId, input.userId, input.ref]
  );
}

async function setJobRetryOrFailed(input: {
  tenantId: string;
  userId: string;
  ref: string;
  error: string;
  attemptCount: number;
  maxAttempts: number;
}): Promise<void> {
  const retryable = isRetryableUploadIngestError(input.error);
  const shouldRetry = retryable && input.attemptCount < input.maxAttempts;
  const nextAttemptDelayMs = shouldRetry
    ? computeUploadIngestRetryDelayMs(input.attemptCount)
    : 0;
  await pool.query(
    `UPDATE uploaded_file_ingest_jobs
     SET status = $1,
         error = $2,
         next_attempt_at = CASE
           WHEN $3::boolean THEN NOW() + ($4::text)::interval
           ELSE NOW()
         END,
         completed_at = CASE
           WHEN $3::boolean THEN NULL
           ELSE NOW()
         END
     WHERE tenant_id = $5
       AND user_id = $6
       AND ref = $7`,
    [
      shouldRetry ? "pending" : "failed",
      input.error,
      shouldRetry,
      `${Math.max(0, nextAttemptDelayMs)} milliseconds`,
      input.tenantId,
      input.userId,
      input.ref,
    ]
  );

  uploadIngestLogger.info("Upload ingest job attempt completed", {
    event: "upload_ingest_job_attempt",
    tenant_id: input.tenantId,
    user_id: input.userId,
    ref: input.ref,
    status: shouldRetry ? "retry_scheduled" : "failed_terminal",
    attempt_count: input.attemptCount,
    max_attempts: input.maxAttempts,
    retryable,
    next_retry_in_ms: shouldRetry ? nextAttemptDelayMs : 0,
    error: input.error.slice(0, 240),
  });
}

async function claimNextPendingJob(): Promise<ClaimedUploadIngestJobRow | null> {
  if (await hasRetryColumns()) {
    const result = await pool.query<ClaimedUploadIngestJobRow>(
      `WITH next_job AS (
         SELECT ref
         FROM uploaded_file_ingest_jobs
         WHERE status = 'pending'
           AND next_attempt_at <= NOW()
           AND attempt_count < max_attempts
         ORDER BY next_attempt_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE uploaded_file_ingest_jobs j
       SET status = 'processing',
           error = NULL,
           last_attempt_at = NOW(),
           attempt_count = j.attempt_count + 1
       FROM next_job
       WHERE j.ref = next_job.ref
       RETURNING
         j.ref,
         j.tenant_id,
         j.user_id,
         j.openai_file_id,
         j.download_link,
         j.filename,
         j.mime_type,
         j.title,
         j.conversation_id,
         j.attempt_count,
         j.max_attempts`
    );
    return result.rows[0] ?? null;
  }

  const result = await pool.query<ClaimedUploadIngestJobRow>(
    `WITH next_job AS (
       SELECT ref
       FROM uploaded_file_ingest_jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE uploaded_file_ingest_jobs j
     SET status = 'processing',
         error = NULL
     FROM next_job
     WHERE j.ref = next_job.ref
     RETURNING
       j.ref,
       j.tenant_id,
       j.user_id,
       j.openai_file_id,
       j.download_link,
       j.filename,
       j.mime_type,
       j.title,
       j.conversation_id`
  );
  return result.rows[0] ?? null;
}

async function processClaimedJob(job: ClaimedUploadIngestJobRow): Promise<void> {
  try {
    if (!job.download_link) {
      throw new Error("Missing download_link for uploaded file ingest job");
    }
    const plan = await getPlanForTenant(job.tenant_id);
    const auth: AuthContext = {
      userId: job.user_id,
      tenantId: job.tenant_id,
      authMode: "internal",
      plan,
    };
    const fileRef: UploadedFileRef = {
      id: job.openai_file_id,
      name: job.filename,
      mime_type: job.mime_type,
      download_link: job.download_link,
    };
    const saved = await ingestUploadedFileToDocument(fileRef, auth, {
      title: job.title ?? undefined,
      conversation_id: job.conversation_id ?? null,
    });
    await setJobDone({
      tenantId: job.tenant_id,
      userId: job.user_id,
      ref: job.ref,
      documentRef: saved.ref,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const supportsRetries = await hasRetryColumns();
    if (supportsRetries) {
      await setJobRetryOrFailed({
        tenantId: job.tenant_id,
        userId: job.user_id,
        ref: job.ref,
        error: message,
        attemptCount: typeof job.attempt_count === "number" ? job.attempt_count : 1,
        maxAttempts: typeof job.max_attempts === "number" ? job.max_attempts : UPLOAD_INGEST_WORKER_MAX_ATTEMPTS,
      });
    } else {
      await pool.query(
        `UPDATE uploaded_file_ingest_jobs
         SET status = 'failed',
             error = $1,
             completed_at = NOW()
         WHERE tenant_id = $2
           AND user_id = $3
           AND ref = $4`,
        [message, job.tenant_id, job.user_id, job.ref]
      );
    }
  }
}

async function pollUploadIngestQueueOnce(): Promise<void> {
  if (!uploadIngestWorkerRunning || uploadIngestPollInFlight) return;
  uploadIngestPollInFlight = true;
  try {
    await Promise.all(
      Array.from({ length: UPLOAD_INGEST_WORKER_CONCURRENCY }, async () => {
        for (let i = 0; i < UPLOAD_INGEST_WORKER_BATCH_SIZE; i += 1) {
          const job = await claimNextPendingJob();
          if (!job) break;
          await processClaimedJob(job);
        }
      })
    );
  } finally {
    uploadIngestPollInFlight = false;
  }
}

export function startUploadedFileIngestWorker(): void {
  if (!UPLOAD_INGEST_WORKER_ENABLED) {
    console.log("[workers] upload ingest worker disabled by config");
    return;
  }
  if (uploadIngestWorkerRunning) return;
  uploadIngestWorkerRunning = true;
  uploadIngestWorkerTimer = setInterval(() => {
    runAsyncSafe(
      () => pollUploadIngestQueueOnce(),
      "upload ingest worker poll"
    );
  }, UPLOAD_INGEST_WORKER_POLL_MS);
  uploadIngestWorkerTimer.unref?.();
  runAsyncSafe(() => pollUploadIngestQueueOnce(), "upload ingest worker initial poll");
  uploadIngestLogger.info("Upload ingest worker started", {
    event: "upload_ingest_worker_started",
    poll_ms: UPLOAD_INGEST_WORKER_POLL_MS,
    batch_size: UPLOAD_INGEST_WORKER_BATCH_SIZE,
    concurrency: UPLOAD_INGEST_WORKER_CONCURRENCY,
    max_attempts: UPLOAD_INGEST_WORKER_MAX_ATTEMPTS,
    retry_base_ms: UPLOAD_INGEST_RETRY_BASE_MS,
    retry_max_ms: UPLOAD_INGEST_RETRY_MAX_MS,
  });
}

export function stopUploadedFileIngestWorker(): void {
  uploadIngestWorkerRunning = false;
  if (uploadIngestWorkerTimer) {
    clearInterval(uploadIngestWorkerTimer);
    uploadIngestWorkerTimer = null;
  }
}

export async function enqueueUploadedFileIngest(
  fileRef: UploadedFileRef,
  auth: AuthContext,
  input?: {
    title?: string;
    conversation_id?: string | null;
  }
): Promise<UploadedFileIngestJobPending> {
  const filename = fileRef.name?.trim() || `upload-${fileRef.id}`;
  const ref = `ing_${randomUUID().replace(/-/g, "")}`;
  const conversationId = input?.conversation_id?.trim() || null;

  if (await hasRetryColumns()) {
    await pool.query(
      `INSERT INTO uploaded_file_ingest_jobs
       (ref, tenant_id, user_id, openai_file_id, download_link, filename, title, mime_type, status, conversation_id, attempt_count, max_attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, 0, $10, NOW())`,
      [
        ref,
        auth.tenantId,
        auth.userId,
        fileRef.id,
        fileRef.download_link,
        filename,
        input?.title ?? null,
        fileRef.mime_type ?? null,
        conversationId,
        UPLOAD_INGEST_WORKER_MAX_ATTEMPTS,
      ]
    );
  } else {
    await pool.query(
      `INSERT INTO uploaded_file_ingest_jobs
       (ref, tenant_id, user_id, openai_file_id, download_link, filename, title, mime_type, status, conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
      [
        ref,
        auth.tenantId,
        auth.userId,
        fileRef.id,
        fileRef.download_link,
        filename,
        input?.title ?? null,
        fileRef.mime_type ?? null,
        conversationId,
      ]
    );
  }
  runAsyncSafe(() => pollUploadIngestQueueOnce(), "upload ingest worker nudge");

  return {
    ref,
    status: "pending",
    filename,
    conversation_id: conversationId,
  };
}

export async function enqueueUploadedFilesIngest(
  fileRefs: UploadedFileRef[],
  auth: AuthContext,
  input?: {
    title?: string;
    conversation_id?: string | null;
  }
): Promise<{
  enqueued: UploadedFileIngestJobPending[];
  errors: UploadedFileIngestJobError[];
}> {
  const enqueued: UploadedFileIngestJobPending[] = [];
  const errors: UploadedFileIngestJobError[] = [];

  for (const fileRef of fileRefs) {
    try {
      const pending = await enqueueUploadedFileIngest(fileRef, auth, input);
      enqueued.push(pending);
    } catch (error) {
      errors.push({
        file_id: fileRef.id,
        filename: fileRef.name ?? fileRef.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { enqueued, errors };
}

export async function getUploadedFileIngestJobStatus(
  auth: AuthContext,
  ref: string
): Promise<UploadedFileIngestJobState | null> {
  const supportsRetries = await hasRetryColumns();
  const result = await pool.query<UploadIngestJobRow>(supportsRetries
    ? `SELECT
         j.ref,
         j.status,
         j.filename,
         j.openai_file_id,
         j.download_link,
         j.mime_type,
         j.conversation_id,
         j.attempt_count,
         j.max_attempts,
         j.next_attempt_at::text AS next_attempt_at,
         j.last_attempt_at::text AS last_attempt_at,
         j.created_at::text AS created_at,
         j.completed_at::text AS completed_at,
         j.error,
         d.ref_handle AS document_ref,
         d.title AS document_title,
         d.filename AS document_filename,
         d.conversation_id AS document_conversation_id,
         d.blob_provider,
         d.blob_key,
         d.blob_url,
         d.blob_source_file_id
       FROM uploaded_file_ingest_jobs j
       LEFT JOIN documents d
         ON d.id = j.document_id
         AND d.deleted_at IS NULL
       WHERE j.tenant_id = $1
         AND j.user_id = $2
         AND j.ref = $3
       LIMIT 1`
    : `SELECT
         j.ref,
         j.status,
         j.filename,
         j.openai_file_id,
         j.download_link,
         j.mime_type,
         j.conversation_id,
         j.created_at::text AS created_at,
         j.completed_at::text AS completed_at,
         j.error,
         d.ref_handle AS document_ref,
         d.title AS document_title,
         d.filename AS document_filename,
         d.conversation_id AS document_conversation_id,
         d.blob_provider,
         d.blob_key,
         d.blob_url,
         d.blob_source_file_id
       FROM uploaded_file_ingest_jobs j
       LEFT JOIN documents d
         ON d.id = j.document_id
         AND d.deleted_at IS NULL
       WHERE j.tenant_id = $1
         AND j.user_id = $2
         AND j.ref = $3
       LIMIT 1`,
  [auth.tenantId, auth.userId, ref]);

  const row = result.rows[0];
  if (!row) return null;
  return mapJobRow(row);
}

export async function listRecentCompletedUploadedFileIngestJobs(
  auth: AuthContext,
  input?: {
    conversation_id?: string | null;
    limit?: number;
  }
): Promise<UploadedFileIngestJobState[]> {
  const limit = Math.max(1, Math.min(input?.limit ?? 5, 20));
  const conversationId = input?.conversation_id?.trim() || null;

  const supportsRetries = await hasRetryColumns();
  const result = await pool.query<UploadIngestJobRow>(supportsRetries
    ? `SELECT
         j.ref,
         j.status,
         j.filename,
         j.openai_file_id,
         j.download_link,
         j.mime_type,
         j.conversation_id,
         j.attempt_count,
         j.max_attempts,
         j.next_attempt_at::text AS next_attempt_at,
         j.last_attempt_at::text AS last_attempt_at,
         j.created_at::text AS created_at,
         j.completed_at::text AS completed_at,
         j.error,
         d.ref_handle AS document_ref,
         d.title AS document_title,
         d.filename AS document_filename,
         d.conversation_id AS document_conversation_id,
         d.blob_provider,
         d.blob_key,
         d.blob_url,
         d.blob_source_file_id
       FROM uploaded_file_ingest_jobs j
       LEFT JOIN documents d
         ON d.id = j.document_id
         AND d.deleted_at IS NULL
       WHERE j.tenant_id = $1
         AND j.user_id = $2
         AND j.status = 'done'
         AND ($3::text IS NULL OR j.conversation_id = $3::text)
       ORDER BY j.completed_at DESC
       LIMIT $4`
    : `SELECT
         j.ref,
         j.status,
         j.filename,
         j.openai_file_id,
         j.download_link,
         j.mime_type,
         j.conversation_id,
         j.created_at::text AS created_at,
         j.completed_at::text AS completed_at,
         j.error,
         d.ref_handle AS document_ref,
         d.title AS document_title,
         d.filename AS document_filename,
         d.conversation_id AS document_conversation_id,
         d.blob_provider,
         d.blob_key,
         d.blob_url,
         d.blob_source_file_id
       FROM uploaded_file_ingest_jobs j
       LEFT JOIN documents d
         ON d.id = j.document_id
         AND d.deleted_at IS NULL
       WHERE j.tenant_id = $1
         AND j.user_id = $2
         AND j.status = 'done'
         AND ($3::text IS NULL OR j.conversation_id = $3::text)
       ORDER BY j.completed_at DESC
       LIMIT $4`,
  [auth.tenantId, auth.userId, conversationId, limit]);

  return result.rows.map(mapJobRow);
}
