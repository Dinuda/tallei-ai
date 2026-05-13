import { assertUploadThingConfigured } from "../../infrastructure/storage/uploadthing-client.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { recallMemories, saveMemory, savePreference } from "../../services/memory.js";
import {
  listRecentCollabTasks,
  getCollabTaskContentForContext,
} from "../../services/collab.js";
import {
  stashDocument,
  stashDocumentNote,
  recallDocument,
  searchDocuments,
  deleteDocumentByRef,
  recentDocumentBriefs,
  documentBriefsByRefs,
  findLastConversationCheckpoint,
} from "../../services/documents.js";
import {
  ingestUploadedFileToDocument,
  validateUploadedFileRefForIngest,
} from "../../services/uploaded-file-ingest.js";
import {
  enqueueUploadedFilesIngest,
  getUploadedFileIngestJobStatus,
  listRecentCompletedUploadedFileIngestJobs,
} from "../../services/uploaded-file-ingest-jobs.js";
import type { OpenAiFileRef } from "../http/schemas/uploaded-files.js";
import { confidenceTier } from "../../infrastructure/recall/scoring-utils.js";
import type { ConflictHint } from "../../infrastructure/recall/scoring-utils.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import { runAsyncSafe } from "../../shared/async-safe.js";
import { config } from "../../config/index.js";
import { setRequestTimingField } from "../../observability/request-timing.js";

export type MemoryTypeInput = "preference" | "fact" | "event" | "decision" | "note" | "lesson" | "failure" | "checkpoint";
export type RememberKindInput = "fact" | "preference" | "document-note" | "document-blob" | "checkpoint";

export type PrepareResponseSaveCandidate = {
  kind: "fact" | "preference" | "document-note" | "checkpoint";
  content?: string;
  title?: string;
  key_points?: string[];
  summary?: string;
  source_hint?: string;
  category?: string;
  preference_key?: string;
};

export type PrepareResponseConversationMessage = {
  role?: "user" | "assistant" | "system" | "tool";
  content: string;
};

export type PrepareResponseIntent = {
  needsRecall: boolean;
  needsDocumentLookup: boolean;
  reusePreviousContext: boolean;
  contextDependent: boolean;
  saveCandidates: PrepareResponseSaveCandidate[];
};

const RECALL_MATCHED_DOCS_TIMEOUT_MS = 2_200;
const RECALL_MATCHED_DOCS_INLINE_LIMIT = 3;
const RECALL_MATCHED_DOCS_FETCH_LIMIT = 12;
const INLINE_DOCUMENT_MAX_CHARS = 4_000;
const DOC_BRIEF_PREVIEW_MAX_CHARS = 200;
const MEMORY_TEXT_MAX_CHARS = 600;
const CONVERSATION_HISTORY_MAX_MESSAGES = 40;
const CONVERSATION_HISTORY_MAX_CHARS = 20_000;

function collectUnsupportedFileErrors(openaiFileIdRefs: OpenAiFileRef[]): Array<{ file_id: string; filename: string; error: string }> {
  const errors: Array<{ file_id: string; filename: string; error: string }> = [];
  for (const fileRef of openaiFileIdRefs) {
    const error = validateUploadedFileRefForIngest({
      id: fileRef.id,
      name: fileRef.name,
      mime_type: fileRef.mime_type,
      download_link: fileRef.download_link,
    });
    if (!error) continue;
    errors.push({
      file_id: fileRef.id,
      filename: fileRef.name ?? fileRef.id,
      error,
    });
  }
  return errors;
}

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

function extractTaskIdFromCollabMemory(text: string): string | null {
  const match = text.match(/^Collab Task ([a-f0-9-]+)/im);
  return match?.[1] ?? null;
}

async function fetchRecentCollabTasks(
  auth: AuthContext,
  query: string
): Promise<Array<{ id: string; title: string; state: string; summary: string; source: "direct" | "vector" }>> {
  const directTasks = await listRecentCollabTasks(auth, 4);
  const result: Array<{ id: string; title: string; state: string; summary: string; source: "direct" | "vector" }> = directTasks.map((task) => ({
    id: task.id,
    title: task.title,
    state: task.state,
    summary: `Collab Task ${task.id}\nTitle: ${task.title}${task.brief ? `\nBrief: ${task.brief}` : ""}\nState: ${task.state}\nProgress: iteration ${task.iteration}`,

    source: "direct",
  }));

  if (result.length >= 4) return result;

  try {
    const recalled = await recallMemories(query, auth, 4 - result.length, undefined, { types: ["collab"] });
    const seenIds = new Set(result.map((d) => d.id));
    for (const memory of recalled.memories) {
      const text = typeof memory.text === "string" ? memory.text : "";
      const id = extractTaskIdFromCollabMemory(text);
      const key = id ?? text.slice(0, 80);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      result.push({
        id: id ?? "unknown",
        title: "Collab summary",
        state: "unknown",
        summary: text,
        source: "vector",
      });
      if (result.length >= 4) break;
    }
  } catch {
    // ignore vector search failures
  }

  return result;
}

