import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import { createLot, documentBriefsByRefs, recallDocument, stashDocument } from "./documents.js";
import { ingestUploadedFilesToDocuments, type UploadedFileSaveError } from "./uploaded-file-ingest.js";
import { listRecentCompletedUploadedFileIngestJobs } from "./uploaded-file-ingest-jobs.js";
import { saveMemory } from "./memory.js";
import { aiProviderRegistry } from "../providers/ai/index.js";
import { PlanRequiredError } from "../shared/errors/index.js";
import { config } from "../config/index.js";

export type CollabActor = "chatgpt" | "claude" | "user";
export type CollabModelActor = "chatgpt" | "claude";
export type CollabState = "CREATIVE" | "TECHNICAL" | "DONE" | "ERROR";
export type CollabFilter = "all" | "active" | "waiting" | "done";

export interface CollabTranscriptEntry {
  actor: CollabActor;
  iteration: number;
  content: string;
  ts: string;
}

export interface CollabTask {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  brief: string | null;
  state: CollabState;
  lastActor: CollabActor | null;
  iteration: number;
  maxIterations: number;
  context: Record<string, unknown>;
  transcript: CollabTranscriptEntry[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollabTurnFallbackContext {
  task_id: string;
  title: string;
  brief: string | null;
  state: CollabState;
  iteration: number;
  max_iterations: number;
  waiting_on: CollabModelActor | null;
  your_actor: CollabModelActor;
  last_message: CollabTranscriptEntry | null;
  last_chatgpt_entry: CollabTranscriptEntry | null;
  last_claude_entry: CollabTranscriptEntry | null;
  recent_transcript: CollabTranscriptEntry[];
  documents?: {
    lot_ref: string;
    lot_title: string | null;
    conversation_id: string | null;
    documents: Array<{
      kind: "document";
      ref: string;
      title: string;
      filename: string | null;
      status: "pending" | "ready" | "failed";
      preview: string;
      blob_url: string | null;
    }>;
  };
  orchestration?: {
    plan_summary: string;
    success_criteria: Array<{
      id: string;
      text: string;
      weight: number;
      latest_status: "pending" | "pass" | "fail" | "partial";
    }>;
    last_evaluation: CollabCriterionEvaluationEntry | null;
    instructions: string;
  };
}
export interface CollabOpenAiFileRef {
  id: string;
  name?: string;
  mime_type?: string | null;
  download_link: string;
}

interface TaskDocumentContextSnapshot {
  lotRef: string | null;
  lotTitle: string | null;
  conversationId: string | null;
  documentRefs: string[];
}

interface CollabTaskRow {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  brief: string | null;
  state: CollabState;
  last_actor: CollabActor | null;
  iteration: number;
  max_iterations: number;
  context: unknown;
  transcript: unknown;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface CachedTask {
  task: CollabTask;
  exp: number;
}

interface CollabTicketArtifact {
  title: string;
  assignee: string | null;
  due_date: string | null;
  description: string | null;
}

interface CollabArtifacts {
  prd_summary: string | null;
  tickets: CollabTicketArtifact[];
  checklist: string[];
  assignee: string | null;
  due_date: string | null;
  extracted_from_iteration: number;
  extracted_from_actor: CollabModelActor;
  extracted_at: string;
}

type CollabCriterionEvaluationStatus = "pass" | "fail" | "partial";

interface CollabCriterionEvaluation {
  criterion_id: string;
  status: CollabCriterionEvaluationStatus;
  rationale: string;
}

interface CollabCriterionEvaluationEntry {
  iteration: number;
  actor: CollabModelActor;
  ts: string;
  criterion_evaluations: CollabCriterionEvaluation[];
  should_mark_done: boolean;
  remaining_work: string;
}

const TASK_CACHE_TTL_MS = 5_000;
const taskCache = new Map<string, CachedTask>();

export class CollabConflictError extends Error {
  constructor(message = "Turn conflict") {
    super(message);
    this.name = "CollabConflictError";
  }
}

export class CollabNotFoundError extends Error {
  constructor(message = "Task not found") {
    super(message);
    this.name = "CollabNotFoundError";
  }
}

export class CollabAttachmentIngestError extends Error {
  readonly errors: UploadedFileSaveError[];

  constructor(errors: UploadedFileSaveError[]) {
    super("Failed to ingest uploaded attachments for collab task.");
    this.name = "CollabAttachmentIngestError";
    this.errors = errors;
  }
}

export function assertCollabPlan(auth: AuthContext): void {
  if (auth.plan === "pro" || auth.plan === "power") return;
  throw new PlanRequiredError(
    `Collab sessions require a Pro or Power plan on Tallei. Upgrade at ${config.dashboardBaseUrl.replace(/\/$/, "")}/billing.`
  );
}

function cacheKey(taskId: string, auth: AuthContext): string {
  return `${auth.userId}:${taskId}`;
}

function normalizeContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeTranscriptEntry(value: unknown): CollabTranscriptEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const actor = row["actor"];
  const iteration = row["iteration"];
  const content = row["content"];
  const ts = row["ts"];

  if (
    (actor !== "chatgpt" && actor !== "claude" && actor !== "user") ||
    typeof iteration !== "number" ||
    typeof content !== "string" ||
    typeof ts !== "string"
  ) {
    return null;
  }

  return { actor, iteration, content, ts };
}

function normalizeTranscript(value: unknown): CollabTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeTranscriptEntry(entry))
    .filter((entry): entry is CollabTranscriptEntry => Boolean(entry));
}

function mapTaskRow(row: CollabTaskRow): CollabTask {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    title: row.title,
    brief: row.brief,
    state: row.state,
    lastActor: row.last_actor,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    context: normalizeContext(row.context),
    transcript: normalizeTranscript(row.transcript),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readCachedTask(taskId: string, auth: AuthContext): CollabTask | null {
  const key = cacheKey(taskId, auth);
  const cached = taskCache.get(key);
  if (!cached) return null;
  if (cached.exp <= Date.now()) {
    taskCache.delete(key);
    return null;
  }
  return cached.task;
}

function writeCachedTask(task: CollabTask): void {
  const key = `${task.userId}:${task.id}`;
  taskCache.set(key, {
    task,
    exp: Date.now() + TASK_CACHE_TTL_MS,
  });
}

function invalidateCachedTask(taskId: string, auth: AuthContext): void {
  taskCache.delete(cacheKey(taskId, auth));
}

function normalizeDocRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.startsWith("@doc:") ? trimmed : null;
}

export function extractDocumentRefsFromText(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(/@doc:[A-Za-z0-9][A-Za-z0-9_-]*/g)) {
    const ref = normalizeDocRef(match[0]);
    if (ref) refs.add(ref);
  }
  return [...refs];
}

