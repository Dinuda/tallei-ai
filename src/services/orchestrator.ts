import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import { config } from "../config/index.js";
import {
  createTask as createCollabTask,
  getTask as getCollabTask,
  type CollabModelActor,
  type CollabTask,
} from "./collab.js";
import {
  runPlannerStep,
  suggestProviderRoles,
  type OrchestrationPlan,
  type ProviderRoleSuggestion,
  type PlannerTurn,
  type WebSearchResult,
} from "./planner.js";

export type OrchestrationStatus =
  | "DRAFT"
  | "INTERVIEWING"
  | "PLAN_READY"
  | "RUNNING"
  | "DONE"
  | "ABORTED";

export type OrchestrationSourcePlatform = "claude" | "chatgpt" | "dashboard";

export interface OrchestrationTranscriptEntry {
  role: "planner" | "user" | "system";
  content: string;
  ts: string;
  web_searches?: WebSearchResult[];
  suggested_answers?: string[];
  default_answer?: string | null;
}

export interface OrchestrationSession {
  id: string;
  tenantId: string;
  userId: string;
  goal: string;
  status: OrchestrationStatus;
  transcript: OrchestrationTranscriptEntry[];
  plan: OrchestrationPlan | null;
  collabTaskId: string | null;
  metadata: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrchestrationFilter = "all" | "active" | "done";

interface OrchestrationSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  goal: string;
  status: OrchestrationStatus;
  transcript: unknown;
  plan: unknown;
  collab_task_id: string | null;
  metadata: unknown;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface CachedSession {
  session: OrchestrationSession;
  exp: number;
}

export interface OrchestratorFallbackContext {
  session_id: string;
  goal: string;
  status: OrchestrationStatus;
  question: string | null;
  plan_summary: string | null;
  success_criteria: Array<{ id: string; text: string; weight: number }>;
  open_questions: string[];
  role_selection?: OrchestrationRoleSelection;
}

export interface OrchestrationProviderRoles {
  chatgpt?: string;
  claude?: string;
}

export interface OrchestrationRoleSelection {
  chatgpt_role: string;
  claude_role: string;
  first_actor_recommendation: CollabModelActor;
  selected_first_actor: CollabModelActor;
  selection_mode: "auto" | "user_override";
}

const SESSION_CACHE_TTL_MS = 5_000;
const sessionCache = new Map<string, CachedSession>();

export class OrchestrationConflictError extends Error {
  constructor(message = "Session is not in expected state") {
    super(message);
    this.name = "OrchestrationConflictError";
  }
}

export class OrchestrationNotFoundError extends Error {
  constructor(message = "Orchestration session not found") {
    super(message);
    this.name = "OrchestrationNotFoundError";
  }
}

export class OrchestrationInvalidPlanError extends Error {
  constructor(message = "Orchestration session plan is invalid or missing") {
    super(message);
    this.name = "OrchestrationInvalidPlanError";
  }
}

function cacheKey(sessionId: string, auth: AuthContext): string {
  return `${auth.userId}:${sessionId}`;
}

function readCachedSession(sessionId: string, auth: AuthContext): OrchestrationSession | null {
  const cached = sessionCache.get(cacheKey(sessionId, auth));
  if (!cached) return null;
  if (cached.exp <= Date.now()) {
    sessionCache.delete(cacheKey(sessionId, auth));
    return null;
  }
  return cached.session;
}

function writeCachedSession(session: OrchestrationSession): void {
  sessionCache.set(`${session.userId}:${session.id}`, {
    session,
    exp: Date.now() + SESSION_CACHE_TTL_MS,
  });
}

function invalidateCachedSession(sessionId: string, auth: AuthContext): void {
  sessionCache.delete(cacheKey(sessionId, auth));
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeTranscriptEntry(value: unknown): OrchestrationTranscriptEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const role = row["role"];
  const content = row["content"];
  const ts = row["ts"];

  if (
    (role !== "planner" && role !== "user" && role !== "system") ||
    typeof content !== "string" ||
    typeof ts !== "string"
  ) {
    return null;
  }

  const webSearchesRaw = row["web_searches"];
  const webSearches = Array.isArray(webSearchesRaw)
    ? webSearchesRaw
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item) => ({
          query: typeof item["query"] === "string" ? item["query"] : "",
          url: typeof item["url"] === "string" ? item["url"] : "",
          snippet: typeof item["snippet"] === "string" ? item["snippet"] : "",
        }))
        .filter((item) => item.query || item.url || item.snippet)
    : [];

  const suggestedAnswersRaw = row["suggested_answers"];
  const suggestedAnswers = Array.isArray(suggestedAnswersRaw)
    ? suggestedAnswersRaw
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];

  const defaultAnswer =
    typeof row["default_answer"] === "string" && row["default_answer"].trim()
      ? row["default_answer"].trim()
      : null;

  return {
    role,
    content,
    ts,
    ...(webSearches.length > 0 ? { web_searches: webSearches } : {}),
    ...(suggestedAnswers.length > 0 ? { suggested_answers: suggestedAnswers } : {}),
    ...(defaultAnswer ? { default_answer: defaultAnswer } : {}),
  };
}

