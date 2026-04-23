import { assertUploadThingConfigured } from "../../infrastructure/storage/uploadthing-client.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { recallMemories, saveMemory, savePreference } from "../../services/memory.js";
import {
  stashDocument,
  stashDocumentNote,
  recallDocument,
  searchDocuments,
  deleteDocumentByRef,
  recentDocumentBriefs,
  documentBriefsByRefs,
} from "../../services/documents.js";
import {
  ingestUploadedFileToDocument,
} from "../../services/uploaded-file-ingest.js";
import {
  enqueueUploadedFilesIngest,
  getUploadedFileIngestJobStatus,
  listRecentCompletedUploadedFileIngestJobs,
} from "../../services/uploaded-file-ingest-jobs.js";
import type { OpenAiFileRef } from "../http/schemas/uploaded-files.js";

export type MemoryTypeInput = "preference" | "fact" | "event" | "decision" | "note";
export type RememberKindInput = "fact" | "preference" | "document-note" | "document-blob";

const RECALL_MATCHED_DOCS_TIMEOUT_MS = 2_200;
const RECALL_MATCHED_DOCS_INLINE_LIMIT = 3;
const INLINE_DOCUMENT_MAX_CHARS = 4_000;
const DOC_BRIEF_PREVIEW_MAX_CHARS = 200;
const MEMORY_TEXT_MAX_CHARS = 600;

export function isTransientMemoryInfraError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Qdrant|timeout|aborted|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|No route to host|connection error|fetch failed|APIConnectionError|EHOSTUNREACH|EAI_AGAIN/i.test(error.message);
}

export function degradedRecallResponse() {
  return {
    contextBlock: "--- No relevant memories found ---",
    memories: [],
    recentDocuments: [],
    matchedDocuments: [],
    referencedDocuments: [],
    recentCompletedIngests: [],
    autoSave: {
      requested: 0,
      complete: true,
      saved: [],
      errors: [],
    },
  };
}

function recallTypesOrDefault(types?: MemoryTypeInput[]): MemoryTypeInput[] {
  if (types && types.length > 0) return types;
  return ["fact", "preference"];
}

function shouldSearchMatchedDocuments(input: {
  query: string;
  includeDocRefs?: string[];
  openaiFileIdRefsCount: number;
}): boolean {
  return input.query.trim().length > 0
    || input.openaiFileIdRefsCount > 0
    || (input.includeDocRefs?.length ?? 0) > 0;
}

function truncateInlineDocumentContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= INLINE_DOCUMENT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, INLINE_DOCUMENT_MAX_CHARS)} [truncated]`;
}

function sanitizeMemoryForResponse(memory: { id: string; text: string; score: number; metadata: Record<string, unknown> }) {
  const m = memory.metadata;
  const text = typeof memory.text === "string" && memory.text.length > MEMORY_TEXT_MAX_CHARS
    ? `${memory.text.slice(0, MEMORY_TEXT_MAX_CHARS)} [truncated]`
    : memory.text;
  return {
    id: memory.id,
    text,
    score: memory.score,
    metadata: {
      platform: m["platform"] ?? null,
      memory_type: m["memory_type"] ?? null,
      createdAt: m["createdAt"] ?? null,
      category: m["category"] ?? null,
      is_pinned: m["is_pinned"] ?? false,
    },
  };
}

function trimDocBriefForResponse<T extends { preview?: string; blob?: unknown }>(doc: T): Omit<T, "blob"> {
  const { blob: _blob, ...rest } = doc as T & { blob?: unknown };
  void _blob;
  if (!rest.preview || (rest.preview as string).length <= DOC_BRIEF_PREVIEW_MAX_CHARS) {
    return rest as Omit<T, "blob">;
  }
  return { ...rest, preview: `${(rest.preview as string).slice(0, DOC_BRIEF_PREVIEW_MAX_CHARS)}…` } as Omit<T, "blob">;
}

function buildContextBlockWithDocuments(
  memories: Array<{ text: string; metadata?: Record<string, unknown> }>,
  inlineDocuments: Array<{ ref: string; title: string | null; content: string }>
): string {
  if (memories.length === 0 && inlineDocuments.length === 0) {
    return "--- No relevant memories found ---";
  }

  const preferenceLines: string[] = [];
  const otherLines: string[] = [];

  for (const memory of memories) {
    const metadata = memory.metadata ?? {};
    const platform = typeof metadata["platform"] === "string" && metadata["platform"].length > 0
      ? metadata["platform"]
      : "unknown";
    const line = `[${platform.toUpperCase()}] ${memory.text}`;
    if (metadata["memory_type"] === "preference") {
      preferenceLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  const documentLines = inlineDocuments.length > 0
    ? [
      "--- Matched Document Context ---",
      ...inlineDocuments.flatMap((doc) => [
        `[${doc.title ?? doc.ref}]`,
        truncateInlineDocumentContent(doc.content),
      ]),
    ]
    : [];

  const lines = [...preferenceLines, ...documentLines, ...otherLines];
  return `--- Your Past Context ---\n${lines.join("\n")}\n---`;
}

async function withSoftTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout?: () => void
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((resolve) => {
        timeoutHandle = setTimeout(() => {
          onTimeout?.();
          resolve(fallback);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export interface RecallActionInput {
  query: string;
  limit: number;
  types?: MemoryTypeInput[];
  include_doc_refs?: string[];
  openaiFileIdRefs?: OpenAiFileRef[];
  conversation_id?: string | null;
  requesterIp?: string;
}

export type RecallActionResult =
  | {
    status: 200;
    body: {
      contextBlock: string;
      memories: unknown[];
      recentDocuments: unknown[];
      matchedDocuments: Array<{ ref: string; title: string; score: number; preview: string }>;
      referencedDocuments: unknown[];
      recentCompletedIngests: unknown[];
      autoSave: {
        requested: number;
        complete: boolean;
        saved: Array<{ ref: string; status: "pending"; filename: string; conversation_id: string | null }>;
        errors: Array<{ file_id: string; filename: string; error: string }>;
      };
      inlineDocuments?: Array<{ ref: string; title: string | null; content: string }>;
      autoSaved?: Array<{ ref: string; status: "pending"; filename: string; conversation_id: string | null }>;
      autoSaveNotice?: string;
      autoSaveErrors?: Array<{ file_id: string; filename: string; error: string }>;
    };
  }
  | {
    status: 422;
    body: {
      error: string;
      autoSave: {
        requested: number;
        complete: false;
        saved: Array<{ ref: string; status: "pending"; filename: string; conversation_id: string | null }>;
        errors: Array<{ file_id: string; filename: string; error: string }>;
      };
    };
  };

export async function executeRecallAction(auth: AuthContext, input: RecallActionInput): Promise<RecallActionResult> {
  const uploadedFiles = input.openaiFileIdRefs ?? [];
  const matchedDocsEnabled = shouldSearchMatchedDocuments({
    query: input.query,
    includeDocRefs: input.include_doc_refs,
    openaiFileIdRefsCount: uploadedFiles.length,
  });

  const matchedDocumentsPromise = matchedDocsEnabled
    ? withSoftTimeout(
      searchDocuments(input.query, auth, 3).catch(() => []),
      RECALL_MATCHED_DOCS_TIMEOUT_MS,
      []
    )
    : Promise.resolve([]);

  const recentDocsPromise = recentDocumentBriefs(auth, 5);

  const recentIngestsEnabled = Boolean(input.conversation_id) || uploadedFiles.length > 0;
  const recentIngestsPromise = recentIngestsEnabled
    ? listRecentCompletedUploadedFileIngestJobs(auth, {
      conversation_id: input.conversation_id ?? null,
      limit: 5,
    })
    : Promise.resolve([]);

  const [result, recentDocuments, matchedDocuments, recentCompletedIngests] = await Promise.all([
    recallMemories(input.query, auth, input.limit, input.requesterIp, {
      types: recallTypesOrDefault(input.types),
    }),
    recentDocsPromise,
    matchedDocumentsPromise,
    recentIngestsPromise,
  ]);

  const queryExtractedRefs = Array.from(input.query.matchAll(/@(?:doc|lot):[a-z0-9_-]+/gi), (m) => m[0]);
  // Deduplicate matched docs by title to avoid fetching the same document multiple times
  // (e.g. when a user uploads the same file under different refs)
  const seenTitles = new Set<string>();
  const deduplicatedMatchedDocs = matchedDocuments.filter((doc) => {
    const key = doc.title.trim().toLowerCase();
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });
  const matchedRefs = deduplicatedMatchedDocs.slice(0, RECALL_MATCHED_DOCS_INLINE_LIMIT).map((doc) => doc.ref);
  const inlineCandidateRefs = [...new Set([...queryExtractedRefs, ...matchedRefs])];

  const refs = [...new Set([...(input.include_doc_refs ?? []), ...queryExtractedRefs].map((v) => v.trim()).filter(Boolean))];
  const referencedDocuments = refs.length > 0
    ? await documentBriefsByRefs(refs, auth, { maxLotDocs: 5 })
    : [];

  type InlineDoc = { ref: string; title: string | null; content: string };
  const inlineDocuments: InlineDoc[] = [];
  if (inlineCandidateRefs.length > 0) {
    for (const ref of inlineCandidateRefs) {
      try {
        const doc = await recallDocument(ref, auth);
        if (doc.kind === "document") {
          inlineDocuments.push({ ref, title: doc.title ?? null, content: doc.content });
        } else if (doc.kind === "lot") {
          for (const d of doc.docs) {
            inlineDocuments.push({ ref: d.ref, title: d.title ?? null, content: d.content });
          }
        }
      } catch {
        // ignore
      }
    }
  }

  const autoSaved: Array<{ ref: string; status: "pending"; filename: string; conversation_id: string | null }> = [];
  const autoSaveErrors: Array<{ file_id: string; filename: string; error: string }> = [];

  if (uploadedFiles.length > 0) {
    assertUploadThingConfigured();
    const { enqueued, errors } = await enqueueUploadedFilesIngest(uploadedFiles, auth, {
      conversation_id: input.conversation_id ?? null,
    });
    autoSaved.push(...enqueued);
    autoSaveErrors.push(...errors);
  }

  if (uploadedFiles.length > 0 && autoSaveErrors.length > 0) {
    return {
      status: 422,
      body: {
        error: "One or more uploaded files failed to save. Retry upload_blob before answering.",
        autoSave: {
          requested: uploadedFiles.length,
          complete: false,
          saved: autoSaved,
          errors: autoSaveErrors,
        },
      },
    };
  }

  return {
    status: 200,
    body: {
      contextBlock: buildContextBlockWithDocuments(
        result.memories as Array<{ text: string; metadata?: Record<string, unknown> }>,
        inlineDocuments
      ),
      memories: result.memories.map(sanitizeMemoryForResponse),
      recentDocuments: recentDocuments.map(trimDocBriefForResponse),
      matchedDocuments,
      referencedDocuments,
      recentCompletedIngests,
      autoSave: {
        requested: uploadedFiles.length,
        complete: autoSaveErrors.length === 0,
        saved: autoSaved,
        errors: autoSaveErrors,
      },
      ...(autoSaved.length > 0 ? {
        autoSaved,
        autoSaveNotice: `Queued ${autoSaved.length} file(s) for background ingest. Use upload_status with returned ref values to check completion.`,
      } : {}),
      ...(autoSaveErrors.length > 0 ? { autoSaveErrors } : {}),
    },
  };
}

export interface RememberActionInput {
  kind: RememberKindInput;
  content?: string;
  title?: string;
  key_points?: string[];
  summary?: string;
  source_hint?: string;
  category?: string;
  preference_key?: string;
  platform?: "claude" | "chatgpt" | "gemini" | "other";
  openaiFileIdRefs?: OpenAiFileRef[];
  conversation_id?: string | null;
}

export async function executeRememberAction(auth: AuthContext, input: RememberActionInput): Promise<{ status: number; body: Record<string, unknown> }> {
  const uploadedFiles = input.openaiFileIdRefs ?? [];

  if (uploadedFiles.length > 0) {
    if (input.kind !== "document-note" && input.kind !== "document-blob") {
      return { status: 400, body: { error: "openaiFileIdRefs can only be used with kind=document-note or kind=document-blob" } };
    }

    assertUploadThingConfigured();

    const savedFromFiles: Array<{
      ref: string;
      status: string;
      title: string;
      filename: string | null;
      type: "note" | "blob";
      conversation_id: string | null;
      blob: { provider: "uploadthing"; key: string; url: string; source_file_id: string } | null;
    }> = [];
    const fileErrors: Array<{ file_id: string; filename: string; error: string }> = [];

    for (const fileRef of uploadedFiles) {
      try {
        if (input.kind === "document-note") {
          const noteResult = await stashDocumentNote({
            title: input.title ?? fileRef.name ?? "Uploaded Document",
            key_points: input.key_points ?? [],
            summary: input.summary ?? "",
            source_hint: input.source_hint ?? `Uploaded via ChatGPT — ${fileRef.name || fileRef.id}`,
          }, auth, { conversationId: input.conversation_id ?? null });
          savedFromFiles.push({
            ref: noteResult.refHandle,
            status: noteResult.status,
            title: input.title ?? fileRef.name ?? "Uploaded Document",
            filename: fileRef.name ?? null,
            type: "note",
            conversation_id: input.conversation_id ?? null,
            blob: null,
          });
        }

        const blobSaved = await ingestUploadedFileToDocument(fileRef, auth, {
          title: input.title,
          conversation_id: input.conversation_id ?? null,
        });

        savedFromFiles.push({
          ref: blobSaved.ref,
          status: blobSaved.status,
          title: blobSaved.title,
          filename: blobSaved.filename,
          type: "blob",
          conversation_id: blobSaved.conversation_id,
          blob: blobSaved.blob,
        });
      } catch (fileErr) {
        const errMsg = fileErr instanceof Error ? fileErr.message : String(fileErr);
        fileErrors.push({
          file_id: fileRef.id,
          filename: fileRef.name ?? fileRef.id,
          error: errMsg,
        });
      }
    }

    if (fileErrors.length > 0) {
      return {
        status: 422,
        body: {
          success: false,
          kind: input.kind,
          error: "One or more files failed to save.",
          count_saved: savedFromFiles.length,
          count_failed: fileErrors.length,
          saved: savedFromFiles,
          errors: fileErrors,
        },
      };
    }

    const first = savedFromFiles[0];
    if (savedFromFiles.length === 1 && first) {
      return {
        status: 200,
        body: {
          success: true,
          kind: input.kind,
          ref: first.ref,
          status: first.status,
          title: first.title,
          filename: first.filename,
          conversation_id: first.conversation_id,
          blob: first.blob,
        },
      };
    }

    return {
      status: 200,
      body: {
        success: true,
        kind: input.kind,
        count: savedFromFiles.length,
        saved: savedFromFiles,
      },
    };
  }

  if (input.kind === "fact") {
    if (!input.content) return { status: 400, body: { error: "content is required for kind=fact" } };
    const saved = await saveMemory(input.content, auth, input.platform ?? "chatgpt", undefined, {
      memoryType: "fact",
      runFactExtraction: false,
    });
    return {
      status: 200,
      body: {
        success: true,
        kind: input.kind,
        memoryId: saved.memoryId,
        title: saved.title,
        summary: saved.summary,
      },
    };
  }

  if (input.kind === "preference") {
    if (!input.content) return { status: 400, body: { error: "content is required for kind=preference" } };
    const saved = await savePreference(input.content, auth, input.platform ?? "chatgpt", undefined, {
      category: input.category ?? null,
      preferenceKey: input.preference_key ?? null,
      runFactExtraction: false,
    });
    return {
      status: 200,
      body: {
        success: true,
        kind: input.kind,
        memoryId: saved.memoryId,
        title: saved.title,
        summary: saved.summary,
      },
    };
  }

  if (input.kind === "document-note") {
    const saved = await stashDocumentNote({
      title: input.title ?? "Untitled Note",
      key_points: input.key_points ?? [],
      summary: input.summary ?? "",
      source_hint: input.source_hint ?? "",
    }, auth, { conversationId: input.conversation_id ?? null });

    return {
      status: 200,
      body: {
        success: true,
        kind: input.kind,
        ref: saved.refHandle,
        status: saved.status,
        conversation_id: input.conversation_id ?? null,
        blob: null,
      },
    };
  }

  if (!input.content) return { status: 400, body: { error: "content is required for kind=document-blob" } };
  const saved = await stashDocument(input.content, auth, { title: input.title ?? undefined });
  return {
    status: 200,
    body: {
      success: true,
      kind: input.kind,
      ref: saved.refHandle,
      status: saved.status,
      lotRef: saved.lotRef ?? null,
      conversation_id: saved.conversationId,
      blob: saved.blob ? {
        provider: saved.blob.provider,
        key: saved.blob.key,
        url: saved.blob.url,
        source_file_id: saved.blob.sourceFileId,
      } : null,
    },
  };
}

export async function executeUploadBlobAction(auth: AuthContext, input: {
  openaiFileIdRefs: OpenAiFileRef[];
  conversation_id?: string | null;
  title?: string;
}): Promise<{ status: 200 | 422; body: Record<string, unknown> }> {
  assertUploadThingConfigured();

  const { enqueued, errors } = await enqueueUploadedFilesIngest(input.openaiFileIdRefs, auth, {
    title: input.title,
    conversation_id: input.conversation_id ?? null,
  });

  if (errors.length > 0) {
    return {
      status: 422,
      body: {
        success: false,
        error: "One or more files failed to save.",
        count_saved: enqueued.length,
        count_failed: errors.length,
        saved: enqueued,
        errors,
      },
    };
  }

  return {
    status: 200,
    body: {
      success: true,
      count_saved: enqueued.length,
      count_failed: 0,
      saved: enqueued,
      errors: [],
    },
  };
}

export async function executeUploadStatusAction(auth: AuthContext, ref: string): Promise<{ status: 200 | 404; body: Record<string, unknown> }> {
  const status = await getUploadedFileIngestJobStatus(auth, ref);
  if (!status) {
    return { status: 404, body: { error: "Upload ingest job not found" } };
  }
  return { status: 200, body: status as unknown as Record<string, unknown> };
}

export async function executeUndoSaveAction(auth: AuthContext, ref: string): Promise<{ status: 200; body: Record<string, unknown> }> {
  const deleted = await deleteDocumentByRef(ref, auth);
  return { status: 200, body: { success: true, ref, type: deleted.type } };
}

export async function executeRecentDocumentsAction(auth: AuthContext, limit: number): Promise<{ status: 200; body: Record<string, unknown> }> {
  const documents = await recentDocumentBriefs(auth, limit);
  return { status: 200, body: { documents, count: documents.length } };
}

export async function executeSearchDocumentsAction(auth: AuthContext, query: string, limit: number): Promise<{ status: 200; body: Record<string, unknown> }> {
  const matches = await searchDocuments(query, auth, limit);
  return { status: 200, body: { matches, count: matches.length } };
}

export async function executeRecallDocumentAction(auth: AuthContext, ref: string): Promise<{ status: 200; body: Record<string, unknown> }> {
  const document = await recallDocument(ref, auth);
  return { status: 200, body: document as unknown as Record<string, unknown> };
}