async function filterExistingDocumentRefs(
  refs: string[],
  auth: AuthContext
): Promise<{ valid: string[]; missing: string[] }> {
  if (refs.length === 0) return { valid: [], missing: [] };
  const result = await pool.query<{ ref_handle: string }>(
    `SELECT ref_handle
     FROM documents
     WHERE tenant_id = $1
       AND user_id = $2
       AND deleted_at IS NULL
       AND ref_handle = ANY($3::text[])`,
    [auth.tenantId, auth.userId, refs]
  );
  const existing = new Set(result.rows.map((row) => row.ref_handle));
  const valid = refs.filter((ref) => existing.has(ref));
  const missing = refs.filter((ref) => !existing.has(ref));
  return { valid, missing };
}

function hasStructuredContent(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 400) return false;
  const patterns = [
    /^#{1,3}\s/m,
    /^```/m,
    /^\d+\.\s/m,
    /^[-*]\s/m,
    /^\|.*\|/m,
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\//i,
  ];
  return patterns.some((pattern) => pattern.test(trimmed));
}

function readExistingTaskDocumentContext(context: Record<string, unknown>): TaskDocumentContextSnapshot {
  const documentsContext = context["documents"];
  if (!documentsContext || typeof documentsContext !== "object" || Array.isArray(documentsContext)) {
    return { lotRef: null, lotTitle: null, conversationId: null, documentRefs: [] };
  }

  const row = documentsContext as Record<string, unknown>;
  const docs = Array.isArray(row["documents"]) ? row["documents"] : [];
  const refs = docs.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const ref = normalizeDocRef((item as Record<string, unknown>)["ref"]);
    return ref ? [ref] : [];
  });

  return {
    lotRef: typeof row["lot_ref"] === "string" ? row["lot_ref"] : null,
    lotTitle: typeof row["lot_title"] === "string" ? row["lot_title"] : null,
    conversationId: typeof row["conversation_id"] === "string" ? row["conversation_id"] : null,
    documentRefs: refs,
  };
}

async function loadTaskDocumentContext(taskId: string, auth: AuthContext): Promise<TaskDocumentContextSnapshot> {
  const result = await pool.query<{ context: unknown }>(
    `SELECT context
     FROM collab_tasks
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [taskId, auth.userId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new CollabNotFoundError("Task not found");
  }
  return readExistingTaskDocumentContext(normalizeContext(row.context));
}

function expectedStateForActor(actor: CollabModelActor): CollabState {
  return actor === "chatgpt" ? "CREATIVE" : "TECHNICAL";
}

function nextStateForActor(actor: CollabModelActor): CollabState {
  return actor === "chatgpt" ? "TECHNICAL" : "CREATIVE";
}

function actorWaitingForState(state: CollabState): CollabModelActor | null {
  if (state === "CREATIVE") return "chatgpt";
  if (state === "TECHNICAL") return "claude";
  return null;
}

export interface CollabContinueCommand {
  target_actor: CollabModelActor;
  command: string;
  label: string;
  instruction: string;
}

export interface CollabHydratedDocument {
  ref: string;
  title: string | null;
  filename: string | null;
  content: string;
  status: "ready" | "pending_embedding" | "failed_indexing";
  conversation_id: string | null;
}

export interface CollabPreparedUploadHydration {
  attached: ReturnType<typeof attachUploadedFilesToTaskContext> extends Promise<infer T> ? T : never;
  documents: CollabHydratedDocument[];
}

export const COLLAB_TRANSPORT_RESPONSE_MAX_CHARS = 60_000;

function truncateForTransport(value: string, maxChars: number): {
  text: string;
  length: number;
  truncated: boolean;
} {
  if (value.length <= maxChars) {
    return { text: value, length: value.length, truncated: false };
  }
  const omitted = value.length - maxChars;
  return {
    text: `${value.slice(0, Math.max(0, maxChars))}\n\n[truncated ${omitted} chars; continue with the task id to fetch current state again]`,
    length: value.length,
    truncated: true,
  };
}

function compactTranscriptEntryForTransport(entry: CollabTranscriptEntry | null, maxContentChars: number): Record<string, unknown> | null {
  if (!entry) return null;
  const content = truncateForTransport(entry.content, maxContentChars);
  return {
    actor: entry.actor,
    iteration: entry.iteration,
    ts: entry.ts,
    content: content.text,
    content_length: content.length,
    content_truncated: content.truncated,
  };
}

function compactTranscriptForTransport(
  transcript: CollabTranscriptEntry[],
  options: { maxEntries: number; maxContentChars: number }
): Array<Record<string, unknown>> {
  const omittedEntries = Math.max(0, transcript.length - options.maxEntries);
  const entries = transcript.slice(-options.maxEntries).map((entry) => compactTranscriptEntryForTransport(entry, options.maxContentChars)!);
  if (omittedEntries > 0) {
    entries.unshift({
      actor: "system",
      iteration: 0,
      ts: new Date(0).toISOString(),
      content: `[${omittedEntries} older transcript entries omitted from this tool response to stay under client size limits]`,
      content_length: 0,
      content_truncated: true,
      omitted_entries: omittedEntries,
    });
  }
  return entries;
}

function compactFallbackContextForTransport(context: CollabTurnFallbackContext, maxContentChars: number): Record<string, unknown> {
  const record = context as unknown as Record<string, unknown>;
  const recentTranscript = Array.isArray(record["recent_transcript"])
    ? compactTranscriptForTransport(record["recent_transcript"] as CollabTranscriptEntry[], {
        maxEntries: 6,
        maxContentChars,
      })
    : record["recent_transcript"];
  return {
    ...context,
    ...(record["last_message"] ? { last_message: compactTranscriptEntryForTransport(record["last_message"] as CollabTranscriptEntry, maxContentChars) } : {}),
    ...(record["last_chatgpt_entry"] ? { last_chatgpt_entry: compactTranscriptEntryForTransport(record["last_chatgpt_entry"] as CollabTranscriptEntry, maxContentChars) } : {}),
    ...(record["last_claude_entry"] ? { last_claude_entry: compactTranscriptEntryForTransport(record["last_claude_entry"] as CollabTranscriptEntry, maxContentChars) } : {}),
    ...(recentTranscript ? { recent_transcript: recentTranscript } : {}),
  };
}

function compactInlineDocumentsForTransport(
  documents: CollabHydratedDocument[],
  options: { maxDocs: number; maxContentChars: number }
): Array<Record<string, unknown>> {
  return documents.slice(0, options.maxDocs).map((doc) => {
    const content = truncateForTransport(doc.content, options.maxContentChars);
    return {
      ref: doc.ref,
      title: doc.title,
      filename: doc.filename,
      status: doc.status,
      conversation_id: doc.conversation_id,
      content: content.text,
      content_length: content.length,
      content_truncated: content.truncated,
    };
  });
}

function compactSavedTurnForTransport(value: unknown, maxContentChars: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const contentValue = typeof record["content"] === "string" ? record["content"] : "";
  if (!contentValue) return value;
  const content = truncateForTransport(contentValue, maxContentChars);
  return {
    ...record,
    content: content.text,
    content_length: content.length,
    content_truncated: content.truncated,
    content_preview: typeof record["content_preview"] === "string"
      ? record["content_preview"]
      : contentValue.slice(0, 800),
  };
}