function normalizeTranscript(value: unknown): OrchestrationTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeTranscriptEntry(entry))
    .filter((entry): entry is OrchestrationTranscriptEntry => Boolean(entry));
}

function normalizePlan(value: unknown): OrchestrationPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row["title"] !== "string" || typeof row["summary"] !== "string") {
    return null;
  }

  const phases = Array.isArray(row["phases"])
    ? row["phases"]
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item) => ({
          id: typeof item["id"] === "string" ? item["id"] : "",
          name: typeof item["name"] === "string" ? item["name"] : "",
          outputs: Array.isArray(item["outputs"]) ? item["outputs"].filter((v): v is string => typeof v === "string") : [],
        }))
        .filter((item) => item.id && item.name)
    : [];

  const successCriteria = Array.isArray(row["success_criteria"])
    ? row["success_criteria"]
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item) => ({
          id: typeof item["id"] === "string" ? item["id"] : "",
          text: typeof item["text"] === "string" ? item["text"] : "",
          weight: typeof item["weight"] === "number" ? Math.max(1, Math.min(3, Math.trunc(item["weight"]))) : 1,
        }))
        .filter((item) => item.id && item.text)
    : [];

  return {
    title: row["title"],
    summary: row["summary"],
    phases,
    success_criteria: successCriteria,
    constraints: Array.isArray(row["constraints"]) ? row["constraints"].filter((v): v is string => typeof v === "string") : [],
    risks: Array.isArray(row["risks"]) ? row["risks"].filter((v): v is string => typeof v === "string") : [],
    stack_decisions: Array.isArray(row["stack_decisions"])
      ? row["stack_decisions"]
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
          .map((item) => ({
            decision: typeof item["decision"] === "string" ? item["decision"] : "",
            rationale: typeof item["rationale"] === "string" ? item["rationale"] : "",
          }))
          .filter((item) => item.decision && item.rationale)
      : [],
    open_questions: Array.isArray(row["open_questions"]) ? row["open_questions"].filter((v): v is string => typeof v === "string") : [],
    first_actor: row["first_actor"] === "claude" ? "claude" : "chatgpt",
    max_iterations:
      typeof row["max_iterations"] === "number"
        ? Math.min(8, Math.max(1, Math.trunc(row["max_iterations"])))
        : 4,
    web_research: Array.isArray(row["web_research"])
      ? row["web_research"]
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
          .map((item) => ({
            url: typeof item["url"] === "string" ? item["url"] : "",
            summary: typeof item["summary"] === "string" ? item["summary"] : "",
          }))
          .filter((item) => item.url && item.summary)
      : [],
  };
}

