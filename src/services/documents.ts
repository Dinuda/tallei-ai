import { randomBytes, randomUUID } from "crypto";

import { config } from "../config/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { embedText } from "../infrastructure/cache/embedding-cache.js";
import {
  decryptMemoryContent,
  encryptMemoryContent,
  hashMemoryContent,
} from "../infrastructure/crypto/memory-crypto.js";
import { pool } from "../infrastructure/db/index.js";
import { VectorRepository } from "../infrastructure/repositories/vector.repository.js";
import { summarizeConversation } from "../orchestration/ai/summarize.usecase.js";
import { PlanRequiredError } from "../shared/errors/index.js";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const AUTO_LOT_WINDOW_MS = 60_000;
const DOCUMENT_VECTOR_PLATFORM = "document";
const MAX_REF_HANDLE_RETRIES = 12;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DOCUMENT_LEXICAL_CANDIDATE_LIMIT = 250;

const vectorRepository = new VectorRepository();

interface DocumentRow {
  id: string;
  ref_handle: string;
  lot_id: string | null;
  filename: string | null;
  title: string | null;
  byte_size: number;
  content_ciphertext: string;
  summary_json: unknown;
  status: "pending" | "ready" | "failed";
  created_at: string;
}

interface LotRow {
  id: string;
  ref_handle: string;
  title: string | null;
  created_at: string;
}

interface AutoLotWindow {
  docIds: string[];
  docRefs: string[];
  lotId: string | null;
  lotRef: string | null;
  lastAt: number;
}

const autoLotByActor = new Map<string, AutoLotWindow>();

function actorKey(auth: AuthContext): string {
  return `${auth.tenantId}:${auth.userId}`;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function normalizeRef(value: string): string {
  return value.trim();
}

function isDocumentRef(value: string): boolean {
  return /^@doc:/.test(value.trim());
}

function isLotRef(value: string): boolean {
  return /^@lot:/.test(value.trim());
}

function toSlug(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const withoutExt = raw.replace(/\.[a-z0-9]{1,8}$/i, "");
  const slug = withoutExt
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || fallback;
}

function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += BASE32_ALPHABET[bytes[i] % BASE32_ALPHABET.length];
  }
  return out;
}

function buildRefHandle(kind: "doc" | "lot", source: string): string {
  return `@${kind}:${source}-${randomBase32(4)}`;
}

function fallbackSummary(content: string): Record<string, unknown> {
  const compact = content.replace(/\s+/g, " ").trim();
  const snippet = compact.slice(0, 220);
  return {
    title: snippet.slice(0, 80) || "Untitled Document",
    keyPoints: snippet ? [snippet] : [],
    decisions: [],
    summary: snippet || "No summary available.",
  };
}

function summaryPreview(summaryJson: unknown): string {
  if (!summaryJson || typeof summaryJson !== "object") return "";
  const record = summaryJson as Record<string, unknown>;
  if (typeof record["summary"] === "string") return record["summary"];
  if (Array.isArray(record["keyPoints"])) {
    const first = record["keyPoints"].find((value) => typeof value === "string");
    if (typeof first === "string") return first;
  }
  return "";
}

function embeddingInputFromSummary(summaryJson: Record<string, unknown>): string {
  const title = typeof summaryJson["title"] === "string" ? summaryJson["title"] : "";
  const summary = typeof summaryJson["summary"] === "string" ? summaryJson["summary"] : "";
  const points = Array.isArray(summaryJson["keyPoints"])
    ? summaryJson["keyPoints"].filter((v): v is string => typeof v === "string").join("\n")
    : "";
  return [title, summary, points].filter(Boolean).join("\n");
}