function compactLargeStringField(record: Record<string, unknown>, key: string, maxContentChars: number): boolean {
  const value = record[key];
  if (typeof value !== "string") return false;
  const content = truncateForTransport(value, maxContentChars);
  record[key] = content.text;
  record[`${key}_length`] = content.length;
  record[`${key}_truncated`] = content.truncated;
  return content.truncated;
}

export function compactCollabTransportPayload<T extends Record<string, unknown>>(
  payload: T,
  options?: { maxResponseChars?: number }
): T & { payload_compacted?: Record<string, unknown> } {
  const maxResponseChars = options?.maxResponseChars ?? COLLAB_TRANSPORT_RESPONSE_MAX_CHARS;
  const result: Record<string, unknown> = { ...payload };
  let compacted = false;

  if (Array.isArray(result["recent_transcript"])) {
    result["recent_transcript"] = compactTranscriptForTransport(result["recent_transcript"] as CollabTranscriptEntry[], {
      maxEntries: 6,
      maxContentChars: 4_000,
    });
    compacted = true;
  }
  if (result["last_message"] && typeof result["last_message"] === "object" && !Array.isArray(result["last_message"])) {
    result["last_message"] = compactTranscriptEntryForTransport(result["last_message"] as CollabTranscriptEntry, 4_000);
    compacted = true;
  }
  if (result["fallback_context"] && typeof result["fallback_context"] === "object" && !Array.isArray(result["fallback_context"])) {
    result["fallback_context"] = compactFallbackContextForTransport(result["fallback_context"] as CollabTurnFallbackContext, 4_000);
    compacted = true;
  }
  if (Array.isArray(result["inline_documents"])) {
    const docs = result["inline_documents"] as CollabHydratedDocument[];
    result["inline_documents"] = compactInlineDocumentsForTransport(docs, { maxDocs: 3, maxContentChars: 6_000 });
    if (docs.length > 3) {
      result["inline_documents_omitted"] = docs.length - 3;
    }
    compacted = true;
  }
  if (result["saved_turn"]) {
    result["saved_turn"] = compactSavedTurnForTransport(result["saved_turn"], 8_000);
    compacted = true;
  }
  if (result["context"] && JSON.stringify(result["context"]).length > 8_000) {
    result["context"] = {
      omitted: true,
      reason: "Task context omitted from this tool response to stay under client size limits; use fallback_context and task_id.",
    };
    compacted = true;
  }
  compacted = compactLargeStringField(result, "user_visible_full_output", 8_000) || compacted;

  let serializedLength = JSON.stringify(result).length;
  if (serializedLength > maxResponseChars) {
    if (Array.isArray(result["recent_transcript"])) {
      result["recent_transcript"] = (result["recent_transcript"] as Array<Record<string, unknown>>).map((entry) => {
        const content = typeof entry["content"] === "string" ? truncateForTransport(entry["content"], 1_000) : null;
        return content ? { ...entry, content: content.text, content_truncated: true } : entry;
      });
    }
    if (result["fallback_context"] && typeof result["fallback_context"] === "object" && !Array.isArray(result["fallback_context"])) {
      const context = result["fallback_context"] as Record<string, unknown>;
      context["recent_transcript"] = Array.isArray(context["recent_transcript"])
        ? (context["recent_transcript"] as Array<Record<string, unknown>>).slice(-3).map((entry) => {
            const content = typeof entry["content"] === "string" ? truncateForTransport(entry["content"], 1_000) : null;
            return content ? { ...entry, content: content.text, content_truncated: true } : entry;
          })
        : context["recent_transcript"];
    }
    if (Array.isArray(result["inline_documents"])) {
      result["inline_documents"] = (result["inline_documents"] as Array<Record<string, unknown>>).slice(0, 1).map((doc) => {
        const content = typeof doc["content"] === "string" ? truncateForTransport(doc["content"], 2_000) : null;
        return content ? { ...doc, content: content.text, content_truncated: true } : doc;
      });
    }
    compacted = true;
    serializedLength = JSON.stringify(result).length;
  }

  if (serializedLength > maxResponseChars) {
    delete result["inline_documents"];
    delete result["recent_transcript"];
    if (result["fallback_context"] && typeof result["fallback_context"] === "object" && !Array.isArray(result["fallback_context"])) {
      delete (result["fallback_context"] as Record<string, unknown>)["recent_transcript"];
    }
    compacted = true;
    serializedLength = JSON.stringify(result).length;
  }

  if (compacted) {
    result["payload_compacted"] = {
      max_response_chars: maxResponseChars,
      estimated_json_chars: serializedLength,
      reason: "Large collab fields are truncated to keep ChatGPT Actions and MCP tool responses under client payload limits. Full task history remains stored server-side.",
    };
  }
  return result as T & { payload_compacted?: Record<string, unknown> };
}

export function describeNextActorWork(
  state: "CREATIVE" | "TECHNICAL" | "DONE" | "ERROR",
  actor: "chatgpt" | "claude" | null
): string {
  if (!actor) {
    return "This collab session is currently ended. Should we restart it? Reply **continue** to pick up where we left off.";
  }
  if (actor === "chatgpt") {
    return "ChatGPT will produce content, strategy, or creative output for the next phase.";
  }
  return "Claude will implement, build, or refine the technical/design deliverables for the next phase.";
}

