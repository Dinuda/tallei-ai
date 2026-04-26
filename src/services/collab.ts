import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";

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

function normalizeMaxIterations(value?: number): number {
  if (!Number.isFinite(value)) return 4;
  const normalized = Math.trunc(value as number);
  if (normalized < 1) return 1;
  if (normalized > 8) return 8;
  return normalized;
}

export function buildTurnFallbackContext(task: CollabTask, actor: CollabModelActor): CollabTurnFallbackContext {
  const lastMessage = task.transcript.length > 0
    ? task.transcript[task.transcript.length - 1]
    : null;
  const lastChatGptEntry = [...task.transcript].reverse().find((entry) => entry.actor === "chatgpt") ?? null;
  const lastClaudeEntry = [...task.transcript].reverse().find((entry) => entry.actor === "claude") ?? null;
  const recentTranscript = task.transcript.slice(-6);

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
  };
}

export async function createTask(
  input: {
    title: string;
    brief?: string | null;
    firstActor: CollabModelActor;
    maxIterations?: number;
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
    `INSERT INTO collab_tasks (tenant_id, user_id, title, brief, state, max_iterations)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [auth.tenantId, auth.userId, title, input.brief ?? null, state, maxIterations]
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

  const task = mapTaskRow(row);
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
