import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import {
  approveWorkflowRunById,
  createExplicitWorkflow,
  createWorkflowRun,
  listActiveWorkflows,
  listWorkflowRuns,
  skipWorkflowRunById,
  type WorkflowRunView,
  type WorkflowView,
} from "../workflow-automation.js";

type BuilderSessionStatus = "draft" | "saved" | "archived";
type WorkflowActor = "user" | "builder" | "critic" | "assistant";

interface BuilderTranscriptEntry {
  actor: WorkflowActor;
  content: string;
  ts: string;
}

interface WorkflowDraft {
  title: string;
  instruction: string;
  scheduleRrule: string;
  outputType: string;
  sources: string[];
  approvalBehavior: "always_approve" | "auto_after_streak";
}

interface BuilderTurnResult {
  assistantReply: string;
  draft: WorkflowDraft;
  builderInternal: string;
}

interface CriticTurnResult {
  critique: string;
  riskLevel: "low" | "medium" | "high";
}

export interface WorkflowBuilderSessionView {
  id: string;
  status: BuilderSessionStatus;
  title: string;
  goal: string;
  transcript: BuilderTranscriptEntry[];
  draft: WorkflowDraft;
  debate: Array<{ builder: string; critic: string; ts: string }>;
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_DRAFT: WorkflowDraft = {
  title: "Recurring Workflow",
  instruction: "Produce the requested recurring output and keep it concise and actionable.",
  scheduleRrule: "FREQ=WEEKLY;BYDAY=MO",
  outputType: "text",
  sources: [],
  approvalBehavior: "always_approve",
};

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeTranscript(value: unknown): BuilderTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = readObject(entry);
    const actor = row.actor;
    const content = row.content;
    const ts = row.ts;
    if (
      (actor === "user" || actor === "builder" || actor === "critic" || actor === "assistant") &&
      typeof content === "string" &&
      typeof ts === "string"
    ) {
      return [{ actor, content, ts }];
    }
    return [];
  });
}

function normalizeDraft(value: unknown): WorkflowDraft {
  const row = readObject(value);
  return {
    title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : DEFAULT_DRAFT.title,
    instruction: typeof row.instruction === "string" && row.instruction.trim() ? row.instruction.trim() : DEFAULT_DRAFT.instruction,
    scheduleRrule: typeof row.scheduleRrule === "string" && row.scheduleRrule.trim() ? row.scheduleRrule.trim() : DEFAULT_DRAFT.scheduleRrule,
    outputType: typeof row.outputType === "string" && row.outputType.trim() ? row.outputType.trim() : DEFAULT_DRAFT.outputType,
    sources: Array.isArray(row.sources) ? row.sources.filter((v): v is string => typeof v === "string") : [],
    approvalBehavior: row.approvalBehavior === "auto_after_streak" ? "auto_after_streak" : "always_approve",
  };
}

function normalizeDebate(value: unknown): Array<{ builder: string; critic: string; ts: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = readObject(entry);
    if (typeof row.builder === "string" && typeof row.critic === "string" && typeof row.ts === "string") {
      return [{ builder: row.builder, critic: row.critic, ts: row.ts }];
    }
    return [];
  });
}

function mapSessionRow(row: {
  id: string;
  status: string;
  title: string;
  goal: string;
  transcript_json: unknown;
  draft_json: unknown;
  debate_json: unknown;
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
}): WorkflowBuilderSessionView {
  return {
    id: row.id,
    status: row.status === "saved" || row.status === "archived" ? row.status : "draft",
    title: row.title,
    goal: row.goal,
    transcript: normalizeTranscript(row.transcript_json),
    draft: normalizeDraft(row.draft_json),
    debate: normalizeDebate(row.debate_json),
    workflowId: row.workflow_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonResult<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (!fenced) return fallback;
    try {
      return JSON.parse(fenced) as T;
    } catch {
      return fallback;
    }
  }
}