export function buildFirstTurnContinueCommand(task: CollabTask): CollabContinueCommand | null {
  if (task.iteration > 1) return null;
  const targetActor = actorWaitingForState(task.state);
  if (!targetActor) return null;
  const command = targetActor === "chatgpt"
    ? `[COLLAB:CONTINUE:${task.id}] continue collab task ${task.id}`
    : `continue task ${task.id}`;
  const nextWork = describeNextActorWork(task.state, targetActor);
  return {
    target_actor: targetActor,
    command,
    label: `Continue in ${targetActor === "chatgpt" ? "ChatGPT" : "Claude"}`,
    instruction: targetActor === "claude"
      ? `Next up: ${nextWork} Paste this in Claude: ${command}. After Claude finishes, return here and say "continue" to continue in ChatGPT.`
      : `Next up: ${nextWork} Paste this in ChatGPT: ${command}. After ChatGPT finishes, return to Claude and say "continue" to continue there.`,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function recallInlineDocuments(refs: string[], auth: AuthContext): Promise<CollabHydratedDocument[]> {
  const docs: CollabHydratedDocument[] = [];
  for (const ref of [...new Set(refs)]) {
    try {
      const recalled = await recallDocument(ref, auth);
      if (recalled.kind === "document") {
        docs.push({
          ref: recalled.ref,
          title: recalled.title,
          filename: recalled.filename,
          content: recalled.content,
          status: recalled.status,
          conversation_id: recalled.conversation_id,
        });
      }
    } catch {
      // A missing or still-indexing document should not block the turn check.
    }
  }
  return docs;
}

export async function inlineDocumentsFromTaskContext(
  task: CollabTask,
  auth: AuthContext
): Promise<CollabHydratedDocument[]> {
  const existing = readExistingTaskDocumentContext(normalizeContext(task.context));
  return recallInlineDocuments(existing.documentRefs, auth);
}

export async function hydrateTaskWithRecentPreparedUploads(
  task: CollabTask,
  auth: AuthContext,
  input?: { conversationId?: string | null; maxWaitMs?: number }
): Promise<CollabPreparedUploadHydration | null> {
  const existing = readExistingTaskDocumentContext(normalizeContext(task.context));
  if (existing.documentRefs.length > 0 || task.iteration > 1) return null;

  const startedAt = Date.now();
  const maxWaitMs = Math.max(0, Math.min(input?.maxWaitMs ?? 2500, 5000));
  const conversationId = input?.conversationId?.trim() || existing.conversationId || null;
  const taskCreatedAt = parseTimestamp(task.createdAt) ?? startedAt;
  const minRelevantTime = taskCreatedAt - 10 * 60_000;

  while (true) {
    const jobs = await listRecentCompletedUploadedFileIngestJobs(auth, {
      conversation_id: conversationId,
      limit: 10,
    });
    const documentRefs = jobs.flatMap((job) => {
      const completedAt = parseTimestamp(job.completed_at) ?? parseTimestamp(job.created_at) ?? 0;
      if (completedAt < minRelevantTime) return [];
      return job.document?.ref ? [job.document.ref] : [];
    });

    if (documentRefs.length > 0) {
      const attached = await attachUploadedFilesToTaskContext(task.id, auth, {
        documentRefs,
        conversationId,
        title: task.title,
      });
      const hydratedTask = await getTask(task.id, auth) ?? task;
      const documents = await inlineDocumentsFromTaskContext(hydratedTask, auth);
      return { attached, documents };
    }

    if (Date.now() - startedAt >= maxWaitMs) return null;
    await delay(500);
  }
}

function normalizeMaxIterations(_value?: number): number {
  // Iteration limit removed — collab tasks run until explicitly finished.
  return 9999;
}

function normalizeSingleLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizeParagraph(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.slice(0, max);
}

function truncatePreview(value: string, max = 500): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function parseTicketLine(raw: string): CollabTicketArtifact | null {
  const line = raw.replace(/^\[[xX ]\]\s*/, "").trim();
  if (!line) return null;

  const segments = line.split(/\s+\|\s+/).map((segment) => segment.trim()).filter(Boolean);
  const [primary, ...details] = segments;

  let title = primary ?? "";
  let assignee: string | null = null;
  let dueDate: string | null = null;
  let description: string | null = null;

  for (const segment of details) {
    const assigneeMatch = segment.match(/^(?:assignee|owner)\s*[:=-]\s*(.+)$/i);
    if (assigneeMatch) {
      assignee = normalizeSingleLine(assigneeMatch[1]);
      continue;
    }
    const dueMatch = segment.match(/^due(?:\s*date)?\s*[:=-]\s*(.+)$/i);
    if (dueMatch) {
      dueDate = normalizeSingleLine(dueMatch[1]);
      continue;
    }
    if (!description) {
      description = normalizeSingleLine(segment);
    }
  }

  const inlineAssignee = title.match(/\b(?:assignee|owner)\s*[:=-]\s*([^,;]+)/i);
  if (!assignee && inlineAssignee) {
    assignee = normalizeSingleLine(inlineAssignee[1]);
    title = title.replace(inlineAssignee[0], "").trim();
  }

  const inlineDue = title.match(/\bdue(?:\s*date)?\s*[:=-]\s*([^,;]+)/i);
  if (!dueDate && inlineDue) {
    dueDate = normalizeSingleLine(inlineDue[1]);
    title = title.replace(inlineDue[0], "").trim();
  }

  title = title.replace(/\s+-\s+$/, "").trim();
  if (!title) return null;

  return {
    title: truncatePreview(title, 240),
    assignee,
    due_date: dueDate,
    description,
  };
}

function normalizeChecklist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    const text = normalizeSingleLine(item);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(truncatePreview(text, 220));
  }
  return normalized.slice(0, 20);
}

function normalizeTickets(value: unknown): CollabTicketArtifact[] {
  if (!Array.isArray(value)) return [];
  const tickets: CollabTicketArtifact[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      if (typeof item === "string") {
        const parsed = parseTicketLine(item);
        if (parsed) tickets.push(parsed);
      }
      continue;
    }
    const row = item as Record<string, unknown>;
    const title = normalizeSingleLine(row["title"] ?? row["name"] ?? row["ticket"]);
    if (!title) continue;
    tickets.push({
      title: truncatePreview(title, 240),
      assignee: normalizeSingleLine(row["assignee"] ?? row["owner"]),
      due_date: normalizeSingleLine(row["due_date"] ?? row["dueDate"] ?? row["due"]),
      description: normalizeParagraph(row["description"] ?? row["details"], 280),
    });
  }
  return tickets.slice(0, 20);
}

function toArtifactsFromObject(
  value: Record<string, unknown>,
  actor: CollabModelActor,
  iteration: number,
  submittedAt: string
): CollabArtifacts | null {
  const prdSummary =
    normalizeParagraph(value["prd_summary"] ?? value["prdSummary"] ?? value["summary"], 900);
  const tickets = normalizeTickets(value["tickets"]);
  const checklist = normalizeChecklist(value["checklist"] ?? value["todo"] ?? value["todos"]);
  const assignee = normalizeSingleLine(value["assignee"] ?? value["owner"]);
  const dueDate = normalizeSingleLine(value["due_date"] ?? value["dueDate"] ?? value["due"]);

  if (!prdSummary && tickets.length === 0 && checklist.length === 0 && !assignee && !dueDate) {
    return null;
  }

  return {
    prd_summary: prdSummary,
    tickets,
    checklist,
    assignee,
    due_date: dueDate,
    extracted_from_iteration: iteration,
    extracted_from_actor: actor,
    extracted_at: submittedAt,
  };
}

function extractJsonObjectCandidates(content: string): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const trimmed = content.trim();
  const rawCandidates: string[] = [trimmed];
  const fencedMatches = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (candidate) rawCandidates.push(candidate);
  }

  for (const raw of rawCandidates) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }

  return candidates;
}

function extractJsonFromFence(content: string, fenceTag: string): Record<string, unknown> | null {
  const pattern = new RegExp("```" + fenceTag + "\\s*([\\s\\S]*?)```", "i");
  const match = content.match(pattern);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeEvaluationEntry(
  parsed: Record<string, unknown>,
  actor: CollabModelActor,
  iteration: number,
  submittedAt: string
): CollabCriterionEvaluationEntry | null {
  const criteriaRaw = parsed["criterion_evaluations"];
  if (!Array.isArray(criteriaRaw) || criteriaRaw.length === 0) {
    return null;
  }

  const criterionEvaluations = criteriaRaw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const criterionId = normalizeSingleLine(item["criterion_id"]) ?? "";
      const statusRaw = item["status"];
      const status = statusRaw === "pass" || statusRaw === "fail" || statusRaw === "partial" ? statusRaw : null;
      const rationale = normalizeParagraph(item["rationale"], 400) ?? "";
      if (!criterionId || !status || !rationale) return null;
      return { criterion_id: criterionId, status, rationale };
    })
    .filter((item): item is CollabCriterionEvaluation => Boolean(item));

  if (criterionEvaluations.length === 0) {
    return null;
  }

  return {
    iteration,
    actor,
    ts: submittedAt,
    criterion_evaluations: criterionEvaluations,
    should_mark_done: parsed["should_mark_done"] === true,
    remaining_work: normalizeParagraph(parsed["remaining_work"], 1000) ?? "",
  };
}

