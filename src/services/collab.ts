import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import { createLot, documentBriefsByRefs, recallDocument } from "./documents.js";
import { ingestUploadedFilesToDocuments, type UploadedFileSaveError } from "./uploaded-file-ingest.js";
import { listRecentCompletedUploadedFileIngestJobs } from "./uploaded-file-ingest-jobs.js";

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

export function buildFirstTurnContinueCommand(task: CollabTask): CollabContinueCommand | null {
  if (task.iteration > 1) return null;
  const targetActor = actorWaitingForState(task.state);
  if (!targetActor) return null;
  return {
    target_actor: targetActor,
    command: targetActor === "chatgpt"
      ? `[COLLAB:CONTINUE:${task.id}] continue collab task ${task.id}`
      : `continue collab task ${task.id}`,
    label: `Continue in ${targetActor === "chatgpt" ? "ChatGPT" : "Claude"}`,
    instruction: `Review this turn. If it looks good, say or paste: ${targetActor === "chatgpt"
      ? `[COLLAB:CONTINUE:${task.id}] continue collab task ${task.id}`
      : `continue collab task ${task.id}`}`,
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

function normalizeMaxIterations(value?: number): number {
  if (!Number.isFinite(value)) return 4;
  const normalized = Math.trunc(value as number);
  if (normalized < 1) return 1;
  if (normalized > 8) return 8;
  return normalized;
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
      } else if (/(checklist|todo|to-do|next steps?|action items?)/.test(normalizedHeading)) {
        currentSection = "checklist";
      } else if (/(prd|summary|overview|brief)/.test(normalizedHeading)) {
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
      if (currentSection === "tickets") {
        const ticket = parseTicketLine(listContent);
        if (ticket) tickets.push(ticket);
        continue;
      }
      if (currentSection === "checklist" || checkboxMatch) {
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
  const recentTranscript = task.transcript.slice(-6);
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
        "Append an ```orchestrator-eval``` JSON block. Set mark_done=true when all criteria pass.",
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
  const title = input.title.trim();
  if (!title) {
    throw new Error("title is required");
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
      input.brief ?? null,
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

export async function claimTurn(
  taskId: string,
  actor: CollabModelActor,
  auth: AuthContext
): Promise<CollabTask | null> {
  const expectedState = expectedStateForActor(actor);
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
  opts: { markDone?: boolean } = {}
): Promise<CollabTask> {
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

  const capEntry = {
    actor: "user" as const,
    iteration: 0,
    content: "Iteration cap reached. Task auto-marked done.",
    ts: submittedAt,
  };

  const result = await pool.query<CollabTaskRow>(
    `UPDATE collab_tasks
     SET transcript =
       CASE
         WHEN $7::boolean OR iteration + 1 < max_iterations
           THEN transcript || jsonb_set($5::jsonb, '{iteration}', to_jsonb(iteration + 1))
         ELSE transcript || jsonb_set($5::jsonb, '{iteration}', to_jsonb(iteration + 1)) || jsonb_set($6::jsonb, '{iteration}', to_jsonb(iteration + 1))
       END,
         state =
       CASE
         WHEN $7::boolean THEN 'DONE'
         WHEN iteration + 1 >= max_iterations THEN 'DONE'
         ELSE $8
       END,
         last_actor = $4,
         iteration = iteration + 1,
         error_message = NULL,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
       AND state = $3
       AND iteration < max_iterations
     RETURNING *`,
    [
      taskId,
      auth.userId,
      expectedState,
      actor,
      JSON.stringify(newEntry),
      JSON.stringify(capEntry),
      Boolean(opts.markDone),
      desiredNextState,
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new CollabConflictError("Task is not in the expected state for this actor.");
  }

  let task = mapTaskRow(row);
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

  try {
    const evaluation = extractEvaluation(trimmed, actor, task.iteration, submittedAt);
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

  invalidateCachedTask(taskId, auth);
  writeCachedTask(task);
  return task;
}

export async function finishTask(taskId: string, auth: AuthContext, reason?: string): Promise<CollabTask> {
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
  return task;
}

export async function extendIterations(taskId: string, by: number, auth: AuthContext): Promise<CollabTask> {
  const delta = Math.trunc(by);
  if (!Number.isFinite(delta) || delta < 1) {
    throw new Error("by must be >= 1");
  }

  const result = await pool.query<CollabTaskRow>(
    `UPDATE collab_tasks
     SET max_iterations = LEAST(8, max_iterations + $3),
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
     RETURNING *`,
    [taskId, auth.userId, delta]
  );

  const row = result.rows[0];
  if (!row) {
    throw new CollabNotFoundError();
  }

  const task = mapTaskRow(row);
  invalidateCachedTask(taskId, auth);
  writeCachedTask(task);
  return task;
}

export async function deleteTask(taskId: string, auth: AuthContext): Promise<void> {
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