async function runBuilderTurn(input: {
  goal: string;
  userMessage: string;
  currentDraft: WorkflowDraft;
}): Promise<BuilderTurnResult> {
  const response = await aiProviderRegistry.chat({
    model: aiProviderRegistry.chatModelName(),
    responseFormat: "json_object",
    messages: [
      {
        role: "system",
        content: [
          "You are Builder AI. Convert user intent into a recurring workflow draft.",
          "Output strict JSON with keys: assistantReply, builderInternal, draft.",
          "draft keys: title, instruction, scheduleRrule, outputType, sources (array), approvalBehavior.",
          "Keep scheduleRrule in RRULE format such as FREQ=WEEKLY;BYDAY=MO.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          goal: input.goal,
          userMessage: input.userMessage,
          currentDraft: input.currentDraft,
        }),
      },
    ],
  });

  const parsed = parseJsonResult<Partial<BuilderTurnResult> & { draft?: Partial<WorkflowDraft> }>(response.text, {});
  const draft = normalizeDraft(parsed.draft ?? input.currentDraft);
  return {
    assistantReply: typeof parsed.assistantReply === "string" && parsed.assistantReply.trim()
      ? parsed.assistantReply.trim()
      : "Draft updated.",
    builderInternal: typeof parsed.builderInternal === "string" ? parsed.builderInternal : "Updated workflow shape.",
    draft,
  };
}

async function runCriticTurn(input: {
  goal: string;
  draft: WorkflowDraft;
}): Promise<CriticTurnResult> {
  const response = await aiProviderRegistry.chat({
    model: aiProviderRegistry.chatModelName(),
    responseFormat: "json_object",
    messages: [
      {
        role: "system",
        content: [
          "You are Critic AI. Challenge weak assumptions in this workflow draft.",
          "Output strict JSON with keys: critique, riskLevel.",
          "riskLevel must be one of: low, medium, high.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          goal: input.goal,
          draft: input.draft,
        }),
      },
    ],
  });

  const parsed = parseJsonResult<Partial<CriticTurnResult>>(response.text, {});
  return {
    critique: typeof parsed.critique === "string" && parsed.critique.trim()
      ? parsed.critique.trim()
      : "No major risk found; validate schedule and expected output.",
    riskLevel: parsed.riskLevel === "high" || parsed.riskLevel === "medium" || parsed.riskLevel === "low"
      ? parsed.riskLevel
      : "medium",
  };
}

export async function createWorkflowBuilderSession(input: {
  auth: AuthContext;
  title?: string;
  goal: string;
}): Promise<WorkflowBuilderSessionView> {
  const id = randomUUID();
  const title = (input.title ?? input.goal).trim().slice(0, 180);
  const transcript: BuilderTranscriptEntry[] = [];
  const now = new Date().toISOString();

  await pool.query(
    `INSERT INTO workflow_builder_sessions
     (id, tenant_id, user_id, status, title, goal, transcript_json, draft_json, debate_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz, $10::timestamptz)`,
    [
      id,
      input.auth.tenantId,
      input.auth.userId,
      title || "Workflow Builder Session",
      input.goal,
      JSON.stringify(transcript),
      JSON.stringify(DEFAULT_DRAFT),
      JSON.stringify([]),
      now,
      now,
    ]
  );

  const created = await getWorkflowBuilderSession(input.auth, id);
  if (!created) throw new Error("Failed to create builder session");
  return created;
}

export async function listWorkflowBuilderSessions(auth: AuthContext): Promise<WorkflowBuilderSessionView[]> {
  const result = await pool.query<{
    id: string;
    status: string;
    title: string;
    goal: string;
    transcript_json: unknown;
    draft_json: unknown;
    debate_json: unknown;
    workflow_id: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, status, title, goal, transcript_json, draft_json, debate_json, workflow_id, created_at, updated_at
     FROM workflow_builder_sessions
     WHERE tenant_id = $1
       AND user_id = $2
     ORDER BY updated_at DESC
     LIMIT 50`,
    [auth.tenantId, auth.userId]
  );
  return result.rows.map(mapSessionRow);
}

export async function getWorkflowBuilderSession(auth: AuthContext, sessionId: string): Promise<WorkflowBuilderSessionView | null> {
  const result = await pool.query<{
    id: string;
    status: string;
    title: string;
    goal: string;
    transcript_json: unknown;
    draft_json: unknown;
    debate_json: unknown;
    workflow_id: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, status, title, goal, transcript_json, draft_json, debate_json, workflow_id, created_at, updated_at
     FROM workflow_builder_sessions
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [sessionId, auth.tenantId, auth.userId]
  );
  const row = result.rows[0];
  return row ? mapSessionRow(row) : null;
}

export async function appendWorkflowBuilderMessage(input: {
  auth: AuthContext;
  sessionId: string;
  message: string;
}): Promise<WorkflowBuilderSessionView> {
  const session = await getWorkflowBuilderSession(input.auth, input.sessionId);
  if (!session) throw new Error("Workflow builder session not found");
  if (session.status === "archived") throw new Error("Workflow builder session is archived");

  const now = new Date().toISOString();
  const userEntry: BuilderTranscriptEntry = { actor: "user", content: input.message.trim(), ts: now };
  const builder = await runBuilderTurn({
    goal: session.goal,
    userMessage: input.message.trim(),
    currentDraft: session.draft,
  });
  const critic = await runCriticTurn({
    goal: session.goal,
    draft: builder.draft,
  });

  const transcript = [
    ...session.transcript,
    userEntry,
    { actor: "builder", content: builder.builderInternal, ts: now } as BuilderTranscriptEntry,
    { actor: "critic", content: critic.critique, ts: now } as BuilderTranscriptEntry,
    {
      actor: "assistant",
      content: `${builder.assistantReply}\n\nCritic note (${critic.riskLevel} risk): ${critic.critique}`,
      ts: now,
    } as BuilderTranscriptEntry,
  ];

  const debate = [...session.debate, { builder: builder.builderInternal, critic: critic.critique, ts: now }];
  await pool.query(
    `UPDATE workflow_builder_sessions
     SET transcript_json = $4::jsonb,
         draft_json = $5::jsonb,
         debate_json = $6::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [session.id, input.auth.tenantId, input.auth.userId, JSON.stringify(transcript), JSON.stringify(builder.draft), JSON.stringify(debate)]
  );

  const updated = await getWorkflowBuilderSession(input.auth, session.id);
  if (!updated) throw new Error("Failed to update workflow builder session");
  return updated;
}