function extractEvaluation(
  content: string,
  actor: CollabModelActor,
  iteration: number,
  submittedAt: string
): CollabCriterionEvaluationEntry | null {
  const parsed = extractJsonFromFence(content, "orchestrator-eval");
  if (!parsed) return null;
  return normalizeEvaluationEntry(parsed, actor, iteration, submittedAt);
}

function normalizeEvaluationTimeline(value: unknown): CollabCriterionEvaluationEntry[] {
  if (!Array.isArray(value)) return [];
  const normalized: CollabCriterionEvaluationEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const actor = row["actor"];
    const iteration = row["iteration"];
    const ts = row["ts"];
    if ((actor !== "chatgpt" && actor !== "claude") || typeof iteration !== "number" || typeof ts !== "string") {
      continue;
    }
    const normalizedEntry = normalizeEvaluationEntry(row, actor, iteration, ts);
    if (normalizedEntry) normalized.push(normalizedEntry);
  }
  return normalized;
}

function extractCollabArtifacts(
  content: string,
  actor: CollabModelActor,
  iteration: number,
  submittedAt: string
): CollabArtifacts | null {
  const objectCandidates = extractJsonObjectCandidates(content);
  for (const candidate of objectCandidates) {
    const extracted = toArtifactsFromObject(candidate, actor, iteration, submittedAt);
    if (extracted) return extracted;
  }

  const lines = content.split(/\r?\n/);
  const summaryLines: string[] = [];
  const checklist: string[] = [];
  const tickets: CollabTicketArtifact[] = [];
  const checklistSet = new Set<string>();
  let currentSection: "summary" | "tickets" | "checklist" | "other" = "other";
  let assignee: string | null = null;
  let dueDate: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const normalizedHeading = heading[1].toLowerCase();
      if (/(ticket|backlog|jira|issues?)/.test(normalizedHeading)) {
        currentSection = "tickets";
      } else if (/(slide flow|lesson flow|course flow|flow|outline|agenda|sequence|plan)/.test(normalizedHeading)) {
        // Slide/lesson flow sections usually contain numbered deliverable lines.
        currentSection = "checklist";
      } else if (/(checklist|todo|to-do|next steps?|action items?)/.test(normalizedHeading)) {
        currentSection = "checklist";
      } else if (/(prd|summary|overview|brief|review|refinement|recommend)/.test(normalizedHeading)) {
        currentSection = "summary";
      } else {
        currentSection = "other";
      }
      continue;
    }

    const assigneeMatch = line.match(/^(?:assignee|owner)\s*[:=-]\s*(.+)$/i);
    if (assigneeMatch) {
      assignee = normalizeSingleLine(assigneeMatch[1]) ?? assignee;
      continue;
    }

    const dueMatch = line.match(/^due(?:\s*date)?\s*[:=-]\s*(.+)$/i);
    if (dueMatch) {
      dueDate = normalizeSingleLine(dueMatch[1]) ?? dueDate;
      continue;
    }

    const listMatch = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    const checkboxMatch = line.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/);
    const listContent = (checkboxMatch?.[1] ?? listMatch?.[1] ?? "").trim();

    if (listContent) {
      const looksLikeSlideItem = /^slide\s*\d+\s*[:\-]/i.test(listContent);
      if (currentSection === "tickets") {
        const ticket = parseTicketLine(listContent);
        if (ticket) tickets.push(ticket);
        continue;
      }
      if (currentSection === "checklist" || checkboxMatch || looksLikeSlideItem) {
        const item = normalizeSingleLine(listContent);
        if (item) {
          const key = item.toLowerCase();
          if (!checklistSet.has(key)) {
            checklistSet.add(key);
            checklist.push(truncatePreview(item, 220));
          }
        }
        continue;
      }
    }

    if (currentSection === "summary" && summaryLines.length < 8) {
      summaryLines.push(line);
    }
  }

  const paragraphs = content
    .split(/\n\s*\n/)
    .map((segment) => segment.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const fallbackSummary = paragraphs[0] ?? null;
  const prdSummary = normalizeParagraph(summaryLines.join(" "), 900) ?? normalizeParagraph(fallbackSummary, 900);

  if (!prdSummary && tickets.length === 0 && checklist.length === 0 && !assignee && !dueDate) {
    return null;
  }

  return {
    prd_summary: prdSummary,
    tickets: tickets.slice(0, 20),
    checklist: checklist.slice(0, 20),
    assignee,
    due_date: dueDate,
    extracted_from_iteration: iteration,
    extracted_from_actor: actor,
    extracted_at: submittedAt,
  };
}