function tokenizeLexicalQuery(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function lexicalScoreDocument(
  query: string,
  queryTokens: string[],
  doc: { ref: string; title: string | null; preview: string; createdAt: string }
): number {
  const normalizedQuery = query.toLowerCase();
  const haystack = `${doc.ref} ${doc.title ?? ""} ${doc.preview}`.toLowerCase();
  if (!haystack) return 0;

  let tokenMatches = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) tokenMatches += 1;
  }

  const tokenScore = queryTokens.length > 0 ? tokenMatches / queryTokens.length : 0;
  const phraseBoost = normalizedQuery.length > 0 && haystack.includes(normalizedQuery) ? 0.35 : 0;

  const createdAtMs = new Date(doc.createdAt).getTime();
  const ageDays = Number.isFinite(createdAtMs)
    ? Math.max(0, (Date.now() - createdAtMs) / 86_400_000)
    : 365;
  const recencyBoost = Math.max(0, 0.2 - Math.min(0.2, ageDays / 365));

  return Number((tokenScore + phraseBoost + recencyBoost).toFixed(4));
}

async function lexicalSearchDocuments(
  query: string,
  auth: AuthContext,
  limit: number
): Promise<Array<{ ref: string; title: string; score: number; preview: string }>> {
  const queryTokens = tokenizeLexicalQuery(query);
  if (queryTokens.length === 0) return [];

  const rows = await pool.query<{
    ref_handle: string;
    title: string | null;
    summary_json: unknown;
    created_at: string;
  }>(
    `SELECT ref_handle, title, summary_json, created_at
     FROM documents
     WHERE tenant_id = $1
       AND user_id = $2
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT $3`,
    [auth.tenantId, auth.userId, DOCUMENT_LEXICAL_CANDIDATE_LIMIT]
  );

  return rows.rows
    .map((row) => {
      const preview = summaryPreview(row.summary_json);
      const score = lexicalScoreDocument(query, queryTokens, {
        ref: row.ref_handle,
        title: row.title,
        preview,
        createdAt: row.created_at,
      });
      return {
        ref: row.ref_handle,
        title: row.title ?? "Untitled Document",
        score,
        preview,
        createdAt: row.created_at,
      };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    })
    .slice(0, limit)
    .map(({ ref, title, score, preview }) => ({ ref, title, score, preview }));
}

async function generateUniqueLotRef(auth: AuthContext, title: string | null): Promise<string> {
  const slug = toSlug(title, "lot");

  for (let attempt = 0; attempt < MAX_REF_HANDLE_RETRIES; attempt += 1) {
    const candidate = buildRefHandle("lot", slug);
    const exists = await pool.query<{ id: string }>(
      `SELECT id
       FROM document_lots
       WHERE tenant_id = $1 AND ref_handle = $2
       LIMIT 1`,
      [auth.tenantId, candidate]
    );
    if (!exists.rows[0]) {
      return candidate;
    }
  }

  throw new Error("Failed to generate a unique lot reference");
}