function mapSessionRow(row: OrchestrationSessionRow): OrchestrationSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    goal: row.goal,
    status: row.status,
    transcript: normalizeTranscript(row.transcript),
    plan: normalizePlan(row.plan),
    collabTaskId: row.collab_task_id,
    metadata: normalizeObject(row.metadata),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function latestPlannerQuestion(session: OrchestrationSession): {
  question: string;
  suggested_answers?: string[];
  default_answer?: string | null;
} | null {
  const plannerEntry = [...session.transcript].reverse().find((entry) => entry.role === "planner");
  if (!plannerEntry) return null;
  return {
    question: plannerEntry.content,
    ...(plannerEntry.suggested_answers?.length ? { suggested_answers: plannerEntry.suggested_answers } : {}),
    ...(plannerEntry.default_answer ? { default_answer: plannerEntry.default_answer } : {}),
  };
}

function toPlannerTurns(transcript: OrchestrationTranscriptEntry[]): PlannerTurn[] {
  return transcript.map((entry) => ({
    role: entry.role,
    content: entry.content,
    ts: entry.ts,
    web_searches: entry.web_searches,
    suggested_answers: entry.suggested_answers,
    default_answer: entry.default_answer,
  }));
}

function countPlannerQuestions(transcript: OrchestrationTranscriptEntry[]): number {
  return transcript.filter((entry) => entry.role === "planner").length;
}

function readWebSearchCount(metadata: Record<string, unknown>): number {
  const count = metadata["web_search_count"];
  if (typeof count !== "number" || !Number.isFinite(count)) return 0;
  return Math.max(0, Math.trunc(count));
}

function normalizeProviderRoles(value: unknown): { chatgpt?: string; claude?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const chatgpt = typeof row["chatgpt"] === "string" ? row["chatgpt"].trim() : "";
  const claude = typeof row["claude"] === "string" ? row["claude"].trim() : "";
  return {
    ...(chatgpt ? { chatgpt } : {}),
    ...(claude ? { claude } : {}),
  };
}