export function buildTurnFallbackContext(task: CollabTask, actor: CollabModelActor): CollabTurnFallbackContext {
  const lastMessage = task.transcript.length > 0
    ? task.transcript[task.transcript.length - 1]
    : null;
  const lastChatGptEntry = [...task.transcript].reverse().find((entry) => entry.actor === "chatgpt") ?? null;
  const lastClaudeEntry = [...task.transcript].reverse().find((entry) => entry.actor === "claude") ?? null;
  const recentTranscript = task.transcript;
  const context = normalizeContext(task.context);
  const orchestrationContext = normalizeContext(context["orchestration"]);
  const artifacts = normalizeContext(context["artifacts"]);
  const plan = normalizeContext(artifacts["plan"]);
  const documentContext = normalizeContext(context["documents"]);

  let orchestration: CollabTurnFallbackContext["orchestration"] | undefined;
  if (typeof orchestrationContext["session_id"] === "string" && typeof plan["summary"] === "string") {
    const criteriaRaw = Array.isArray(artifacts["success_criteria"])
      ? artifacts["success_criteria"]
      : Array.isArray(plan["success_criteria"])
        ? plan["success_criteria"]
        : [];
    const criteria = criteriaRaw
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      .map((item) => ({
        id: normalizeSingleLine(item["id"]) ?? "",
        text: normalizeParagraph(item["text"], 500) ?? "",
        weight: typeof item["weight"] === "number" ? Math.max(1, Math.min(3, Math.trunc(item["weight"]))) : 1,
      }))
      .filter((item) => item.id && item.text);
    const evaluations = normalizeEvaluationTimeline(artifacts["evaluations"]);
    const lastEvaluation = evaluations.length > 0 ? evaluations[evaluations.length - 1] : null;

    const latestStatusByCriterion = new Map<string, "pass" | "fail" | "partial">();
    for (const evaluation of evaluations) {
      for (const criterion of evaluation.criterion_evaluations) {
        latestStatusByCriterion.set(criterion.criterion_id, criterion.status);
      }
    }

    orchestration = {
      plan_summary: normalizeParagraph(plan["summary"], 700) ?? "",
      success_criteria: criteria.map((criterion) => ({
        ...criterion,
        latest_status: latestStatusByCriterion.get(criterion.id) ?? "pending",
      })),
      last_evaluation: lastEvaluation,
      instructions:
        "Append an ```orchestrator-eval``` JSON block. Do not mark the task done automatically; ask the user for explicit approval to finish.",
    };
  }

  return {
    task_id: task.id,
    title: task.title,
    brief: task.brief,
    state: task.state,
    iteration: task.iteration,
    max_iterations: task.maxIterations,
    waiting_on: actorWaitingForState(task.state),
    your_actor: actor,
    last_message: lastMessage,
    last_chatgpt_entry: lastChatGptEntry,
    last_claude_entry: lastClaudeEntry,
    recent_transcript: recentTranscript,
    ...(typeof documentContext["lot_ref"] === "string" ? {
      documents: {
        lot_ref: documentContext["lot_ref"] as string,
        lot_title: typeof documentContext["lot_title"] === "string" ? documentContext["lot_title"] : null,
        conversation_id: typeof documentContext["conversation_id"] === "string" ? documentContext["conversation_id"] : null,
        documents: Array.isArray(documentContext["documents"])
          ? (documentContext["documents"] as Array<Record<string, unknown>>).flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            if (item["kind"] !== "document" || typeof item["ref"] !== "string" || typeof item["title"] !== "string" || typeof item["preview"] !== "string") return [];
            const status = item["status"];
            if (status !== "pending" && status !== "ready" && status !== "failed") return [];
            return [{
              kind: "document" as const,
              ref: item["ref"],
              title: item["title"],
              filename: typeof item["filename"] === "string" ? item["filename"] : null,
              status,
              preview: item["preview"],
              blob_url:
                item["blob"] &&
                  typeof item["blob"] === "object" &&
                  !Array.isArray(item["blob"]) &&
                  typeof (item["blob"] as Record<string, unknown>)["url"] === "string"
                  ? (item["blob"] as Record<string, unknown>)["url"] as string
                  : null,
            }];
          })
          : [],
      },
    } : {}),
    ...(orchestration ? { orchestration } : {}),
  };
}

export async function attachUploadedFilesToTaskContext(
  taskId: string,
  auth: AuthContext,
  input: {
    openaiFileIdRefs?: CollabOpenAiFileRef[];
    documentRefs?: string[];
    conversationId?: string | null;
    title?: string;
  }
): Promise<{
  lot_ref: string | null;
  count_saved: number;
  count_attached_existing: number;
  count_total_documents: number;
  count_failed: number;
  errors: UploadedFileSaveError[];
}> {
  assertCollabPlan(auth);

  const uploadedFileRefs = input.openaiFileIdRefs ?? [];
  const requestedDocumentRefs = [...new Set((input.documentRefs ?? []).map((value) => value.trim()).filter(Boolean))];
  const existingContext = await loadTaskDocumentContext(taskId, auth);

  if (uploadedFileRefs.length === 0 && requestedDocumentRefs.length === 0) {
    return {
      lot_ref: existingContext.lotRef,
      count_saved: 0,
      count_attached_existing: 0,
      count_total_documents: existingContext.documentRefs.length,
      count_failed: 0,
      errors: [],
    };
  }

  const { saved, errors } = uploadedFileRefs.length > 0
    ? await ingestUploadedFilesToDocuments(uploadedFileRefs, auth, {
      title: input.title,
      conversation_id: input.conversationId ?? null,
    })
    : { saved: [], errors: [] };

  const mergedRefs = [...new Set([
    ...existingContext.documentRefs,
    ...requestedDocumentRefs.map((ref) => ref.trim()),
    ...saved.map((item) => item.ref),
  ])];

  if (mergedRefs.length === 0) {
    if (errors.length > 0) {
      throw new CollabAttachmentIngestError(errors);
    }
    return {
      lot_ref: existingContext.lotRef,
      count_saved: 0,
      count_attached_existing: 0,
      count_total_documents: 0,
      count_failed: 0,
      errors: [],
    };
  }

  const lot = await createLot(mergedRefs, auth, input.title ?? "Collab upload bundle");
  const refs = [lot.lotRef, ...lot.docRefs];
  const briefs = await documentBriefsByRefs(refs, auth, { maxLotDocs: 20 });
  const lotBrief = briefs.find((item) => item.kind === "lot" && item.ref === lot.lotRef);
  const documents = lotBrief?.kind === "lot" ? lotBrief.documents : [];
  const conversationId = input.conversationId ?? existingContext.conversationId ?? null;
  const attachedExisting = requestedDocumentRefs.filter((ref) => !existingContext.documentRefs.includes(ref)).length;

  await pool.query(
    `UPDATE collab_tasks
     SET context = jsonb_set(
       COALESCE(context, '{}'::jsonb),
       '{documents}',
       $3::jsonb,
       true
     ),
         updated_at = now()
     WHERE id = $1
       AND user_id = $2`,
    [taskId, auth.userId, JSON.stringify({
      lot_ref: lot.lotRef,
      lot_title: input.title ?? existingContext.lotTitle ?? null,
      conversation_id: conversationId,
      documents,
      upload: {
        count_saved: saved.length,
        count_attached_existing: attachedExisting,
        count_total_documents: lot.docRefs.length,
        count_failed: errors.length,
        errors,
      },
    })]
  );
  invalidateCachedTask(taskId, auth);

  return {
    lot_ref: lot.lotRef,
    count_saved: saved.length,
    count_attached_existing: attachedExisting,
    count_total_documents: lot.docRefs.length,
    count_failed: errors.length,
    errors,
  };
}

