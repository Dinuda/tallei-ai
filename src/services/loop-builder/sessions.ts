import { randomUUID } from "crypto";
import type { UIMessage } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { createComposioSession } from "../connectors/composio-session.js";
import type { LoopIntentAnalysis, LoopIntentContext } from "../loop-engine/intent-context.js";
import type { ToolContract } from "../tool-spec/types.js";
import type { LoopBuilderProposal } from "./intent-resolver.js";
import type { LoopSpecView } from "./specs.js";

export type WorkflowBuilderPhase =
  | "new"
  | "analyzing"
  | "needs_clarification"
  | "intent_resolved"
  | "spec_drafted"
  | "spec_approved"
  | "graph_generated"
  | "saved"
  | "archived"
  | "failed";

export type WorkflowBuilderSession = {
  id: string;
  phase: WorkflowBuilderPhase;
  title: string;
  goal: string;
  composioSessionId: string;
  workflowRunId: string | null;
  specId: string | null;
  workflowId: string | null;
  intentAnalysis: LoopIntentAnalysis | null;
  resolvedIntent: LoopIntentContext | null;
  discoveredToolContracts: ToolContract[];
  currentProposal: LoopBuilderProposal | null;
  error: { message: string } | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type SessionRow = {
  id: string;
  phase: WorkflowBuilderPhase;
  title: string;
  goal: string;
  composio_session_id: string | null;
  workflow_run_id: string | null;
  spec_id: string | null;
  workflow_id: string | null;
  intent_analysis_json: LoopIntentAnalysis | null;
  resolved_intent_json: LoopIntentContext | null;
  discovered_tool_contracts_json: ToolContract[];
  current_proposal_json: LoopBuilderProposal | null;
  error_json: { message: string } | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapSession(row: SessionRow): WorkflowBuilderSession {
  if (!row.composio_session_id) throw new Error(`Builder session ${row.id} has no Composio session`);
  return {
    id: row.id,
    phase: row.phase,
    title: row.title,
    goal: row.goal,
    composioSessionId: row.composio_session_id,
    workflowRunId: row.workflow_run_id,
    specId: row.spec_id,
    workflowId: row.workflow_id,
    intentAnalysis: row.intent_analysis_json,
    resolvedIntent: row.resolved_intent_json,
    discoveredToolContracts: row.discovered_tool_contracts_json ?? [],
    currentProposal: row.current_proposal_json,
    error: row.error_json,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const SESSION_COLUMNS = `id, phase, title, goal, composio_session_id, workflow_run_id, spec_id, workflow_id,
  intent_analysis_json, resolved_intent_json, discovered_tool_contracts_json, current_proposal_json,
  error_json, revision, created_at, updated_at`;

export async function createWorkflowBuilderSession(auth: AuthContext, goal: string): Promise<WorkflowBuilderSession> {
  const normalizedGoal = goal.trim();
  if (!normalizedGoal) throw new Error("A loop-building request is required");
  const composio = await createComposioSession(auth);
  const id = randomUUID();
  const result = await pool.query<SessionRow>(
    `INSERT INTO workflow_builder_sessions
       (id, tenant_id, user_id, phase, title, goal, composio_session_id)
     VALUES ($1, $2, $3, 'new', $4, $5, $6)
     RETURNING ${SESSION_COLUMNS}`,
    [id, auth.tenantId, auth.userId, normalizedGoal.slice(0, 100), normalizedGoal, composio.sessionId],
  );
  return mapSession(result.rows[0]!);
}

export async function getWorkflowBuilderSession(auth: AuthContext, sessionId: string): Promise<WorkflowBuilderSession | null> {
  const result = await pool.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM workflow_builder_sessions
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [sessionId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

export async function requireWorkflowBuilderSession(auth: AuthContext, sessionId: string): Promise<WorkflowBuilderSession> {
  const session = await getWorkflowBuilderSession(auth, sessionId);
  if (!session) throw new Error("Workflow builder session not found");
  return session;
}

export async function findWorkflowBuilderSessionBySpec(auth: AuthContext, specId: string): Promise<WorkflowBuilderSession | null> {
  const result = await pool.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM workflow_builder_sessions
     WHERE spec_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY updated_at DESC
     LIMIT 1`,
    [specId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

export async function updateWorkflowBuilderSession(
  auth: AuthContext,
  sessionId: string,
  patch: {
    phase?: WorkflowBuilderPhase;
    workflowRunId?: string | null;
    spec?: LoopSpecView | null;
    workflowId?: string | null;
    intentAnalysis?: LoopIntentAnalysis | null;
    resolvedIntent?: LoopIntentContext | null;
    discoveredToolContracts?: ToolContract[];
    currentProposal?: LoopBuilderProposal | null;
    error?: { message: string } | null;
  },
): Promise<WorkflowBuilderSession> {
  const result = await pool.query<SessionRow>(
    `UPDATE workflow_builder_sessions
     SET phase = COALESCE($4, phase),
         workflow_run_id = CASE WHEN $5::boolean THEN $6 ELSE workflow_run_id END,
         spec_id = CASE WHEN $7::boolean THEN $8::uuid ELSE spec_id END,
         workflow_id = CASE WHEN $9::boolean THEN $10::uuid ELSE workflow_id END,
         intent_analysis_json = CASE WHEN $11::boolean THEN $12::jsonb ELSE intent_analysis_json END,
         resolved_intent_json = CASE WHEN $13::boolean THEN $14::jsonb ELSE resolved_intent_json END,
         discovered_tool_contracts_json = CASE WHEN $15::boolean THEN $16::jsonb ELSE discovered_tool_contracts_json END,
         current_proposal_json = CASE WHEN $17::boolean THEN $18::jsonb ELSE current_proposal_json END,
         error_json = CASE WHEN $19::boolean THEN $20::jsonb ELSE error_json END,
         revision = revision + 1,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     RETURNING ${SESSION_COLUMNS}`,
    [
      sessionId, auth.tenantId, auth.userId, patch.phase ?? null,
      "workflowRunId" in patch, patch.workflowRunId ?? null,
      "spec" in patch, patch.spec?.id ?? null,
      "workflowId" in patch, patch.workflowId ?? null,
      "intentAnalysis" in patch, patch.intentAnalysis ? JSON.stringify(patch.intentAnalysis) : null,
      "resolvedIntent" in patch, patch.resolvedIntent ? JSON.stringify(patch.resolvedIntent) : null,
      "discoveredToolContracts" in patch, JSON.stringify(patch.discoveredToolContracts ?? []),
      "currentProposal" in patch, patch.currentProposal ? JSON.stringify(patch.currentProposal) : null,
      "error" in patch, patch.error ? JSON.stringify(patch.error) : null,
    ],
  );
  if (!result.rows[0]) throw new Error("Workflow builder session not found");
  return mapSession(result.rows[0]);
}

export async function replaceWorkflowBuilderMessages(
  auth: AuthContext,
  sessionId: string,
  messages: UIMessage[],
): Promise<void> {
  const normalizedMessages = normalizeWorkflowBuilderMessages(messages);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM workflow_builder_messages WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3`,
      [sessionId, auth.tenantId, auth.userId],
    );
    for (const message of normalizedMessages) {
      await client.query(
        `INSERT INTO workflow_builder_messages (session_id, tenant_id, user_id, message_json)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [sessionId, auth.tenantId, auth.userId, JSON.stringify(message)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWorkflowBuilderMessages(auth: AuthContext, sessionId: string): Promise<UIMessage[]> {
  const result = await pool.query<{ message_json: UIMessage }>(
    `SELECT message_json
     FROM workflow_builder_messages
     WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY sequence ASC`,
    [sessionId, auth.tenantId, auth.userId],
  );
  return normalizeWorkflowBuilderMessages(result.rows.map((row) => row.message_json));
}

export function normalizeWorkflowBuilderMessages(messages: unknown[]): UIMessage[] {
  return messages.filter((message): message is UIMessage =>
    Boolean(
      message
      && typeof message === "object"
      && "parts" in message
      && Array.isArray(message.parts)
      && message.parts.length > 0,
    )
  );
}