export async function saveWorkflowFromBuilderSession(input: {
  auth: AuthContext;
  sessionId: string;
}): Promise<{ session: WorkflowBuilderSessionView; workflow: WorkflowView }> {
  const session = await getWorkflowBuilderSession(input.auth, input.sessionId);
  if (!session) throw new Error("Workflow builder session not found");

  let workflowId = session.workflowId;
  if (!workflowId) {
    const created = await createExplicitWorkflow({
      auth: input.auth,
      title: session.draft.title,
      instruction: session.draft.instruction,
      scheduleRrule: session.draft.scheduleRrule,
      requiresConnector: false,
    });
    workflowId = created.workflowId;
  }

  await pool.query(
    `UPDATE workflows
     SET metadata_json = metadata_json || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [
      workflowId,
      input.auth.tenantId,
      input.auth.userId,
      JSON.stringify({
        workflow_dna: {
          outputType: session.draft.outputType,
          sources: session.draft.sources,
          approvalBehavior: session.draft.approvalBehavior,
        },
        source: "manual_builder_v1",
      }),
    ]
  );

  await pool.query(
    `UPDATE workflow_builder_sessions
     SET status = 'saved',
         workflow_id = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [session.id, input.auth.tenantId, input.auth.userId, workflowId]
  );

  const workflows = await listActiveWorkflows(input.auth);
  const workflow = workflows.find((item) => item.id === workflowId);
  const updatedSession = await getWorkflowBuilderSession(input.auth, session.id);
  if (!workflow || !updatedSession) throw new Error("Failed to save workflow from builder session");
  return { workflow, session: updatedSession };
}

export async function setWorkflowStatus(input: {
  auth: AuthContext;
  workflowId: string;
  status: "active" | "paused" | "archived";
}): Promise<void> {
  await pool.query(
    `UPDATE workflows
     SET status = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [input.workflowId, input.auth.tenantId, input.auth.userId, input.status]
  );
}

export async function runWorkflowNow(input: {
  auth: AuthContext;
  workflowId: string;
}): Promise<WorkflowRunView> {
  return createWorkflowRun({
    auth: input.auth,
    workflowId: input.workflowId,
    runMode: "manual",
    scheduledFor: null,
  });
}

export async function listWorkflowsWithRuns(auth: AuthContext): Promise<Array<WorkflowView & { latestRun: WorkflowRunView | null }>> {
  const workflows = await listActiveWorkflows(auth);
  const enriched = await Promise.all(workflows.map(async (workflow) => {
    const runs = await listWorkflowRuns(auth, workflow.id);
    return {
      ...workflow,
      latestRun: runs[0] ?? null,
    };
  }));
  return enriched;
}

export async function approveRunById(input: {
  auth: AuthContext;
  runId: string;
}): Promise<WorkflowRunView> {
  return approveWorkflowRunById({
    auth: input.auth,
    runId: input.runId,
    channel: "chat",
  });
}

export async function skipRunById(input: {
  auth: AuthContext;
  runId: string;
}): Promise<WorkflowRunView> {
  return skipWorkflowRunById({
    auth: input.auth,
    runId: input.runId,
    channel: "chat",
  });
}