async function createLotRecord(auth: AuthContext, title: string | null): Promise<{ lotId: string; lotRef: string }> {
  for (let attempt = 0; attempt < MAX_REF_HANDLE_RETRIES; attempt += 1) {
    const lotRef = await generateUniqueLotRef(auth, title);
    const lotId = randomUUID();

    try {
      await pool.query(
        `INSERT INTO document_lots (id, tenant_id, user_id, ref_handle, title)
         VALUES ($1, $2, $3, $4, $5)`,
        [lotId, auth.tenantId, auth.userId, lotRef, title]
      );
      return { lotId, lotRef };
    } catch (error) {
      if (isUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Failed to create lot record");
}

async function assignDocumentsToLot(auth: AuthContext, lotId: string, docIds: string[]): Promise<void> {
  if (docIds.length === 0) return;
  await pool.query(
    `UPDATE documents
     SET lot_id = $1
     WHERE tenant_id = $2
       AND user_id = $3
       AND deleted_at IS NULL
       AND id = ANY($4::uuid[])`,
    [lotId, auth.tenantId, auth.userId, docIds]
  );
}

async function maybeAutoCreateLot(
  auth: AuthContext,
  docId: string,
  docRef: string,
  titleHint: string | null
): Promise<string | null> {
  const key = actorKey(auth);
  const now = Date.now();
  const current = autoLotByActor.get(key);

  if (!current || now - current.lastAt > AUTO_LOT_WINDOW_MS) {
    autoLotByActor.set(key, {
      docIds: [docId],
      docRefs: [docRef],
      lotId: null,
      lotRef: null,
      lastAt: now,
    });
    return null;
  }

  current.docIds.push(docId);
  current.docRefs.push(docRef);
  current.lastAt = now;

  if (current.lotId && current.lotRef) {
    await assignDocumentsToLot(auth, current.lotId, [docId]);
    return current.lotRef;
  }

  if (current.docIds.length < 2) {
    return null;
  }

  const autoTitle = titleHint ? `Lot: ${titleHint}` : "Auto document lot";
  const createdLot = await createLotRecord(auth, autoTitle);
  await assignDocumentsToLot(auth, createdLot.lotId, current.docIds);

  current.lotId = createdLot.lotId;
  current.lotRef = createdLot.lotRef;
  return createdLot.lotRef;
}

function normalizeContent(content: string): string {
  if (typeof content !== "string") return "";
  return content;
}

async function runBackgroundIndexing(input: {
  auth: AuthContext;
  documentId: string;
  content: string;
  createdAt: string;
}): Promise<void> {
  const fallback = fallbackSummary(input.content);

  let summaryJson: Record<string, unknown> = fallback;
  try {
    const summary = await summarizeConversation(input.content);
    summaryJson = { ...summary };
  } catch {
    summaryJson = fallback;
  }

  let pointId: string | null = null;
  let vectorErrorMessage: string | null = null;

  try {
    const embeddingInput = embeddingInputFromSummary(summaryJson).trim()
      || input.content.replace(/\s+/g, " ").trim().slice(0, 1200)
      || "document";
    const vector = await embedText(embeddingInput);
    const upserted = await vectorRepository.upsertMemoryVector({
      auth: input.auth,
      memoryId: input.documentId,
      pointId: input.documentId,
      vector,
      platform: DOCUMENT_VECTOR_PLATFORM,
      createdAt: input.createdAt,
    });
    pointId = upserted.pointId;
  } catch (error) {
    vectorErrorMessage = error instanceof Error ? error.message.slice(0, 300) : "unknown";
  }

  const summaryForStorage = vectorErrorMessage
    ? {
      ...summaryJson,
      index_degraded: "vector_unavailable",
      index_error: vectorErrorMessage,
    }
    : summaryJson;

  await pool.query(
    `UPDATE documents
     SET summary_json = $1::jsonb,
         qdrant_point_id = $2,
         status = 'ready'
     WHERE id = $3
       AND tenant_id = $4
       AND user_id = $5
       AND deleted_at IS NULL`,
    [JSON.stringify(summaryForStorage), pointId, input.documentId, input.auth.tenantId, input.auth.userId]
  );
}

export class DocumentSizeExceededError extends Error {
  override readonly name = "DocumentSizeExceededError";

  constructor(message: string) {
    super(message);
  }
}

export function assertPro(auth: AuthContext): void {
  if (auth.plan === "pro" || auth.plan === "power") return;
  throw new PlanRequiredError(
    `PDF stash is a Pro feature. Upgrade at ${config.dashboardBaseUrl.replace(/\/$/, "")}/billing.`
  );
}

export async function stashDocument(
  content: string,
  auth: AuthContext,
  opts?: {
    filename?: string;
    title?: string;
    mimeType?: string;
  }
): Promise<{ refHandle: string; status: "pending"; lotRef?: string }> {
  assertPro(auth);

  const rawContent = normalizeContent(content);
  const byteSize = Buffer.byteLength(rawContent, "utf8");

  if (byteSize < 1) {
    throw new Error("Document content is required");
  }
  if (rawContent.trim().length === 0) {
    throw new Error("Document content cannot be blank");
  }
  if (byteSize > MAX_DOCUMENT_BYTES) {
    throw new DocumentSizeExceededError("Document exceeds the 2MB size limit for v1 stash uploads.");
  }

  const sourceName = opts?.title ?? opts?.filename ?? "document";
  const slug = toSlug(sourceName, "document");

  const documentId = randomUUID();
  const contentHash = hashMemoryContent(rawContent);
  const encrypted = encryptMemoryContent(rawContent);
  const createdAt = new Date().toISOString();

  let refHandle = "";
  for (let attempt = 0; attempt < MAX_REF_HANDLE_RETRIES; attempt += 1) {
    const candidate = buildRefHandle("doc", slug);
    try {
      await pool.query(
        `INSERT INTO documents
         (id, tenant_id, user_id, ref_handle, lot_id, filename, title, mime_type, byte_size, content_ciphertext, content_hash, summary_json, status, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, '{}'::jsonb, 'pending', $11)`,
        [
          documentId,
          auth.tenantId,
          auth.userId,
          candidate,
          opts?.filename ?? null,
          opts?.title ?? null,
          opts?.mimeType ?? "text/markdown",
          byteSize,
          encrypted,
          contentHash,
          createdAt,
        ]
      );
      refHandle = candidate;
      break;
    } catch (error) {
      if (isUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }

  if (!refHandle) {
    throw new Error("Failed to generate a unique document reference");
  }

  const lotRef = await maybeAutoCreateLot(auth, documentId, refHandle, opts?.title ?? null);

  void runBackgroundIndexing({
    auth,
    documentId,
    content: rawContent,
    createdAt,
  }).catch((error) => {
    if (config.nodeEnv !== "production") {
      console.warn("[documents] background indexing failed", error);
    }
  });

  return lotRef ? { refHandle, status: "pending", lotRef } : { refHandle, status: "pending" };
}

export async function createLot(
  refHandles: string[],
  auth: AuthContext,
  title?: string
): Promise<{ lotRef: string; docRefs: string[] }> {
  assertPro(auth);

  const uniqueRefs = [...new Set(refHandles.map((value) => normalizeRef(value)).filter(Boolean))];
  if (uniqueRefs.length === 0) {
    throw new Error("At least one document ref is required");
  }
  if (uniqueRefs.some((ref) => !isDocumentRef(ref))) {
    throw new Error("create_lot only accepts @doc references");
  }

  const rows = await pool.query<{ id: string; ref_handle: string }>(
    `SELECT id, ref_handle
     FROM documents
     WHERE tenant_id = $1
       AND user_id = $2
       AND deleted_at IS NULL
       AND ref_handle = ANY($3::text[])`,
    [auth.tenantId, auth.userId, uniqueRefs]
  );

  if (rows.rows.length !== uniqueRefs.length) {
    throw new Error("One or more document refs were not found for this account");
  }

  const createdLot = await createLotRecord(auth, title ?? null);
  await assignDocumentsToLot(auth, createdLot.lotId, rows.rows.map((row) => row.id));

  return { lotRef: createdLot.lotRef, docRefs: uniqueRefs };
}

function decodeDocumentRow(row: DocumentRow): {
  ref: string;
  filename: string | null;
  title: string | null;
  content: string;
  status: "ready" | "pending_embedding" | "failed_indexing";
} {
  let content = "";
  try {
    content = decryptMemoryContent(row.content_ciphertext);
  } catch {
    content = "[Encrypted document unavailable]";
  }

  const status = row.status === "ready"
    ? "ready"
    : row.status === "pending"
      ? "pending_embedding"
      : "failed_indexing";

  return {
    ref: row.ref_handle,
    filename: row.filename,
    title: row.title,
    content,
    status,
  };
}

export async function recallDocument(
  refHandle: string,
  auth: AuthContext
): Promise<
  | {
    kind: "document";
    ref: string;
    filename: string | null;
    title: string | null;
    content: string;
    status: "ready" | "pending_embedding" | "failed_indexing";
  }
  | {
    kind: "lot";
    ref: string;
    title: string | null;
    docs: Array<{
      ref: string;
      filename: string | null;
      title: string | null;
      content: string;
      status: "ready" | "pending_embedding" | "failed_indexing";
    }>;
  }
> {
  assertPro(auth);

  const normalized = normalizeRef(refHandle);

  if (isLotRef(normalized)) {
    const lot = await recallLot(normalized, auth);
    return {
      kind: "lot",
      ref: lot.ref,
      title: lot.title,
      docs: lot.docs,
    };
  }

  const documentResult = await pool.query<DocumentRow>(
    `SELECT id, ref_handle, lot_id, filename, title, byte_size, content_ciphertext, summary_json, status, created_at
     FROM documents
     WHERE tenant_id = $1
       AND user_id = $2
       AND deleted_at IS NULL
       AND ref_handle = $3
     LIMIT 1`,
    [auth.tenantId, auth.userId, normalized]
  );

  const row = documentResult.rows[0];
  if (!row) {
    throw new Error("Document not found");
  }

  const decoded = decodeDocumentRow(row);
  return {
    kind: "document",
    ref: decoded.ref,
    filename: decoded.filename,
    title: decoded.title,
    content: decoded.content,
    status: decoded.status,
  };
}

export async function recallLot(
  refHandle: string,
  auth: AuthContext
): Promise<{
  ref: string;
  title: string | null;
  docs: Array<{
    ref: string;
    filename: string | null;
    title: string | null;
    content: string;
    status: "ready" | "pending_embedding" | "failed_indexing";
  }>;
}> {
  assertPro(auth);

  const lotResult = await pool.query<LotRow>(
    `SELECT id, ref_handle, title, created_at
     FROM document_lots
     WHERE tenant_id = $1
       AND user_id = $2
       AND deleted_at IS NULL
       AND ref_handle = $3
     LIMIT 1`,
    [auth.tenantId, auth.userId, normalizeRef(refHandle)]
  );

  const lot = lotResult.rows[0];
  if (!lot) {
    throw new Error("Lot not found");
  }

  const docsResult = await pool.query<DocumentRow>(
    `SELECT id, ref_handle, lot_id, filename, title, byte_size, content_ciphertext, summary_json, status, created_at
     FROM documents
     WHERE tenant_id = $1
       AND user_id = $2
       AND deleted_at IS NULL
       AND lot_id = $3
     ORDER BY created_at ASC`,
    [auth.tenantId, auth.userId, lot.id]
  );

  return {
    ref: lot.ref_handle,
    title: lot.title,
    docs: docsResult.rows.map((row) => decodeDocumentRow(row)),
  };
}

export async function searchDocuments(
  query: string,
  auth: AuthContext,
  limit = 5
): Promise<Array<{ ref: string; title: string; score: number; preview: string }>> {
  assertPro(auth);

  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const normalizedLimit = Math.min(20, Math.max(1, Math.floor(limit)));

  if (isDocumentRef(normalizedQuery)) {
    const doc = await pool.query<{ ref_handle: string; title: string | null; summary_json: unknown }>(
      `SELECT ref_handle, title, summary_json
       FROM documents
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND ref_handle = $3
       LIMIT 1`,
      [auth.tenantId, auth.userId, normalizedQuery]
    );

    if (doc.rows[0]) {
      return [{
        ref: doc.rows[0].ref_handle,
        title: doc.rows[0].title ?? "Untitled Document",
        score: 1,
        preview: summaryPreview(doc.rows[0].summary_json),
      }];
    }
  }

  try {
    const vector = await embedText(normalizedQuery);
    const hits = await vectorRepository.searchVectorsByPlatform(
      auth,
      vector,
      normalizedLimit,
      DOCUMENT_VECTOR_PLATFORM
    );

    if (hits.length > 0) {
      const uniqueIds = [...new Set(hits.map((hit) => hit.memoryId))];
      const rows = await pool.query<{ id: string; ref_handle: string; title: string | null; summary_json: unknown }>(
        `SELECT id, ref_handle, title, summary_json
         FROM documents
         WHERE tenant_id = $1
           AND user_id = $2
           AND deleted_at IS NULL
           AND id = ANY($3::uuid[])`,
        [auth.tenantId, auth.userId, uniqueIds]
      );

      const byId = new Map(rows.rows.map((row) => [row.id, row]));

      const mapped = hits
        .map((hit) => {
          const row = byId.get(hit.memoryId);
          if (!row) return null;
          return {
            ref: row.ref_handle,
            title: row.title ?? "Untitled Document",
            score: hit.score,
            preview: summaryPreview(row.summary_json),
          };
        })
        .filter((item): item is { ref: string; title: string; score: number; preview: string } => Boolean(item));

      if (mapped.length > 0) {
        return mapped;
      }
    }
  } catch {
    // Embedding/vector infra is unavailable; fall back to lexical summary matching.
  }

  return lexicalSearchDocuments(normalizedQuery, auth, normalizedLimit);
}

export async function listDocuments(auth: AuthContext): Promise<{
  docs: Array<{
    ref: string;
    filename: string | null;
    title: string | null;
    byteSize: number;
    status: "pending" | "ready" | "failed";
    createdAt: string;
    lotRef: string | null;
    lotTitle: string | null;
  }>;
  lots: Array<{
    ref: string;
    title: string | null;
    createdAt: string;
    documentCount: number;
  }>;
}> {
  assertPro(auth);

  const docsResult = await pool.query<{
    ref_handle: string;
    filename: string | null;
    title: string | null;
    byte_size: number;
    status: "pending" | "ready" | "failed";
    created_at: string;
    lot_ref: string | null;
    lot_title: string | null;
  }>(
    `SELECT d.ref_handle,
            d.filename,
            d.title,
            d.byte_size,
            d.status,
            d.created_at,
            l.ref_handle AS lot_ref,
            l.title AS lot_title
     FROM documents d
     LEFT JOIN document_lots l
       ON l.id = d.lot_id
      AND l.deleted_at IS NULL
     WHERE d.tenant_id = $1
       AND d.user_id = $2
       AND d.deleted_at IS NULL
     ORDER BY d.created_at DESC`,
    [auth.tenantId, auth.userId]
  );

  const lotsResult = await pool.query<{
    ref_handle: string;
    title: string | null;
    created_at: string;
    document_count: number;
  }>(
    `SELECT l.ref_handle,
            l.title,
            l.created_at,
            COUNT(d.id)::int AS document_count
     FROM document_lots l
     LEFT JOIN documents d
       ON d.lot_id = l.id
      AND d.deleted_at IS NULL
     WHERE l.tenant_id = $1
       AND l.user_id = $2
       AND l.deleted_at IS NULL
     GROUP BY l.id
     ORDER BY l.created_at DESC`,
    [auth.tenantId, auth.userId]
  );

  return {
    docs: docsResult.rows.map((row) => ({
      ref: row.ref_handle,
      filename: row.filename,
      title: row.title,
      byteSize: row.byte_size,
      status: row.status,
      createdAt: row.created_at,
      lotRef: row.lot_ref,
      lotTitle: row.lot_title,
    })),
    lots: lotsResult.rows.map((row) => ({
      ref: row.ref_handle,
      title: row.title,
      createdAt: row.created_at,
      documentCount: row.document_count,
    })),
  };
}

export async function deleteDocumentByRef(
  refHandle: string,
  auth: AuthContext
): Promise<{ success: true; type: "document" | "lot" }> {
  assertPro(auth);

  const normalized = normalizeRef(refHandle);

  if (isLotRef(normalized)) {
    const lotDeleted = await pool.query<{ id: string }>(
      `UPDATE document_lots
       SET deleted_at = NOW()
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND ref_handle = $3
       RETURNING id`,
      [auth.tenantId, auth.userId, normalized]
    );

    const lot = lotDeleted.rows[0];
    if (!lot) {
      throw new Error("Lot not found");
    }

    await pool.query(
      `UPDATE documents
       SET lot_id = NULL
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND lot_id = $3`,
      [auth.tenantId, auth.userId, lot.id]
    );

    return { success: true, type: "lot" };
  }

  const deleted = await pool.query<{ id: string; lot_id: string | null }>(
    `UPDATE documents
     SET deleted_at = NOW()
     WHERE tenant_id = $1
       AND user_id = $2
       AND deleted_at IS NULL
       AND ref_handle = $3
     RETURNING id, lot_id`,
    [auth.tenantId, auth.userId, normalized]
  );

  const row = deleted.rows[0];
  if (!row) {
    throw new Error("Document not found");
  }

  void vectorRepository.deleteMemoryVector(auth, row.id).catch(() => {});

  if (row.lot_id) {
    const count = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM documents
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND lot_id = $3`,
      [auth.tenantId, auth.userId, row.lot_id]
    );
    if ((count.rows[0]?.count ?? 0) === 0) {
      await pool.query(
        `UPDATE document_lots
         SET deleted_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3
           AND deleted_at IS NULL`,
        [row.lot_id, auth.tenantId, auth.userId]
      );
    }
  }

  return { success: true, type: "document" };
}
