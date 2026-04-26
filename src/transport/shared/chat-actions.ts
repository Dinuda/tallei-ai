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

export type MemoryTypeInput = "preference" | "fact" | "event" | "decision" | "note" | "lesson" | "failure";
export type RememberKindInput = "fact" | "preference" | "document-note" | "document-blob";

export type PrepareResponseSaveCandidate = {
  kind: "fact" | "preference" | "document-note";
  content?: string;
  title?: string;
  key_points?: string[];
  summary?: string;
  source_hint?: string;
  category?: string;
  preference_key?: string;
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
const INLINE_DOCUMENT_MAX_CHARS = 4_000;
const DOC_BRIEF_PREVIEW_MAX_CHARS = 200;
const MEMORY_TEXT_MAX_CHARS = 600;

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
  };
}

type PrepareResponseDependencies = {
  classifyIntent?: (input: PrepareResponseActionInput) => Promise<PrepareResponseIntent>;
  recallAction?: typeof executeRecallAction;
  rememberAction?: typeof executeRememberAction;
  recallDocumentAction?: typeof executeRecallDocumentAction;
  enqueueSave?: (task: () => Promise<void>, label: string) => void;
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
saveCandidates items have kind fact|preference|document-note and concise content/title/summary/key_points/source_hint/category/preference_key when relevant.
Mark durable facts, preferences, goals, decisions, corrections, beliefs, opinions, stances, frustrations, and important notes worth remembering.
Treat first-person age statements as durable facts; e.g. "I'm currently 19" should save "User is 19 years old."
Save subjective stances as neutral facts about the user, not objective claims about the world.
Sanitize insults, slurs, profanity, and obvious typos instead of storing the user's wording verbatim.
Example: if the user says they think Sri Lanka's government must better manage civic behavior and insults people, save a fact like "User is frustrated with governance in Sri Lanka and believes the government should manage civic behavior more effectively."
Use document-note for pasted important structured content, specs, transcripts, lists, or notes.`;

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

function buildGuardrailSaveCandidates(message: string): PrepareResponseSaveCandidate[] {
  const normalized = message.replace(/\s+/g, " ").trim();
  const normalizedWords = normalized.replace(/[?.,;:!]+/g, " ");
  const candidates: PrepareResponseSaveCandidate[] = [];

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

  if (!/\b(i|we)\s+(really\s+)?(think|believe|feel|reckon|wish|want|prefer|hate|love|am frustrated|am worried)\b/i.test(normalized)) {
    return candidates;
  }

  const preferenceMatch = normalized.match(/\b(?:i|we)\s+(?:really\s+)?prefer\s+(.+?)[.!?]?$/i);
  if (preferenceMatch?.[1]) {
    candidates.push({
      kind: "preference",
      content: `User prefers ${preferenceMatch[1].trim().replace(/[.!?]+$/, "")}.`,
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

function isShortLocalReply(message: string): boolean {
  return /^(thanks?|thank you|ok(?:ay)?|cool|great|nice|yes|yeah|yep|no|nope|continue|go on|sounds good|got it|yes,?\s+continue(?:\s+with\s+that)?|yeah,?\s+continue(?:\s+with\s+that)?)[.!?\s]*$/i.test(message.trim());
}

function hasRecallTrigger(message: string): boolean {
  return /\b(remember|memory|memories|saved|previous|earlier|before|last time|past context|what did we decide|decision|decided|document|docs?|pdf|upload|file|attachment|catalogue|catalog|product|products|inventory|@doc:|@lot:)\b/i.test(message);
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
      shouldCallClassifier: false,
      reason: "recall_trigger",
      intent: {
        needsRecall: true,
        needsDocumentLookup: explicitRefs.length > 0 || /\b(document|docs?|pdf|upload|file|attachment|catalogue|catalog|product|products|inventory|@doc:|@lot:)\b/i.test(message),
        reusePreviousContext: false,
        contextDependent: true,
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
      content: body.content,
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
        content: d.content,
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
  deps: Required<Pick<PrepareResponseDependencies, "rememberAction" | "enqueueSave">>
): QueuedPrepareSave | null {
  if ((candidate.kind === "fact" || candidate.kind === "preference") && !candidate.content) return null;
  if (candidate.kind === "document-note" && !candidate.summary && !candidate.content && !candidate.title) return null;

  deps.enqueueSave(async () => {
    await deps.rememberAction(auth, {
      ...candidate,
      platform: "chatgpt",
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

  const saveCandidates = mergeGuardrailSaveCandidates(input.message, intent.saveCandidates);
  const intentForResponse = { ...intent, saveCandidates };

  const queueStartedAt = nowMs();
  const queuedSaves = classifierFailed
    ? []
    : saveCandidates.flatMap((candidate) => {
      const queued = queuePrepareSave(auth, candidate, input.conversation_id ?? null, { rememberAction, enqueueSave });
      return queued ? [queued] : [];
    });
  setRequestTimingField("prepare_queue_save_ms", Number((nowMs() - queueStartedAt).toFixed(2)));

  const replyInstructions = [
    "Use contextBlock and inlineDocuments as the source of truth.",
    "Do not mention internal tool calls.",
    ...(recallBody.autoSave.saved.length > 0
      ? recallBody.autoSave.saved.map((saved) => `End the reply with: Saved: ${saved.ref}`)
      : []),
    ...(queuedSaves.some((save) => save.kind === "document-note")
      ? ["Document-note saving is queued. Do not add a Saved footer unless autoSave.saved includes a ref."]
      : []),
  ];

  return {
    status,
    body: {
      contextBlock: appendInlineDocsToContext(recallBody.contextBlock, inlineDocuments),
      memories: recallBody.memories,
      recentDocuments: recallBody.recentDocuments,
      matchedDocuments: recallBody.matchedDocuments,
      inlineDocuments,
      queuedSaves,
      autoSave: recallBody.autoSave,
      replyInstructions,
      intent: intentForResponse,
    },
  };
}