export async function createTask(
  input: {
    title: string;
    brief?: string | null;
    firstActor: CollabModelActor;
    maxIterations?: number;
    context?: Record<string, unknown> | null;
  },
  auth: AuthContext
): Promise<CollabTask> {
  assertCollabPlan(auth);

  const title = input.title.trim();
  if (!title) {
    throw new Error("title is required");
  }

  // Reuse a recently finished task with the same title + brief instead of creating a duplicate.
  const brief = (input.brief ?? "").trim();
  const existing = await pool.query<CollabTaskRow>(
    `SELECT *
     FROM collab_tasks
     WHERE tenant_id = $1
       AND user_id = $2
       AND state = 'DONE'
       AND title = $3
       AND COALESCE(brief, '') = $4
       AND updated_at > now() - interval '24 hours'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [auth.tenantId, auth.userId, title, brief]
  );

  if (existing.rows[0]) {
    const state = input.firstActor === "chatgpt" ? "CREATIVE" : "TECHNICAL";
    const restarted = await pool.query<CollabTaskRow>(
      `UPDATE collab_tasks
       SET state = $3,
           error_message = NULL,
           updated_at = now()
       WHERE id = $1
         AND user_id = $2
       RETURNING *`,
      [existing.rows[0].id, auth.userId, state]
    );
    const task = mapTaskRow(restarted.rows[0]);
    invalidateCachedTask(task.id, auth);
    writeCachedTask(task);
    return task;
  }

  const maxIterations = normalizeMaxIterations(input.maxIterations);
  const state = input.firstActor === "chatgpt" ? "CREATIVE" : "TECHNICAL";

  const result = await pool.query<CollabTaskRow>(
    `INSERT INTO collab_tasks (tenant_id, user_id, title, brief, state, max_iterations, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING *`,
    [
      auth.tenantId,
      auth.userId,
      title,
      brief || null,
      state,
      maxIterations,
      JSON.stringify(input.context ?? {}),
    ]
  );

  const task = mapTaskRow(result.rows[0]);
  writeCachedTask(task);
  return task;
}

export async function getTask(taskId: string, auth: AuthContext): Promise<CollabTask | null> {
  const cached = readCachedTask(taskId, auth);
  if (cached) return cached;

  const result = await pool.query<CollabTaskRow>(
    `SELECT *
     FROM collab_tasks
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [taskId, auth.userId]
  );

  const row = result.rows[0];
  if (!row) return null;

  const task = mapTaskRow(row);
  writeCachedTask(task);
  return task;
}

export async function listTasks(
  input: { filter?: CollabFilter },
  auth: AuthContext
): Promise<CollabTask[]> {
  const filter = input.filter ?? "all";

  let whereClause = "tenant_id = $1 AND user_id = $2";
  if (filter === "active") {
    whereClause += " AND state IN ('CREATIVE', 'TECHNICAL')";
  } else if (filter === "waiting") {
    whereClause += " AND state = 'TECHNICAL'";
  } else if (filter === "done") {
    whereClause += " AND state IN ('DONE', 'ERROR')";
  }

  const result = await pool.query<CollabTaskRow>(
    `SELECT *
     FROM collab_tasks
     WHERE ${whereClause}
     ORDER BY updated_at DESC
     LIMIT 50`,
    [auth.tenantId, auth.userId]
  );

  return result.rows.map(mapTaskRow);
}

async function maybeRestartDoneTask(
  taskId: string,
  auth: AuthContext,
  toState: CollabState
): Promise<CollabTask | null> {
  const result = await pool.query<CollabTaskRow>(
    `UPDATE collab_tasks
     SET state = $3,
         error_message = NULL,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
       AND state = 'DONE'
       AND updated_at > now() - interval '24 hours'
     RETURNING *`,
    [taskId, auth.userId, toState]
  );
  const row = result.rows[0];
  if (!row) return null;
  const task = mapTaskRow(row);
  invalidateCachedTask(taskId, auth);
  writeCachedTask(task);
  return task;
}

export async function claimTurn(
  taskId: string,
  actor: CollabModelActor,
  auth: AuthContext
): Promise<CollabTask | null> {
  assertCollabPlan(auth);

  const expectedState = expectedStateForActor(actor);

  // Auto-restart DONE tasks within 24h so users can continue seamlessly.
  await maybeRestartDoneTask(taskId, auth, expectedState);

  const result = await pool.query<CollabTaskRow>(
    `SELECT *
     FROM collab_tasks
     WHERE id = $1
       AND user_id = $2
       AND state = $3
     LIMIT 1`,
    [taskId, auth.userId, expectedState]
  );

  const row = result.rows[0];
  if (!row) return null;

  const task = mapTaskRow(row);
  writeCachedTask(task);
  return task;
}

export async function submitTurn(
  taskId: string,
  actor: CollabModelActor,
  content: string,
  auth: AuthContext,
  _opts: { markDone?: boolean } = {}
): Promise<CollabTask> {
  assertCollabPlan(auth);

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("content is required");
  }

  const expectedState = expectedStateForActor(actor);
  const desiredNextState = nextStateForActor(actor);
  const submittedAt = new Date().toISOString();

  const newEntry = {
    actor,
    iteration: 0,
    content: trimmed,
    ts: submittedAt,
  };

  const result = await pool.query<CollabTaskRow>(
    `UPDATE collab_tasks
     SET transcript = transcript || jsonb_set($5::jsonb, '{iteration}', to_jsonb(iteration + 1)),
         state = $6,
         last_actor = $4,
         iteration = iteration + 1,
         error_message = NULL,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
       AND state = $3
     RETURNING *`,
    [
      taskId,
      auth.userId,
      expectedState,
      actor,
      JSON.stringify(newEntry),
      desiredNextState,
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new CollabConflictError("Task is not in the expected state for this actor.");
  }

  let task = mapTaskRow(row);

  try {
    const extractedRefs = extractDocumentRefsFromText(trimmed);
    const { valid, missing } = await filterExistingDocumentRefs(extractedRefs, auth);

    if (missing.length > 0) {
      console.warn(
        `[collab] turn content referenced missing document refs for task ${taskId}: ${missing.join(", ")}`
      );
    }

    const shouldAutoSave = valid.length === 0 && hasStructuredContent(trimmed);
    let autoSavedRef: string | null = null;

    if (shouldAutoSave) {
      try {
        const stashed = await stashDocument(trimmed, auth, {
          title: task.title,
          conversationId: task.id,
          mimeType: "text/markdown",
        });
        autoSavedRef = stashed.refHandle;
        console.log(`[collab] auto-saved turn content as ${autoSavedRef} for task ${taskId}`);
      } catch (saveError) {
        console.warn(`[collab] auto-save failed for task ${taskId}:`, saveError);
      }
    }

    const refsToAttach = autoSavedRef ? [...valid, autoSavedRef] : valid;

    if (refsToAttach.length > 0) {
      await attachUploadedFilesToTaskContext(taskId, auth, {
        documentRefs: refsToAttach,
        conversationId: task.id,
        title: task.title,
      });
      task = await getTask(taskId, auth) ?? task;
    }
  } catch (error) {
    console.warn("[collab] document ref attachment failed", error);
  }

  try {
    const artifacts = extractCollabArtifacts(trimmed, actor, task.iteration, submittedAt);
    if (artifacts) {
      const contextResult = await pool.query<CollabTaskRow>(
        `UPDATE collab_tasks
         SET context = jsonb_set(
           COALESCE(context, '{}'::jsonb),
           '{artifacts}',
           COALESCE(context->'artifacts', '{}'::jsonb) || $3::jsonb,
           true
         ),
             updated_at = now()
         WHERE id = $1
           AND user_id = $2
         RETURNING *`,
        [taskId, auth.userId, JSON.stringify(artifacts)]
      );
      if (contextResult.rows[0]) {
        task = mapTaskRow(contextResult.rows[0]);
      }
    }
  } catch (error) {
    if (process.env["NODE_ENV"] !== "production") {
      console.warn("[collab] artifact extraction failed", error);
    }
  }

  let evaluation: CollabCriterionEvaluationEntry | null = null;
  try {
    evaluation = extractEvaluation(trimmed, actor, task.iteration, submittedAt);
    if (evaluation) {
      const evaluationResult = await pool.query<CollabTaskRow>(
        `UPDATE collab_tasks
         SET context = jsonb_set(
           COALESCE(context, '{}'::jsonb),
           '{artifacts,evaluations}',
           COALESCE(context->'artifacts'->'evaluations', '[]'::jsonb) || $3::jsonb,
           true
         ),
             updated_at = now()
         WHERE id = $1
           AND user_id = $2
         RETURNING *`,
        [taskId, auth.userId, JSON.stringify([evaluation])]
      );
      if (evaluationResult.rows[0]) {
        task = mapTaskRow(evaluationResult.rows[0]);
      }
    }
  } catch (error) {
    if (process.env["NODE_ENV"] !== "production") {
      console.warn("[collab] evaluation extraction failed", error);
    }
  }

  // Auto-end task when explicitly marked done by the actor or evaluation.
  const shouldAutoFinish = _opts.markDone || (evaluation?.should_mark_done ?? false);
  if (shouldAutoFinish && task.state !== 'DONE' && task.state !== 'ERROR') {
    try {
      task = await finishTask(taskId, auth, "Auto-finished: turn marked done.");
    } catch {
      // Ignore finish errors so the turn submission itself always succeeds.
    }
  }

  invalidateCachedTask(taskId, auth);
  writeCachedTask(task);
  return task;
}

function buildCollabTaskSummary(task: CollabTask): string {
  const lines: string[] = [];
  lines.push(`Collab Task ${task.id}`);
  lines.push(`Title: ${task.title}`);
  if (task.brief) lines.push(`Brief: ${task.brief}`);
  lines.push(`State: ${task.state}`);
  lines.push(`Progress: iteration ${task.iteration}`);
  if (task.lastActor) lines.push(`Last actor: ${task.lastActor}`);

  if (task.transcript.length > 0) {
    lines.push("Recent transcript:");
    const recent = task.transcript.slice(-4);
    for (const entry of recent) {
      const snippet = entry.content.slice(0, 300) + (entry.content.length > 300 ? "…" : "");
      lines.push(`  [${entry.actor} #${entry.iteration}] ${snippet}`);
    }
  }

  const artifacts = normalizeContext(task.context)["artifacts"];
  if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
    const artifactRecord = artifacts as Record<string, unknown>;
    const prd = artifactRecord["prd_summary"];
    if (typeof prd === "string" && prd.trim()) lines.push(`PRD summary: ${prd.trim()}`);

    const checklist = artifactRecord["checklist"];
    if (Array.isArray(checklist) && checklist.length > 0) {
      lines.push(`Checklist: ${checklist.slice(0, 5).join("; ")}`);
    }

    const tickets = artifactRecord["tickets"];
    if (Array.isArray(tickets) && tickets.length > 0) {
      const titles = (tickets as Array<Record<string, unknown>>)
        .map((t) => t["title"])
        .filter((t): t is string => typeof t === "string")
        .slice(0, 3)
        .join("; ");
      if (titles) lines.push(`Tickets: ${titles}`);
    }

    const evaluations = artifactRecord["evaluations"];
    if (Array.isArray(evaluations) && evaluations.length > 0) {
      const lastEval = evaluations[evaluations.length - 1] as Record<string, unknown>;
      if (lastEval["should_mark_done"] === true) {
        lines.push("Evaluation: criteria met, task marked done.");
      } else if (typeof lastEval["remaining_work"] === "string" && lastEval["remaining_work"]) {
        lines.push(`Remaining work: ${lastEval["remaining_work"]}`);
      }
    }
  }

  return lines.join("\n");
}