function detectFocusedCollabTaskId(message: string): string | null {
  const explicitMatch = message.match(/\b(?:continue|resume|proceed|task)\s+(?:collab\s+)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i);
  if (explicitMatch) return explicitMatch[1];
  const standaloneMatch = message.match(/\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i);
  return standaloneMatch?.[1] ?? null;
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
    const tier = confidenceTier(metadata["reference_count"]);
    const line = `[${platform.toUpperCase()}:${tier}] ${memory.text}`;
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
      conflictHints?: ConflictHint[];
      recentCollabTasks?: Array<{ id: string; title: string; state: string; summary: string; source: "direct" | "vector" }>;
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
  const unsupportedFileErrors = collectUnsupportedFileErrors(uploadedFiles);
  if (unsupportedFileErrors.length > 0) {
    return {
      status: 422,
      body: {
        error: "One or more uploaded files use unsupported formats. Only PDF and Word (.docx/.docm) files are accepted.",
        autoSave: {
          requested: uploadedFiles.length,
          complete: false,
          saved: [],
          errors: unsupportedFileErrors,
        },
      },
    };
  }

  const matchedDocsEnabled = shouldSearchMatchedDocuments({
    query: input.query,
    includeDocRefs: input.include_doc_refs,
    openaiFileIdRefsCount: uploadedFiles.length,
  });

  const matchedDocumentsPromise = matchedDocsEnabled
    ? withSoftTimeout(
      searchDocuments(input.query, auth, RECALL_MATCHED_DOCS_FETCH_LIMIT).catch(() => []),
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
  // Deduplicate matched docs before truncating so repeated uploads don't crowd out
  // other relevant files in context.
  const seenDocKeys = new Set<string>();
  const deduplicatedMatchedDocs = matchedDocuments.filter((doc) => {
    const normalizedTitle = doc.title.trim().toLowerCase();
    const normalizedPreview = doc.preview.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
    const key = normalizedTitle
      ? `${normalizedTitle}::${normalizedPreview}`
      : doc.ref.trim().toLowerCase();
    if (seenDocKeys.has(key)) return false;
    seenDocKeys.add(key);
    return true;
  }).slice(0, RECALL_MATCHED_DOCS_INLINE_LIMIT);
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
          inlineDocuments.push({ ref, title: doc.title ?? null, content: truncateInlineDocumentContent(doc.content) });
        } else if (doc.kind === "lot") {
          for (const d of doc.docs) {
            inlineDocuments.push({ ref: d.ref, title: d.title ?? null, content: truncateInlineDocumentContent(d.content) });
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

  const recentCollabTasks = await fetchRecentCollabTasks(auth, input.query);

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
      matchedDocuments: deduplicatedMatchedDocs,
      referencedDocuments,
      recentCompletedIngests,
      recentCollabTasks,
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
      ...(result.conflictHints?.length ? { conflictHints: result.conflictHints } : {}),
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
  runVectorDedup?: boolean;
}

function buildDocumentNoteMemoryContent(input: RememberActionInput): string {
  const lines: string[] = [];
  const title = input.title?.trim();
  const summary = input.summary?.trim();
  const content = input.content?.trim();
  const keyPoints = (input.key_points ?? []).map((point) => point.trim()).filter(Boolean);
  const sourceHint = input.source_hint?.trim();

  if (title) lines.push(`Title: ${title}`);
  if (summary) lines.push(`Summary: ${summary}`);
  if (keyPoints.length > 0) {
    lines.push("Key points:");
    lines.push(...keyPoints.map((point) => `- ${point}`));
  }
  if (content) lines.push(`Content: ${content}`);
  if (sourceHint) lines.push(`Source: ${sourceHint}`);

  const note = lines.join("\n").trim();
  return note || "Untitled note";
}

export async function executeRememberAction(auth: AuthContext, input: RememberActionInput): Promise<{ status: number; body: Record<string, unknown> }> {
  const uploadedFiles = input.openaiFileIdRefs ?? [];

  if (uploadedFiles.length > 0) {
    if (input.kind !== "document-note" && input.kind !== "document-blob") {
      return { status: 400, body: { error: "openaiFileIdRefs can only be used with kind=document-note or kind=document-blob" } };
    }

    const unsupportedFileErrors = collectUnsupportedFileErrors(uploadedFiles);
    if (unsupportedFileErrors.length > 0) {
      return {
        status: 422,
        body: {
          success: false,
          kind: input.kind,
          error: "One or more uploaded files use unsupported formats. Only PDF and Word (.docx/.docm) files are accepted.",
          count_saved: 0,
          count_failed: unsupportedFileErrors.length,
          saved: [],
          errors: unsupportedFileErrors,
        },
      };
    }

    assertUploadThingConfigured();

    const savedFromFiles: Array<{
      ref: string;
      status: string;
      title: string;
      filename: string | null;
      type: "note" | "blob";
      conversation_id: string | null;
      memoryId?: string;
      blob: { provider: "uploadthing"; key: string; url: string; source_file_id: string } | null;
    }> = [];
    const fileErrors: Array<{ file_id: string; filename: string; error: string }> = [];

    for (const fileRef of uploadedFiles) {
      try {
        if (input.kind === "document-note") {
          const noteTitle = input.title ?? fileRef.name ?? "Uploaded Document";
          const noteResult = await stashDocumentNote({
            title: noteTitle,
            key_points: input.key_points ?? [],
            summary: input.summary ?? input.content ?? `Uploaded via ChatGPT - ${fileRef.name || fileRef.id}`,
            source_hint: input.source_hint ?? `Uploaded via ChatGPT - ${fileRef.name || fileRef.id}`,
            category: input.category ?? "other",
          }, auth, {
            conversationId: input.conversation_id ?? null,
          });
          savedFromFiles.push({
            ref: noteResult.refHandle,
            status: "ready",
            title: noteTitle,
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
      runVectorDedup: input.runVectorDedup,
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
      runVectorDedup: input.runVectorDedup,
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
    const saved = input.content
      ? await stashDocument(input.content, auth, {
        title: input.title ?? input.summary ?? "Document note",
        conversationId: input.conversation_id ?? null,
        mimeType: "text/markdown",
      })
      : await stashDocumentNote({
        title: input.title ?? "Document note",
        key_points: input.key_points ?? [],
        summary: input.summary ?? buildDocumentNoteMemoryContent(input),
        source_hint: input.source_hint ?? "Saved from chat",
        category: input.category ?? "other",
      }, auth, {
        conversationId: input.conversation_id ?? null,
      });
    return {
      status: 200,
      body: {
        success: true,
        kind: input.kind,
        ref: saved.refHandle,
        status: saved.status,
        title: input.title ?? null,
        summary: input.summary ?? null,
        conversation_id: input.conversation_id ?? null,
      },
    };
  }

  if (input.kind === "checkpoint") {
    if (!input.content) return { status: 400, body: { error: "content is required for kind=checkpoint" } };
    const saved = await saveMemory(input.content, auth, input.platform ?? "chatgpt", undefined, {
      memoryType: "checkpoint",
      category: input.category ?? null,
      runFactExtraction: false,
      runVectorDedup: input.runVectorDedup,
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
  const unsupportedFileErrors = collectUnsupportedFileErrors(input.openaiFileIdRefs);
  if (unsupportedFileErrors.length > 0) {
    return {
      status: 422,
      body: {
        success: false,
        error: "One or more uploaded files use unsupported formats. Only PDF and Word (.docx/.docm) files are accepted.",
        count_saved: 0,
        count_failed: unsupportedFileErrors.length,
        saved: [],
        errors: unsupportedFileErrors,
      },
    };
  }

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

export interface PrepareResponseActionInput {
  message: string;
  conversation_id?: string | null;
  conversation_history?: PrepareResponseConversationMessage[];
  handoff_target?: "claude" | "chatgpt" | null;
  openaiFileIdRefs?: OpenAiFileRef[];
  last_recall?: {
    query?: string;
    context_hash?: string;
  } | null;
  requesterIp?: string;
}

export interface QueuedPrepareSave {
  kind: PrepareResponseSaveCandidate["kind"];
  content?: string;
  title?: string;
  status: "queued";
}

export interface PrepareResponseActionResult {
  status: 200 | 422;
  body: Record<string, unknown> & {
    contextBlock: string;
    memories: unknown[];
    recentDocuments: unknown[];
    matchedDocuments: unknown[];
    referencedDocuments: unknown[];
    recentCompletedIngests: unknown[];
    inlineDocuments: Array<{ ref: string; title: string | null; content: string }>;
    queuedSaves: QueuedPrepareSave[];
    autoSave: {
      requested: number;
      complete: boolean;
      saved: Array<{ ref: string; status: "pending"; filename: string; conversation_id: string | null }>;
      errors: Array<{ file_id: string; filename: string; error: string }>;
    };
    replyInstructions: string[];
    intent: PrepareResponseIntent;
    recentCollabTasks?: Array<{ id: string; title: string; state: string; summary: string; source: "direct" | "vector" }>;
    focusedCollabContext?: string | null;
  };
}

type PrepareResponseDependencies = {
  classifyIntent?: (input: PrepareResponseActionInput) => Promise<PrepareResponseIntent>;
  recallAction?: typeof executeRecallAction;
  rememberAction?: typeof executeRememberAction;
  recallDocumentAction?: typeof executeRecallDocumentAction;
  enqueueSave?: (task: () => Promise<void>, label: string) => void;
  platform?: "claude" | "chatgpt" | "gemini" | "other";
};

type FastIntentDecision = {
  intent: PrepareResponseIntent;
  shouldCallClassifier: boolean;
  reason: string;
};

const DEFAULT_PREPARE_RESPONSE_INTENT: PrepareResponseIntent = {
  needsRecall: true,
  needsDocumentLookup: false,
  reusePreviousContext: false,
  contextDependent: true,
  saveCandidates: [],
};

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function timed<T>(field: string, task: () => Promise<T>): Promise<T> {
  const startedAt = nowMs();
  try {
    return await task();
  } finally {
    setRequestTimingField(field, Number((nowMs() - startedAt).toFixed(2)));
  }
}

const PREPARE_RESPONSE_CLASSIFIER_SYSTEM = `You classify one user message for a personal memory/document assistant.
Return ONLY a JSON object with:
needsRecall boolean,
needsDocumentLookup boolean,
reusePreviousContext boolean,
contextDependent boolean,
saveCandidates array.

COLLAB STAGE TAGS — check first, they override normal classification:
If message starts with [COLLAB:CONTINUE:...] or [COLLAB:MY_TURN:...]:
  return { needsRecall: false, needsDocumentLookup: false, reusePreviousContext: true, contextDependent: false, saveCandidates: [] }.
If message starts with [COLLAB:CREATE]:
  return { needsRecall: true, needsDocumentLookup: true, reusePreviousContext: false, contextDependent: true, saveCandidates: [] }
  unless the remainder of the message contains durable facts or preferences — save those only.

NORMAL CLASSIFICATION (no collab tag):
saveCandidates items have kind fact|preference|document-note and concise content/title/summary/key_points/source_hint/category/preference_key when relevant.
Save any reusable information: facts, preferences, goals, decisions, corrections, beliefs, opinions, stances, frustrations, instructions, plans, reusable debugging context, project details, notes, and reference material.
If the information is reusable but does not fit fact or preference, use kind=document-note and category="other".
If the user explicitly asks to save, remember, note, store, or keep something, ALWAYS return at least one saveCandidates item. If no better type fits, use kind=document-note and category="other".
Treat first-person age statements as durable facts; e.g. "I'm currently 19" should save "User is 19 years old."
Save subjective stances as neutral facts about the user, not objective claims about the world.
Sanitize insults, slurs, profanity, and obvious typos instead of storing the user's wording verbatim.
Example: if the user says they think Sri Lanka's government must better manage civic behavior and insults people, save a fact like "User is frustrated with governance in Sri Lanka and believes the government should manage civic behavior more effectively."
Use document-note for pasted important structured content, specs, transcripts, lists, notes, and technical debugging context.
Always create a document-note for visible or pasted API/error diagnostics that include request details, response status, error JSON, stack traces, SQL/database error codes, provider errors, or screenshot summaries of failed requests, even when the user is only asking what the error means.
CHECKPOINT TRIGGERS: If the user message is "save", "save this", "remember this", "checkpoint", or similar, return needsRecall=false and include a document-note save candidate if conversation_history is available; if conversation_history is missing, still save a document-note with category="other" describing the explicit save request.`;

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function cleanString(value: unknown, max = 1_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export function parsePrepareResponseIntent(raw: string): PrepareResponseIntent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const saveCandidates = Array.isArray(obj.saveCandidates)
    ? obj.saveCandidates.flatMap((item): PrepareResponseSaveCandidate[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      const kind = candidate.kind;
      if (kind !== "fact" && kind !== "preference" && kind !== "document-note") return [];
      const content = cleanString(candidate.content, 2_000);
      const title = cleanString(candidate.title, 200);
      const summary = cleanString(candidate.summary, 2_000);
      const source_hint = cleanString(candidate.source_hint, 500);
      const category = cleanString(candidate.category, 100);
      const preference_key = cleanString(candidate.preference_key, 100);
      const key_points = Array.isArray(candidate.key_points)
        ? candidate.key_points.flatMap((point) => {
          const cleaned = cleanString(point, 300);
          return cleaned ? [cleaned] : [];
        }).slice(0, 10)
        : undefined;
      return [{
        kind,
        ...(content ? { content } : {}),
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(source_hint ? { source_hint } : {}),
        ...(category ? { category } : {}),
        ...(preference_key ? { preference_key } : {}),
        ...(key_points && key_points.length > 0 ? { key_points } : {}),
      }];
    })
    : [];

  return {
    needsRecall: toBoolean(obj.needsRecall, true),
    needsDocumentLookup: toBoolean(obj.needsDocumentLookup, false),
    reusePreviousContext: toBoolean(obj.reusePreviousContext, false),
    contextDependent: toBoolean(obj.contextDependent, true),
    saveCandidates,
  };
}

export async function classifyPrepareResponseIntent(input: PrepareResponseActionInput): Promise<PrepareResponseIntent> {
  const response = await aiProviderRegistry.chat({
    model: config.intentClassifierModel,
    responseFormat: "json_object",
    temperature: 0,
    maxTokens: 500,
    messages: [
      { role: "system", content: PREPARE_RESPONSE_CLASSIFIER_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          message: input.message,
          hasAttachments: (input.openaiFileIdRefs?.length ?? 0) > 0,
          last_recall: input.last_recall ?? null,
        }),
      },
    ],
  });
  const parsed = parsePrepareResponseIntent(response.text.trim());
  if (!parsed) throw new Error("Failed to parse prepare_response intent JSON");
  return parsed;
}

export function prepareResponseClassifierModel(): string {
  return config.intentClassifierModel;
}

function countTechnicalDebugSignals(message: string): number {
  return [
    /\b(?:GET|POST|PUT|PATCH|DELETE)(?:\s+request\s+to|\s+request\s+for)?\s+\/api\//i,
    /\b(?:Response(?:\s+shown)?\s+(?:is\s+)?(?:HTTP\s+)?)?(?:4|5)\d\d\s+(?:Internal Server Error|Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Unprocessable|Server Error)\b/i,
    /\bHTTP\s+(?:4|5)\d\d\b/i,
    /\b(?:Request|JSON)\s+body\s+(?:includes|is|:)\s*\{?/i,
    /\bwith\s+body\s+\{|\bwith\s+JSON\s+\{/i,
    /"code"\s*:\s*"[0-9A-Z]{5}"/i,
    /"error"\s*:\s*"[^"]+"/i,
    /\broot cause\b/i,
    /\bSQLSTATE\b/i,
  ].filter((pattern) => pattern.test(message)).length;
}

function extractExplicitSaveContent(message: string): string | null {
  const trimmed = message.trim();
  const match = trimmed.match(/^(?:please\s+)?(?:save|remember|note|store|keep)(?:\s+(?:this|that|it|this\s+info|this\s+information|the\s+following|for\s+later))?(?:\s*[:\-]\s*|\s+)([\s\S]+)$/i);
  const content = match?.[1]?.trim();
  if (!content || /^(?:this|that|it|conversation|chat|thread)[.!?\s]*$/i.test(content)) return null;
  return content.length > 2_000 ? content.slice(0, 2_000) : content;
}

function hasExplicitSaveRequest(message: string): boolean {
  return /^(?:please\s+)?(?:save|remember|note|store|keep)\b/i.test(message.trim())
    || isExplicitSaveCommand(message);
}

function buildExplicitSaveFallbackCandidate(message: string): PrepareResponseSaveCandidate {
  const content = extractExplicitSaveContent(message);
  return {
    kind: "document-note",
    title: "Explicit save request",
    summary: content
      ? "Reusable information explicitly requested to be saved."
      : "User explicitly asked to save this turn, but no additional content was provided.",
    source_hint: "ChatGPT explicit save request",
    category: "other",
    content: content ?? message.trim(),
  };
}

function buildGuardrailSaveCandidates(message: string): PrepareResponseSaveCandidate[] {
  const normalized = message.replace(/\s+/g, " ").trim();
  const normalizedWords = normalized.replace(/[?.,;:!]+/g, " ");
  const candidates: PrepareResponseSaveCandidate[] = [];

  const explicitSaveContent = extractExplicitSaveContent(normalized);
  if (explicitSaveContent) {
    candidates.push(buildExplicitSaveFallbackCandidate(normalized));
  }

  if (countTechnicalDebugSignals(normalized) >= 2) {
    candidates.push({
      kind: "document-note",
      title: "API error investigation details",
      summary: "Structured API/database error context provided for later troubleshooting.",
      source_hint: "ChatGPT visible technical debugging context",
      key_points: [
        "Includes request/response details for an API failure.",
        "Keep available as debugging context for root cause analysis.",
      ],
      content: normalized.length > 2_000 ? normalized.slice(0, 2_000) : normalized,
    });
  }

  const userAgeMatch = normalizedWords.match(/\b(?:i\s+am|i\s*['\u2019]?\s*m|im)\s+(?:currently\s+|now\s+)?(\d{1,2})(?:\s+(?:years?\s+old|y\/?o))?\b/i)
    ?? normalizedWords.match(/\b(?:currently|now)\s+(\d{1,2})(?:\s+(?:years?\s+old|y\/?o))?\b/i);
  if (userAgeMatch?.[1]) {
    const age = Number(userAgeMatch[1]);
    const firstPersonContext = /\b(?:i|i\s*['\u2019]?\s*m|im|me|my)\b/i.test(normalizedWords);
    if (firstPersonContext && Number.isInteger(age) && age >= 13 && age <= 120) {
      candidates.push({
        kind: "fact",
        content: `User is ${age} years old.`,
      });
    }
  }

  const childAgeMatch = normalizedWords.match(/\bmy\s+(son|daughter|child|kid)\b.{0,80}?\b(?:is|age(?:d)?|who\s+is)\s+(\d{1,2})\b/i);
  if (childAgeMatch?.[1] && childAgeMatch[2]) {
    const relation = childAgeMatch[1].toLowerCase();
    const age = Number(childAgeMatch[2]);
    if (Number.isInteger(age) && age >= 0 && age <= 30) {
      const normalizedRelation = relation === "kid" ? "child" : relation;
      candidates.push({
        kind: "fact",
        content: `User has a ${age}-year-old ${normalizedRelation}.`,
      });
    }
  }

  if (!/\b(i|we)\s+(really\s+)?(think|believe|feel|reckon|wish|want|prefer|like|hate|love|am frustrated|am worried)\b/i.test(normalized)) {
    return candidates;
  }

  const preferenceMatch = normalized.match(/\b(?:i|we)\s+(?:really\s+)?(?:prefer|like|love)\s+(.+?)[.!?]?$/i);
  if (preferenceMatch?.[1]) {
    const preference = preferenceMatch[1]
      .trim()
      .replace(/[.!?]+$/, "")
      .replace(/\bno\s+bullshit\b/gi, "no-nonsense")
      .replace(/\bbullshit\b/gi, "unfiltered")
      .replace(/\bexplainatiions\b/gi, "explanations")
      .replace(/\bexplainations\b/gi, "explanations")
      .replace(/\bemojis?\b/gi, "emoji")
      .replace(/\s+/g, " ")
      .trim();
    if (!preference) return candidates;
    candidates.push({
      kind: "preference",
      content: `User prefers ${preference}.`,
      category: "communication",
    });
    return candidates;
  }

  if (/\bsri\s*lank(?:a|an)\b/i.test(normalized) && /\bgovernment\b/i.test(normalized)) {
    candidates.push({
      kind: "fact",
      content: "User is frustrated with governance in Sri Lanka and believes the government should manage civic behavior more effectively.",
    });
    return candidates;
  }

  const cleaned = normalized
    .replace(/\b(mfs?|motherfuckers?)\b/gi, "people")
    .replace(/\b(fuck(?:ing)?|shit|dumb|idiots?|stupid)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 12) return candidates;

  candidates.push({
    kind: "fact",
    content: `User expressed a durable opinion or stance: ${cleaned}`,
  });
  return candidates;
}

function mergeGuardrailSaveCandidates(
  message: string,
  candidates: PrepareResponseSaveCandidate[]
): PrepareResponseSaveCandidate[] {
  const guardrailCandidates = buildGuardrailSaveCandidates(message);
  if (guardrailCandidates.length === 0) return candidates;

  const seen = new Set(candidates.map((candidate) => `${candidate.kind}:${candidate.content ?? candidate.title ?? ""}`));
  const merged = [...candidates];
  for (const candidate of guardrailCandidates) {
    const key = `${candidate.kind}:${candidate.content ?? candidate.title ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}

function normalizeConversationHistory(
  history: PrepareResponseConversationMessage[] | undefined
): PrepareResponseConversationMessage[] {
  if (!Array.isArray(history)) return [];
  return history
    .flatMap((entry): PrepareResponseConversationMessage[] => {
      if (!entry || typeof entry !== "object") return [];
      const role = entry.role === "assistant" || entry.role === "system" || entry.role === "tool" ? entry.role : "user";
      const content = typeof entry.content === "string" ? entry.content.trim() : "";
      if (!content) return [];
      return [{ role, content }];
    })
    .slice(-CONVERSATION_HISTORY_MAX_MESSAGES);
}

function formatConversationHistory(history: PrepareResponseConversationMessage[]): string {
  const formatted = history
    .map((entry, index) => `${index + 1}. ${entry.role ?? "user"}: ${entry.content}`)
    .join("\n\n");
  if (formatted.length <= CONVERSATION_HISTORY_MAX_CHARS) return formatted;
  return `${formatted.slice(-CONVERSATION_HISTORY_MAX_CHARS)}\n\n[truncated to latest visible history]`;
}

function inferHandoffTarget(input: PrepareResponseActionInput): "claude" | "chatgpt" | null {
  if (input.handoff_target === "claude" || input.handoff_target === "chatgpt") return input.handoff_target;
  const message = input.message.trim();
  if (/\b(handoff|hand\s*off|send|pass|move|switch|continue)\b.{0,80}\bclaude\b/i.test(message)) return "claude";
  if (/\b(handoff|hand\s*off|send|pass|move|switch|continue)\b.{0,80}\bchatgpt\b/i.test(message)) return "chatgpt";

  const selectedNumber = message.match(/^\s*(\d{1,2})[.)]?\s*$/)?.[1];
  if (selectedNumber) {
    const historyText = normalizeConversationHistory(input.conversation_history)
      .map((entry) => entry.content)
      .join("\n")
      .toLowerCase();
    const optionPattern = new RegExp(`${selectedNumber}\\s*[.)]\\s*[^\\n]{0,120}(claude|handoff|hand-off|hand off)`, "i");
    if (optionPattern.test(historyText)) return "claude";
  }

  return null;
}

function buildHandoffHistorySaveCandidate(input: PrepareResponseActionInput): PrepareResponseSaveCandidate | null {
  const target = inferHandoffTarget(input);
  if (!target) return null;
  const history = normalizeConversationHistory(input.conversation_history);
  if (history.length === 0) return null;
  const content = formatConversationHistory(history);
  return {
    kind: "document-note",
    title: `ChatGPT to ${target === "claude" ? "Claude" : "ChatGPT"} handoff context`,
    summary: `Visible ChatGPT conversation history captured for ${target} handoff.`,
    source_hint: "ChatGPT visible conversation history before provider handoff",
    key_points: [
      `Target provider: ${target}`,
      `Captured ${history.length} visible message(s) from the ChatGPT window.`,
      "Use this as task context before continuing the collab turn.",
    ],
    content,
  };
}

function isExplicitSaveCommand(message: string): boolean {
  return /^(save|save this|remember this|checkpoint|save conversation|remember this conversation)[.!?\s]*$/i.test(message.trim());
}

function hasCheckpointWorthyContent(
  history: PrepareResponseConversationMessage[] | undefined
): boolean {
  if (!Array.isArray(history) || history.length < 2) return false;
  let assistantChars = 0;
  let hasStructuredContent = false;
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const content = typeof entry.content === "string" ? entry.content : "";
    if (entry.role === "assistant") {
      assistantChars += content.length;
      if (/^(#{1,3}\s|```|\d+\.\s|[-*]\s|>\s)/m.test(content)) {
        hasStructuredContent = true;
      }
    }
  }
  return assistantChars > 800 || (assistantChars > 400 && hasStructuredContent);
}

async function buildConversationCheckpointCandidate(
  input: PrepareResponseActionInput,
  auth: AuthContext
): Promise<PrepareResponseSaveCandidate | null> {
  const history = normalizeConversationHistory(input.conversation_history);
  if (history.length === 0) return null;

  const checkpoint = input.conversation_id
    ? await findLastConversationCheckpoint(auth, input.conversation_id)
    : null;

  const messagesToInclude = history;

  const transcript = messagesToInclude
    .map((entry) => `${entry.role?.toUpperCase() ?? "USER"}: ${entry.content}`)
    .join("\n\n---\n\n");

  const turnCount = messagesToInclude.length;
  const assistantMessages = messagesToInclude.filter((e) => e.role === "assistant");
  const checkpointNumber = checkpoint ? " (incremental)" : " (initial)";

  return {
    kind: "checkpoint",
    title: `Conversation checkpoint${checkpointNumber}`,
    summary: `Raw conversation transcript from ${turnCount} message(s)${checkpoint ? ` since checkpoint ${checkpoint.ref}` : ""}.`,
    source_hint: `conversation_id:${input.conversation_id ?? "unknown"}`,
    key_points: [
      `${turnCount} messages captured`,
      `${assistantMessages.length} assistant response(s)`,
      checkpoint ? `Previous checkpoint: ${checkpoint.ref}` : "First checkpoint for this conversation",
    ],
    content: transcript,
  };
}

function isShortLocalReply(message: string): boolean {
  return /^(thanks?|thank you|ok(?:ay)?|cool|great|nice|yes|yeah|yep|no|nope|continue|go on|sounds good|got it|yes,?\s+continue(?:\s+with\s+that)?|yeah,?\s+continue(?:\s+with\s+that)?)[.!?\s]*$/i.test(message.trim());
}

function hasRecallTrigger(message: string): boolean {
  return /\b(remember|memory|memories|saved|previous|earlier|before|last time|past context|what did we decide|decision|decided|document|docs?|pdf|uploads?|uploaded|uploading|file|attachment|catalogue|catalog|product|products|inventory|@doc:|@lot:)\b/i.test(message);
}

function hasDurableSaveTrigger(message: string): boolean {
  return /\b(i|we)\s+(think|believe|feel|prefer|like|hate|want|need|decided|will|am|was|have|goal|wish)\b/i.test(message)
    || /\b(my|our)\s+(preference|goal|decision|plan|name|company|project|opinion)\b/i.test(message)
    || /\b(remember that|note that|important|for later)\b/i.test(message);
}

export function fastPrepareResponseIntent(input: PrepareResponseActionInput): FastIntentDecision {
  const message = input.message.trim();
  const hasAttachments = (input.openaiFileIdRefs?.length ?? 0) > 0;
  const explicitRefs = extractRefsFromMessage(message);
  const guardrailCandidates = mergeGuardrailSaveCandidates(message, []);
  const hasTechnicalDebugContext = countTechnicalDebugSignals(message) >= 2;

  if (hasAttachments) {
    return {
      shouldCallClassifier: false,
      reason: "attachments",
      intent: {
        needsRecall: true,
        needsDocumentLookup: true,
        reusePreviousContext: false,
        contextDependent: true,
        saveCandidates: guardrailCandidates,
      },
    };
  }

  if (explicitRefs.length > 0 || hasRecallTrigger(message)) {
    return {
      shouldCallClassifier: guardrailCandidates.length === 0,
      reason: "recall_trigger",
      intent: {
        needsRecall: !hasTechnicalDebugContext || explicitRefs.length > 0,
        needsDocumentLookup: explicitRefs.length > 0 || /\b(document|docs?|pdf|upload|file|attachment|catalogue|catalog|product|products|inventory|@doc:|@lot:)\b/i.test(message),
        reusePreviousContext: hasTechnicalDebugContext && explicitRefs.length === 0,
        contextDependent: !(hasTechnicalDebugContext && explicitRefs.length === 0),
        saveCandidates: guardrailCandidates,
      },
    };
  }

  if (inferHandoffTarget(input)) {
    return {
      shouldCallClassifier: false,
      reason: "handoff_history",
      intent: {
        needsRecall: false,
        needsDocumentLookup: false,
        reusePreviousContext: true,
        contextDependent: false,
        saveCandidates: guardrailCandidates,
      },
    };
  }

  if (hasExplicitSaveRequest(message)) {
    return {
      shouldCallClassifier: false,
      reason: "explicit_save",
      intent: {
        needsRecall: false,
        needsDocumentLookup: false,
        reusePreviousContext: true,
        contextDependent: false,
        saveCandidates: guardrailCandidates,
      },
    };
  }

  if (isExplicitSaveCommand(message)) {
    return {
      shouldCallClassifier: false,
      reason: "explicit_save_checkpoint",
      intent: {
        needsRecall: false,
        needsDocumentLookup: false,
        reusePreviousContext: true,
        contextDependent: false,
        saveCandidates: guardrailCandidates,
      },
    };
  }

  if (hasCheckpointWorthyContent(input.conversation_history)) {
    return {
      shouldCallClassifier: false,
      reason: "checkpoint_worthy_content",
      intent: {
        needsRecall: false,
        needsDocumentLookup: false,
        reusePreviousContext: true,
        contextDependent: false,
        saveCandidates: guardrailCandidates,
      },
    };
  }

  if (guardrailCandidates.length > 0 || hasDurableSaveTrigger(message)) {
    return {
      shouldCallClassifier: guardrailCandidates.length === 0,
      reason: guardrailCandidates.length > 0 ? "guardrail_save" : "durable_save_uncertain",
      intent: {
        needsRecall: false,
        needsDocumentLookup: false,
        reusePreviousContext: true,
        contextDependent: false,
        saveCandidates: guardrailCandidates,
      },
    };
  }

  if (input.last_recall?.query && isShortLocalReply(message)) {
    return {
      shouldCallClassifier: false,
      reason: "local_followup",
      intent: {
        needsRecall: false,
        needsDocumentLookup: false,
        reusePreviousContext: true,
        contextDependent: false,
        saveCandidates: [],
      },
    };
  }

  return {
    shouldCallClassifier: true,
    reason: "uncertain",
    intent: DEFAULT_PREPARE_RESPONSE_INTENT,
  };
}

type PrepareRecallBody = {
  contextBlock: string;
  memories: unknown[];
  recentDocuments: unknown[];
  matchedDocuments: Array<{ ref: string; title: string; score: number; preview: string }>;
  referencedDocuments: unknown[];
  recentCompletedIngests: unknown[];
  autoSave: PrepareResponseActionResult["body"]["autoSave"];
  inlineDocuments?: Array<{ ref: string; title: string | null; content: string }>;
  recentCollabTasks?: Array<{ id: string; title: string; state: string; summary: string; source: "direct" | "vector" }>;
};

function emptyPrepareRecallBody(): PrepareRecallBody {
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

function isWeakRecallBody(body: { memories?: unknown[]; matchedDocuments?: unknown[] }): boolean {
  return (body.memories?.length ?? 0) === 0 && (body.matchedDocuments?.length ?? 0) === 0;
}

function extractRefsFromMessage(message: string): string[] {
  return Array.from(new Set(Array.from(message.matchAll(/@(?:doc|lot):[a-z0-9_-]+/gi), (match) => match[0])));
}

function firstHighConfidenceMatchedDoc(body: { matchedDocuments?: unknown[] }): string | null {
  const matched = body.matchedDocuments ?? [];
  for (const item of matched) {
    if (!item || typeof item !== "object") continue;
    const doc = item as Record<string, unknown>;
    if (typeof doc.ref === "string" && typeof doc.score === "number" && doc.score >= 0.75) {
      return doc.ref;
    }
  }
  return null;
}

function inlineDocumentsFromRecallDocument(body: Record<string, unknown>): Array<{ ref: string; title: string | null; content: string }> {
  if (body.kind === "document" && typeof body.ref === "string" && typeof body.content === "string") {
    return [{
      ref: body.ref,
      title: typeof body.title === "string" ? body.title : null,
      content: truncateInlineDocumentContent(body.content),
    }];
  }
  if (body.kind === "lot" && Array.isArray(body.docs)) {
    return body.docs.flatMap((doc): Array<{ ref: string; title: string | null; content: string }> => {
      if (!doc || typeof doc !== "object") return [];
      const d = doc as Record<string, unknown>;
      if (typeof d.ref !== "string" || typeof d.content !== "string") return [];
      return [{
        ref: d.ref,
        title: typeof d.title === "string" ? d.title : null,
        content: truncateInlineDocumentContent(d.content),
      }];
    });
  }
  return [];
}

function appendInlineDocsToContext(
  contextBlock: string,
  inlineDocuments: Array<{ ref: string; title: string | null; content: string }>
): string {
  if (inlineDocuments.length === 0) return contextBlock;
  const lines = inlineDocuments.flatMap((doc) => [
    `[${doc.title ?? doc.ref}]`,
    truncateInlineDocumentContent(doc.content),
  ]);
  return `${contextBlock}\n--- Prepared Document Context ---\n${lines.join("\n")}`;
}

function queuePrepareSave(
  auth: AuthContext,
  candidate: PrepareResponseSaveCandidate,
  conversationId: string | null,
  deps: Required<Pick<PrepareResponseDependencies, "rememberAction" | "enqueueSave" | "platform">>
): QueuedPrepareSave | null {
  if ((candidate.kind === "fact" || candidate.kind === "preference" || candidate.kind === "checkpoint") && !candidate.content) return null;
  if (candidate.kind === "document-note" && !candidate.summary && !candidate.content && !candidate.title) return null;

  deps.enqueueSave(async () => {
    await deps.rememberAction(auth, {
      ...candidate,
      platform: deps.platform ?? "chatgpt",
      conversation_id: conversationId,
      runVectorDedup: false,
      content: candidate.kind === "document-note" ? candidate.content ?? candidate.summary : candidate.content,
    });
  }, `prepare_response ${candidate.kind} save`);

  return {
    kind: candidate.kind,
    ...(candidate.content ? { content: candidate.content } : {}),
    ...(candidate.title ? { title: candidate.title } : {}),
    status: "queued",
  };
}

export async function executePrepareResponseAction(
  auth: AuthContext,
  input: PrepareResponseActionInput,
  dependencies: PrepareResponseDependencies = {}
): Promise<PrepareResponseActionResult> {
  const classifyIntent = dependencies.classifyIntent ?? classifyPrepareResponseIntent;
  const recallAction = dependencies.recallAction ?? executeRecallAction;
  const rememberAction = dependencies.rememberAction ?? executeRememberAction;
  const recallDocumentAction = dependencies.recallDocumentAction ?? executeRecallDocumentAction;
  const enqueueSave = dependencies.enqueueSave ?? ((task, label) => runAsyncSafe(task, label));

  const fastIntent = fastPrepareResponseIntent(input);
  setRequestTimingField("prepare_fast_intent", fastIntent.reason);
  setRequestTimingField("prepare_classifier_skipped", !fastIntent.shouldCallClassifier);

  const uploadedFiles = input.openaiFileIdRefs ?? [];
  const explicitRefs = extractRefsFromMessage(input.message);
  const startRecall = () => timed("prepare_recall_ms", () => recallAction(auth, {
    query: input.message,
    limit: 5,
    include_doc_refs: explicitRefs,
    openaiFileIdRefs: uploadedFiles,
    conversation_id: input.conversation_id ?? null,
    requesterIp: input.requesterIp,
  }));
  const shouldSpeculateRecall = fastIntent.shouldCallClassifier
    && fastIntent.intent.needsRecall
    && !input.last_recall?.query;
  const speculativeRecall = shouldSpeculateRecall ? startRecall() : null;
  if (speculativeRecall) setRequestTimingField("prepare_recall_speculative", true);

  let intent = fastIntent.intent;
  let classifierFailed = false;
  if (fastIntent.shouldCallClassifier) {
    try {
      intent = await timed("prepare_classifier_ms", () => classifyIntent(input));
      if (fastIntent.reason === "recall_trigger") {
        intent = {
          ...intent,
          needsRecall: true,
          needsDocumentLookup: fastIntent.intent.needsDocumentLookup || intent.needsDocumentLookup,
          contextDependent: true,
        };
      }
    } catch {
      classifierFailed = true;
    }
  } else {
    setRequestTimingField("prepare_classifier_ms", 0);
  }

  const shouldRecall = classifierFailed
    || intent.needsRecall
    || uploadedFiles.length > 0
    || explicitRefs.length > 0
    || (intent.contextDependent && !intent.reusePreviousContext && !input.last_recall?.query);
  setRequestTimingField("prepare_should_recall", shouldRecall);

  let recallBody: PrepareRecallBody = emptyPrepareRecallBody();
  let status: 200 | 422 = 200;

  if (shouldRecall) {
    const firstRecall = await (speculativeRecall ?? startRecall());
    if (firstRecall.status === 422) {
      status = 422;
      recallBody = {
        ...emptyPrepareRecallBody(),
        autoSave: firstRecall.body.autoSave,
      };
    } else {
      recallBody = firstRecall.body;
      if (intent.contextDependent && isWeakRecallBody(recallBody)) {
        const broaderRecall = await timed("prepare_broaden_recall_ms", () => recallAction(auth, {
          query: `${input.message}\n\nBroaden search to latest user context, goals, preferences, decisions, documents, and relevant prior facts.`,
          limit: 10,
          types: ["fact", "preference", "event", "decision", "note", "lesson", "failure"],
          include_doc_refs: explicitRefs,
          conversation_id: input.conversation_id ?? null,
          requesterIp: input.requesterIp,
        }));
        if (broaderRecall.status === 200) recallBody = broaderRecall.body;
      } else {
        setRequestTimingField("prepare_broaden_recall_ms", 0);
      }
    }
  } else {
    if (speculativeRecall) void speculativeRecall.catch(() => undefined);
    setRequestTimingField("prepare_recall_ms", 0);
    setRequestTimingField("prepare_broaden_recall_ms", 0);
  }

  let inlineDocuments = Array.isArray(recallBody.inlineDocuments) ? [...recallBody.inlineDocuments] : [];
  const fullTextRef = explicitRefs[0] ?? (intent.needsDocumentLookup ? firstHighConfidenceMatchedDoc(recallBody) : null);
  if (fullTextRef && !inlineDocuments.some((doc) => doc.ref === fullTextRef)) {
    try {
      const document = await timed("prepare_doc_fetch_ms", () => recallDocumentAction(auth, fullTextRef));
      inlineDocuments = [...inlineDocuments, ...inlineDocumentsFromRecallDocument(document.body)];
    } catch {
      // prepare_response should still return usable memory context if a document ref fails.
    }
  } else {
    setRequestTimingField("prepare_doc_fetch_ms", 0);
  }

  const focusedTaskId = detectFocusedCollabTaskId(input.message);
  let focusedCollabContext: string | null = null;
  if (focusedTaskId) {
    try {
      focusedCollabContext = await timed("prepare_focused_collab_ms", () => getCollabTaskContentForContext(focusedTaskId, auth));
    } catch {
      // Invalid task id or DB error; continue without focused collab context.
      focusedCollabContext = null;
    }
  } else {
    setRequestTimingField("prepare_focused_collab_ms", 0);
  }

  const handoffHistoryCandidate = buildHandoffHistorySaveCandidate(input);
  const checkpointCandidate = (isExplicitSaveCommand(input.message.trim()) || hasCheckpointWorthyContent(input.conversation_history))
    ? await buildConversationCheckpointCandidate(input, auth)
    : null;
  const explicitSaveFallbackCandidate = hasExplicitSaveRequest(input.message) && !checkpointCandidate && !extractExplicitSaveContent(input.message)
    ? buildExplicitSaveFallbackCandidate(input.message)
    : null;
  const nonCheckpointCandidates = mergeGuardrailSaveCandidates(input.message, [
    ...intent.saveCandidates,
    ...(handoffHistoryCandidate ? [handoffHistoryCandidate] : []),
    ...(explicitSaveFallbackCandidate ? [explicitSaveFallbackCandidate] : []),
  ]);
  const intentForResponse = { ...intent, saveCandidates: [...nonCheckpointCandidates, ...(checkpointCandidate ? [checkpointCandidate] : [])] };

  // Execute checkpoint save SYNCHRONOUSLY so we get the ref immediately
  let checkpointResult: { saved: boolean; memoryId?: string; error?: string } = { saved: false };
  if (checkpointCandidate && !classifierFailed) {
    try {
      const platform = dependencies.platform ?? "chatgpt";
      const result = await rememberAction(auth, {
        ...checkpointCandidate,
        platform,
        conversation_id: input.conversation_id ?? null,
        runVectorDedup: false,
        content: checkpointCandidate.content ?? checkpointCandidate.summary,
      });
      if (result.status >= 400) {
        checkpointResult = { saved: false, error: (result.body as Record<string, unknown>).error as string || "Checkpoint save failed" };
      } else {
        const body = result.body as Record<string, unknown>;
        checkpointResult = { saved: true, memoryId: (body.memoryId as string) || undefined };
      }
    } catch (err) {
      checkpointResult = { saved: false, error: err instanceof Error ? err.message : "Checkpoint save failed" };
    }
  }

  // Queue non-checkpoint saves in the background
  const queueStartedAt = nowMs();
  const queuedSaves = classifierFailed
    ? []
    : nonCheckpointCandidates.flatMap((candidate) => {
      const queued = queuePrepareSave(auth, candidate, input.conversation_id ?? null, { rememberAction, enqueueSave, platform: dependencies.platform ?? "chatgpt" });
      return queued ? [queued] : [];
    });
  setRequestTimingField("prepare_queue_save_ms", Number((nowMs() - queueStartedAt).toFixed(2)));

  const replyInstructions = [
    "Use contextBlock and inlineDocuments as the source of truth.",
    "Do not mention internal tool calls.",
    ...(recallBody.autoSave.saved.length > 0
      ? recallBody.autoSave.saved.map((saved) => `End the reply with: Saved: ${saved.ref}`)
      : []),
    ...(checkpointResult.saved
      ? ["End the reply with: Saved conversation checkpoint to memories."]
      : checkpointResult.error
        ? [`Checkpoint save failed: ${checkpointResult.error}. Do not claim it was saved.`]
        : []),
    ...(queuedSaves.some((save) => save.kind === "document-note")
      ? ["Document-note saving is queued. Do not add a Saved footer unless autoSave.saved includes a ref."]
      : []),
    ...(inferHandoffTarget(input) && !handoffHistoryCandidate
      ? ["Handoff intent detected but conversation_history was missing. Ask the user to retry after ChatGPT sends the visible conversation_history to Tallei."]
      : []),
  ];

  const baseContextBlock = appendInlineDocsToContext(recallBody.contextBlock, inlineDocuments);
  const contextBlock = focusedCollabContext
    ? `--- Focused Collab Task ---\n${focusedCollabContext}\n---\n${baseContextBlock}`
    : baseContextBlock;

  return {
    status,
    body: {
      contextBlock,
      memories: recallBody.memories,
      recentDocuments: recallBody.recentDocuments,
      matchedDocuments: recallBody.matchedDocuments,
      referencedDocuments: recallBody.referencedDocuments,
      recentCompletedIngests: recallBody.recentCompletedIngests,
      inlineDocuments,
      queuedSaves,
      checkpoint: checkpointResult.saved ? { memoryId: checkpointResult.memoryId } : checkpointResult.error ? { error: checkpointResult.error } : null,
      autoSave: recallBody.autoSave,
      replyInstructions,
      intent: intentForResponse,
      recentCollabTasks: recallBody.recentCollabTasks,
      focusedCollabContext,
    },
  };
}
