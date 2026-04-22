import { randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import { runAsyncSafe } from "../shared/async-safe.js";
import { assertPro } from "./documents.js";
import { ingestUploadedFileToDocument, type UploadedFileRef } from "./uploaded-file-ingest.js";

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
  status: UploadedFileIngestJobStatus;
  filename: string;
  openai_file_id: string;
  mime_type: string | null;
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

function mapJobRow(row: UploadIngestJobRow): UploadedFileIngestJobState {
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
    status: row.status,
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
  auth: AuthContext;
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
    [input.auth.tenantId, input.auth.userId, input.documentRef]
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
    [documentResult.rows[0]?.id ?? null, input.auth.tenantId, input.auth.userId, input.ref]
  );
}

async function setJobFailed(input: {
  auth: AuthContext;
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
    [input.error, input.auth.tenantId, input.auth.userId, input.ref]
  );
}

function ingestUploadedFileInBackground(input: {
  auth: AuthContext;
  fileRef: UploadedFileRef;
  title?: string;
  conversation_id?: string | null;
  jobRef: string;
}): void {
  setImmediate(() => {
    runAsyncSafe(async () => {
      try {
        const saved = await ingestUploadedFileToDocument(input.fileRef, input.auth, {
          title: input.title,
          conversation_id: input.conversation_id ?? null,
        });
        await setJobDone({
          auth: input.auth,
          ref: input.jobRef,
          documentRef: saved.ref,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await setJobFailed({
          auth: input.auth,
          ref: input.jobRef,
          error: message,
        });
      }
    }, "uploaded file ingest job");
  });
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
     (ref, tenant_id, user_id, openai_file_id, filename, mime_type, status, conversation_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [ref, auth.tenantId, auth.userId, fileRef.id, filename, fileRef.mime_type ?? null, conversationId]
  );

  ingestUploadedFileInBackground({
    auth,
    fileRef,
    title: input?.title,
    conversation_id: conversationId,
    jobRef: ref,
  });

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