function normalizeRoleSelection(value: unknown): OrchestrationRoleSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const chatgptRole = typeof row["chatgpt_role"] === "string" ? row["chatgpt_role"].trim() : "";
  const claudeRole = typeof row["claude_role"] === "string" ? row["claude_role"].trim() : "";
  const recommendation = row["first_actor_recommendation"] === "claude" ? "claude" : "chatgpt";
  const selectedFirstActor = row["selected_first_actor"] === "claude" ? "claude" : recommendation;
  const selectionMode = row["selection_mode"] === "user_override" ? "user_override" : "auto";
  if (!chatgptRole || !claudeRole) return undefined;
  return {
    chatgpt_role: chatgptRole,
    claude_role: claudeRole,
    first_actor_recommendation: recommendation,
    selected_first_actor: selectedFirstActor,
    selection_mode: selectionMode,
  };
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function fetchSessionRow(sessionId: string, auth: AuthContext): Promise<OrchestrationSessionRow | null> {
  const result = await pool.query<OrchestrationSessionRow>(
    `SELECT *
     FROM orchestration_sessions
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [sessionId, auth.userId]
  );
  return result.rows[0] ?? null;
}

export function buildSessionFallbackContext(session: OrchestrationSession): OrchestratorFallbackContext {
  const latestQuestion = latestPlannerQuestion(session);
  const roleSelection = normalizeRoleSelection(session.metadata["role_selection"]);
  return {
    session_id: session.id,
    goal: session.goal,
    status: session.status,
    question: latestQuestion?.question ?? null,
    plan_summary: session.plan?.summary ?? null,
    success_criteria: session.plan?.success_criteria ?? [],
    open_questions: session.plan?.open_questions ?? [],
    ...(roleSelection ? { role_selection: roleSelection } : {}),
  };
}

export async function getSession(sessionId: string, auth: AuthContext): Promise<OrchestrationSession | null> {
  const cached = readCachedSession(sessionId, auth);
  if (cached) return cached;

  const row = await fetchSessionRow(sessionId, auth);
  if (!row) return null;
  const session = mapSessionRow(row);

  if (session.status === "RUNNING" && session.collabTaskId) {
    const task = await getCollabTask(session.collabTaskId, auth);
    if (task?.state === "DONE") {
      const doneResult = await pool.query<OrchestrationSessionRow>(
        `UPDATE orchestration_sessions
         SET status = 'DONE',
             updated_at = now()
         WHERE id = $1
           AND user_id = $2
         RETURNING *`,
        [session.id, auth.userId]
      );
      if (doneResult.rows[0]) {
        const doneSession = mapSessionRow(doneResult.rows[0]);
        writeCachedSession(doneSession);
        return doneSession;
      }
    }
  }

  writeCachedSession(session);
  return session;
}

export async function listSessions(
  input: { filter?: OrchestrationFilter },
  auth: AuthContext
): Promise<OrchestrationSession[]> {
  const filter = input.filter ?? "all";
  let where = "tenant_id = $1 AND user_id = $2";

  if (filter === "active") {
    where += " AND status IN ('INTERVIEWING', 'PLAN_READY', 'RUNNING')";
  } else if (filter === "done") {
    where += " AND status IN ('DONE', 'ABORTED')";
  }

  const result = await pool.query<OrchestrationSessionRow>(
    `SELECT *
     FROM orchestration_sessions
     WHERE ${where}
     ORDER BY updated_at DESC
     LIMIT 50`,
    [auth.tenantId, auth.userId]
  );

  return result.rows.map(mapSessionRow);
}

export async function startSession(
  input: {
    goal: string;
    sourcePlatform: OrchestrationSourcePlatform;
    firstActorPreference?: CollabModelActor;
    initialContext?: string | null;
    comments?: string | null;
    providerRoles?: OrchestrationProviderRoles | null;
  },
  auth: AuthContext
): Promise<{
  session: OrchestrationSession;
  firstQuestion: string;
  firstQuestionData?: { question: string; suggested_answers?: string[]; default_answer?: string | null };
  roleSelection: OrchestrationRoleSelection;
}> {
  const goal = input.goal.trim();
  if (!goal) {
    throw new Error("goal is required");
  }

  const roleSuggestion = await suggestSessionRoles({
    title: goal,
    brief: input.initialContext ?? null,
    comments: input.comments ?? null,
  });
  const requestedProviderRoles = normalizeProviderRoles(input.providerRoles);
  const roleSelection: OrchestrationRoleSelection = {
    chatgpt_role: requestedProviderRoles.chatgpt ?? roleSuggestion.chatgpt_role,
    claude_role: requestedProviderRoles.claude ?? roleSuggestion.claude_role,
    first_actor_recommendation: roleSuggestion.first_actor_recommendation,
    selected_first_actor: input.firstActorPreference ?? roleSuggestion.first_actor_recommendation,
    selection_mode: input.firstActorPreference ? "user_override" : "auto",
  };

  const now = new Date().toISOString();
  const systemTurns: OrchestrationTranscriptEntry[] = [];
  if (input.initialContext && input.initialContext.trim()) {
    systemTurns.push({ role: "system", content: `Initial context: ${input.initialContext.trim()}`, ts: now });
  }
  systemTurns.push({
    role: "system",
    content:
      "Provider role assignment: " +
      `ChatGPT role: ${roleSelection.chatgpt_role}; ` +
      `Claude role: ${roleSelection.claude_role}; ` +
      `recommended first actor: ${roleSelection.first_actor_recommendation}; ` +
      `selected first actor: ${roleSelection.selected_first_actor}. ` +
      "The selected first actor owns the grill-me interview before collab execution starts.",
    ts: now,
  });

  const result = await runPlannerStep({
    mode: "interview",
    goal,
    transcript: toPlannerTurns(systemTurns),
    webSearchBudget: config.plannerWebSearchBudget,
  });

  const plannerTurn: OrchestrationTranscriptEntry = {
    role: "planner",
    content: result.kind === "question" ? result.question : "Plan ready.",
    ts: new Date().toISOString(),
    ...(result.web_searches.length > 0 ? { web_searches: result.web_searches } : {}),
    ...(result.kind === "question" && result.suggested_answers.length > 0
      ? { suggested_answers: result.suggested_answers }
      : {}),
    ...(result.kind === "question" && result.default_answer
      ? { default_answer: result.default_answer }
      : {}),
  };

  const metadata = {
    web_search_count: result.web_searches.length,
    planner_model: config.plannerModel,
    source_platform: input.sourcePlatform,
    first_actor_preference: input.firstActorPreference ?? null,
    comments: normalizeOptionalText(input.comments),
    provider_roles: {
      chatgpt: roleSelection.chatgpt_role,
      claude: roleSelection.claude_role,
    },
    role_selection: roleSelection,
  };

  const initialPlan = result.kind === "plan" ? result.plan : null;
  const status: OrchestrationStatus = result.kind === "plan" ? "PLAN_READY" : "INTERVIEWING";

  const insert = await pool.query<OrchestrationSessionRow>(
    `INSERT INTO orchestration_sessions (
      tenant_id,
      user_id,
      goal,
      status,
      transcript,
      plan,
      metadata
    )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
     RETURNING *`,
    [
      auth.tenantId,
      auth.userId,
      goal,
      status,
      JSON.stringify([...systemTurns, plannerTurn]),
      initialPlan ? JSON.stringify(initialPlan) : null,
      JSON.stringify(metadata),
    ]
  );

  const session = mapSessionRow(insert.rows[0]);
  writeCachedSession(session);

  return {
    session,
    firstQuestion: result.kind === "question" ? result.question : "Plan is ready for review.",
    roleSelection,
    firstQuestionData:
      result.kind === "question"
        ? {
            question: result.question,
            ...(result.suggested_answers.length > 0 ? { suggested_answers: result.suggested_answers } : {}),
            ...(result.default_answer ? { default_answer: result.default_answer } : {}),
          }
        : undefined,
  };
}

export async function submitAnswer(
  sessionId: string,
  answer: string,
  auth: AuthContext
): Promise<{
  session: OrchestrationSession;
  nextQuestion?: string;
  nextQuestionData?: { question: string; suggested_answers?: string[]; default_answer?: string | null };
  planReady?: true;
  plan?: OrchestrationPlan;
}> {
  const trimmed = answer.trim();
  if (!trimmed) {
    throw new Error("answer is required");
  }

  const current = await getSession(sessionId, auth);
  if (!current) {
    throw new OrchestrationNotFoundError();
  }
  if (current.status !== "INTERVIEWING") {
    throw new OrchestrationConflictError("Session is not currently interviewing");
  }

  const userEntry: OrchestrationTranscriptEntry = {
    role: "user",
    content: trimmed,
    ts: new Date().toISOString(),
  };

  const transcript = [...current.transcript, userEntry];
  const questionCount = countPlannerQuestions(transcript);
  const mode = questionCount >= config.plannerMaxQuestions ? "finalize" : "interview";
  const metadata = current.metadata;
  const currentWebSearchCount = readWebSearchCount(metadata);
  const remainingSearchBudget = Math.max(0, config.plannerWebSearchBudget - currentWebSearchCount);

  const plannerResult = await runPlannerStep({
    mode,
    goal: current.goal,
    transcript: toPlannerTurns(transcript),
    webSearchBudget: remainingSearchBudget,
  });

  const plannerEntry: OrchestrationTranscriptEntry = {
    role: "planner",
    content: plannerResult.kind === "question" ? plannerResult.question : "Plan ready.",
    ts: new Date().toISOString(),
    ...(plannerResult.web_searches.length > 0 ? { web_searches: plannerResult.web_searches } : {}),
    ...(plannerResult.kind === "question" && plannerResult.suggested_answers.length > 0
      ? { suggested_answers: plannerResult.suggested_answers }
      : {}),
    ...(plannerResult.kind === "question" && plannerResult.default_answer
      ? { default_answer: plannerResult.default_answer }
      : {}),
  };

  const nextTranscript = [...transcript, plannerEntry];
  const nextStatus: OrchestrationStatus = plannerResult.kind === "plan" ? "PLAN_READY" : "INTERVIEWING";
  const nextMetadata = {
    ...metadata,
    web_search_count: currentWebSearchCount + plannerResult.web_searches.length,
  };

  const updateResult = await pool.query<OrchestrationSessionRow>(
    `UPDATE orchestration_sessions
     SET transcript = $3::jsonb,
         status = $4,
         plan = CASE WHEN $5::jsonb IS NULL THEN plan ELSE $5::jsonb END,
         metadata = $6::jsonb,
         error_message = NULL,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
       AND status = 'INTERVIEWING'
     RETURNING *`,
    [
      current.id,
      auth.userId,
      JSON.stringify(nextTranscript),
      nextStatus,
      plannerResult.kind === "plan" ? JSON.stringify(plannerResult.plan) : null,
      JSON.stringify(nextMetadata),
    ]
  );

  const row = updateResult.rows[0];
  if (!row) {
    throw new OrchestrationConflictError();
  }

  const session = mapSessionRow(row);
  invalidateCachedSession(sessionId, auth);
  writeCachedSession(session);

  if (plannerResult.kind === "plan") {
    return { session, planReady: true, plan: plannerResult.plan };
  }

  return {
    session,
    nextQuestion: plannerResult.question,
    nextQuestionData: {
      question: plannerResult.question,
      ...(plannerResult.suggested_answers.length > 0
        ? { suggested_answers: plannerResult.suggested_answers }
        : {}),
      ...(plannerResult.default_answer ? { default_answer: plannerResult.default_answer } : {}),
    },
  };
}

function buildTaskContextArtifacts(
  plan: OrchestrationPlan,
  setup: { comments?: string; provider_roles?: { chatgpt?: string; claude?: string } }
): Record<string, unknown> {
  return {
    plan,
    success_criteria: plan.success_criteria,
    evaluations: [],
    setup,
  };
}

function setupSnapshotFromMetadata(metadata: Record<string, unknown>): {
  comments?: string;
  provider_roles?: { chatgpt?: string; claude?: string };
} {
  const comments = normalizeOptionalText(metadata["comments"]);
  const providerRoles = normalizeProviderRoles(metadata["provider_roles"]);
  return {
    ...(comments ? { comments } : {}),
    ...(providerRoles.chatgpt || providerRoles.claude ? { provider_roles: providerRoles } : {}),
  };
}

async function attachPlanToTaskContext(
  task: CollabTask,
  sessionId: string,
  plan: OrchestrationPlan,
  setup: { comments?: string; provider_roles?: { chatgpt?: string; claude?: string } },
  auth: AuthContext
): Promise<CollabTask> {
  const result = await pool.query<{ id: string } & Record<string, unknown>>(
    `UPDATE collab_tasks
     SET context =
       COALESCE(context, '{}'::jsonb)
       || jsonb_build_object(
         'artifacts',
         COALESCE(context->'artifacts', '{}'::jsonb) || $3::jsonb,
         'orchestration',
         jsonb_build_object('session_id', $4::text)
       ),
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
     RETURNING id`,
    [task.id, auth.userId, JSON.stringify(buildTaskContextArtifacts(plan, setup)), sessionId]
  );

  if (!result.rows[0]) return task;
  const refreshed = await getCollabTask(task.id, auth);
  return refreshed ?? task;
}

export async function approvePlan(
  sessionId: string,
  auth: AuthContext,
  overrides?: Partial<Pick<OrchestrationPlan, "first_actor">>
): Promise<{ session: OrchestrationSession; task: CollabTask }> {
  const session = await getSession(sessionId, auth);
  if (!session) {
    throw new OrchestrationNotFoundError();
  }
  if (session.status === "RUNNING" && session.collabTaskId) {
    const task = await getCollabTask(session.collabTaskId, auth);
    if (task) {
      return { session, task };
    }
  }
  if (session.status !== "PLAN_READY") {
    throw new OrchestrationConflictError("Session is not ready for approval");
  }
  if (!session.plan) {
    throw new OrchestrationInvalidPlanError(
      "Session plan is missing. Continue the grill-me flow to regenerate a plan before approval."
    );
  }
  if (!session.plan.title?.trim() || !session.plan.summary?.trim()) {
    throw new OrchestrationInvalidPlanError(
      "Session plan is incomplete. Continue the grill-me flow to regenerate a complete plan before approval."
    );
  }

  const firstActor = (overrides?.first_actor ?? session.plan.first_actor) as CollabModelActor;

  const task = await createCollabTask(
    {
      title: session.plan.title,
      brief: session.plan.summary,
      firstActor,
    },
    auth
  );

  const setup = setupSnapshotFromMetadata(session.metadata);
  const taskWithPlan = await attachPlanToTaskContext(task, session.id, session.plan, setup, auth);

  const update = await pool.query<OrchestrationSessionRow>(
    `UPDATE orchestration_sessions
     SET status = 'RUNNING',
         collab_task_id = $3,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
       AND status = 'PLAN_READY'
     RETURNING *`,
    [session.id, auth.userId, task.id]
  );

  const row = update.rows[0];
  if (!row) {
    throw new OrchestrationConflictError();
  }

  const nextSession = mapSessionRow(row);
  invalidateCachedSession(sessionId, auth);
  writeCachedSession(nextSession);
  return { session: nextSession, task: taskWithPlan };
}

export async function suggestSessionRoles(input: {
  title: string;
  brief?: string | null;
  comments?: string | null;
}): Promise<ProviderRoleSuggestion> {
  const title = input.title.trim();
  if (!title) {
    throw new Error("title is required");
  }

  try {
    return await suggestProviderRoles({
      title,
      brief: input.brief ?? null,
      comments: input.comments ?? null,
    });
  } catch {
    const summaryText = [input.brief ?? "", input.comments ?? ""].join(" ").toLowerCase();
    const technicalHint = /(api|schema|db|database|migration|backend|auth|infra|typescript|test|contract|route)/.test(summaryText);
    return {
      chatgpt_role: "Explore alternatives, expand options, and draft creative first-pass outputs.",
      claude_role: "Stress-test assumptions, tighten technical details, and finalize implementation-ready output.",
      first_actor_recommendation: technicalHint ? "claude" : "chatgpt",
    };
  }
}

export async function abortSession(
  sessionId: string,
  auth: AuthContext,
  reason?: string
): Promise<OrchestrationSession> {
  const result = await pool.query<OrchestrationSessionRow>(
    `UPDATE orchestration_sessions
     SET status = 'ABORTED',
         error_message = CASE
           WHEN $3::text IS NULL OR $3::text = '' THEN error_message
           ELSE $3::text
         END,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
       AND status IN ('DRAFT', 'INTERVIEWING', 'PLAN_READY', 'RUNNING')
     RETURNING *`,
    [sessionId, auth.userId, reason ?? null]
  );

  const row = result.rows[0];
  if (!row) {
    const existing = await getSession(sessionId, auth);
    if (!existing) throw new OrchestrationNotFoundError();
    return existing;
  }

  const session = mapSessionRow(row);
  invalidateCachedSession(sessionId, auth);
  writeCachedSession(session);
  return session;
}
