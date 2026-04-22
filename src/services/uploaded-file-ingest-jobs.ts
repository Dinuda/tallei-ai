import { randomUUID } from "crypto";

import { config } from "../config/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import { runAsyncSafe } from "../shared/async-safe.js";
import { assertPro } from "./documents.js";
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
}

const UPLOAD_INGEST_WORKER_ENABLED = config.uploadIngestWorkerEnabled;
const UPLOAD_INGEST_WORKER_POLL_MS = Math.max(50, config.uploadIngestWorkerPollMs);
const UPLOAD_INGEST_WORKER_BATCH_SIZE = Math.max(1, config.uploadIngestWorkerBatchSize);
const UPLOAD_INGEST_WORKER_CONCURRENCY = Math.max(1, config.uploadIngestWorkerConcurrency);
let uploadIngestWorkerRunning = false;
let uploadIngestWorkerTimer: ReturnType<typeof setInterval> | null = null;
let uploadIngestPollInFlight = false;

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

  return {
    ref: row.ref,
    status,
    filename: row.filename,
    openai_file_id: row.openai_file_id,
    mime_type: row.mime_type,
    conversation_id: row.conversation_id,
    created_at: row.created_at,
    completed_at: row.completed_at,
    error: row.error,
    document,
  };
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
         completed_at = NOW()
     WHERE tenant_id = $2
       AND user_id = $3
       AND ref = $4`,
    [documentResult.rows[0]?.id ?? null, input.tenantId, input.userId, input.ref]
  );
}

async function setJobFailed(input: {
  tenantId: string;
  userId: string;
  ref: string;
  error: string;
}): Promise<void> {
  await pool.query(
    `UPDATE uploaded_file_ingest_jobs
     SET status = 'failed',
         error = $1,
         completed_at = NOW()
     WHERE tenant_id = $2
       AND user_id = $3
       AND ref = $4`,
    [input.error, input.tenantId, input.userId, input.ref]
  );
}

async function claimNextPendingJob(): Promise<ClaimedUploadIngestJobRow | null> {
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
    await setJobFailed({
      tenantId: job.tenant_id,
      userId: job.user_id,
      ref: job.ref,
      error: message,
    });
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
  console.log(
    `[workers] upload ingest worker started poll_ms=${UPLOAD_INGEST_WORKER_POLL_MS} batch=${UPLOAD_INGEST_WORKER_BATCH_SIZE} concurrency=${UPLOAD_INGEST_WORKER_CONCURRENCY}`
  );
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
  assertPro(auth);

  const filename = fileRef.name?.trim() || `upload-${fileRef.id}`;
  const ref = `ing_${randomUUID().replace(/-/g, "")}`;
  const conversationId = input?.conversation_id?.trim() || null;

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
  assertPro(auth);

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
  const result = await pool.query<UploadIngestJobRow>(
    `SELECT
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
    [auth.tenantId, auth.userId, ref]
  );

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

  const result = await pool.query<UploadIngestJobRow>(
    `SELECT
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
    [auth.tenantId, auth.userId, conversationId, limit]
  );

  return result.rows.map(mapJobRow);
}