export async function saveCollabTaskSummary(task: CollabTask, auth: AuthContext): Promise<void> {
  const summary = buildCollabTaskSummary(task);
  void saveMemory(summary, auth, "system", undefined, {
    memoryType: "collab",
    category: "collab",
    runFactExtraction: false,
    runVectorDedup: false,
  }).catch(() => {});
}

export async function listRecentCollabTasks(
  auth: AuthContext,
  limit = 4
): Promise<CollabTask[]> {
  const result = await pool.query<CollabTaskRow>(
    `SELECT *
     FROM collab_tasks
     WHERE tenant_id = $1
       AND user_id = $2
     ORDER BY updated_at DESC
     LIMIT $3`,
    [auth.tenantId, auth.userId, limit]
  );
  return result.rows.map(mapTaskRow);
}

export async function getCollabTaskContentForContext(
  taskId: string,
  auth: AuthContext
): Promise<string | null> {
  const task = await getTask(taskId, auth);
  if (!task) return null;

  const transcriptText = task.transcript
    .map((e) => `[${e.actor} #${e.iteration}] ${e.content.slice(0, 600)}`)
    .join("\n");

  const prompt = `You are preparing context for an AI assistant that is continuing a conversation about a specific collab task.
Summarize the task below into a concise context block. Include: the goal, what has been accomplished, key decisions or artifacts, and any remaining work. Keep it under 400 words.

Task Title: ${task.title}
Brief: ${task.brief ?? "N/A"}
State: ${task.state}
Iteration: ${task.iteration}

Transcript:
${transcriptText}`;

  try {
    const response = await aiProviderRegistry.chat({
      model: aiProviderRegistry.chatModelName(),
      messages: [
        { role: "system", content: "You summarize collab tasks into concise context blocks for AI assistants." },
        { role: "user", content: prompt },
      ],
      maxTokens: 600,
      temperature: 0,
    });
    return response.text?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function finishTask(taskId: string, auth: AuthContext, reason?: string): Promise<CollabTask> {
  assertCollabPlan(auth);

  const result = await pool.query<CollabTaskRow>(
    `UPDATE collab_tasks
     SET state = 'DONE',
         error_message = CASE WHEN $3::text IS NULL OR $3::text = '' THEN error_message ELSE $3::text END,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
     RETURNING *`,
    [taskId, auth.userId, reason ?? null]
  );

  const row = result.rows[0];
  if (!row) {
    throw new CollabNotFoundError();
  }

  const task = mapTaskRow(row);
  invalidateCachedTask(taskId, auth);
  writeCachedTask(task);
  void saveCollabTaskSummary(task, auth).catch(() => {});
  return task;
}

export async function extendIterations(taskId: string, _by: number, auth: AuthContext): Promise<CollabTask> {
  assertCollabPlan(auth);

  // Iteration limit removed; this is now a no-op that returns the current task.
  const task = await getTask(taskId, auth);
  if (!task) {
    throw new CollabNotFoundError();
  }
  return task;
}

export async function deleteTask(taskId: string, auth: AuthContext): Promise<void> {
  assertCollabPlan(auth);

  const result = await pool.query(
    `DELETE FROM collab_tasks
     WHERE id = $1
       AND user_id = $2`,
    [taskId, auth.userId]
  );

  if ((result.rowCount ?? 0) === 0) {
    throw new CollabNotFoundError();
  }

  invalidateCachedTask(taskId, auth);
}
