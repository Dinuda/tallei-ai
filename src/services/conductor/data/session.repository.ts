import type { UIMessage } from "ai";

import type { AuthContext } from "../../../domain/auth/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import type { LoopIntentAnalysis, LoopIntentContext } from "../contracts/intent-context.js";
import type { ToolContract } from "../../tool-spec/types.js";
import type { LoopBuildContract } from "../domain/build-contract.js";
import type { LoopBuilderUsage } from "../utils/progress.js";
import type { LoopBuilderProposal } from "../services/save-loop.service.js";
import type { WorkflowBuilderPhase } from "../contracts/builder-types.js";

export type SessionRow = {
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
  build_contract_json: LoopBuildContract | null;
  current_proposal_json: LoopBuilderProposal | null;
  error_json: { message: string } | null;
  revision: number;
  analyzer_usage_json: LoopBuilderUsage | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export const SESSION_COLUMNS = `id, phase, title, goal, composio_session_id, workflow_run_id, spec_id, workflow_id,
  intent_analysis_json, resolved_intent_json, discovered_tool_contracts_json, build_contract_json, current_proposal_json,
  error_json, revision, analyzer_usage_json, created_at, updated_at`;

export async function insertWorkflowBuilderSession(
  auth: AuthContext,
  input: { id: string; title: string; goal: string; composioSessionId: string },
): Promise<SessionRow> {
  const result = await pool.query<SessionRow>(
    `INSERT INTO workflow_builder_sessions
       (id, tenant_id, user_id, phase, title, goal, composio_session_id)
     VALUES ($1, $2, $3, 'new', $4, $5, $6)
     RETURNING ${SESSION_COLUMNS}`,
    [input.id, auth.tenantId, auth.userId, input.title, input.goal, input.composioSessionId],
  );
  return result.rows[0]!;
}

export async function findWorkflowBuilderSessionRow(
  auth: AuthContext,
  sessionId: string,
): Promise<SessionRow | null> {
  const result = await pool.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM workflow_builder_sessions
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [sessionId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ?? null;
}

export async function findWorkflowBuilderSessionRowBySpec(
  auth: AuthContext,
  specId: string,
): Promise<SessionRow | null> {
  const result = await pool.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM workflow_builder_sessions
     WHERE spec_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY updated_at DESC
     LIMIT 1`,
    [specId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ?? null;
}

export async function updateWorkflowBuilderSessionRow(
  auth: AuthContext,
  sessionId: string,
  params: unknown[],
): Promise<SessionRow | null> {
  const result = await pool.query<SessionRow>(
    `UPDATE workflow_builder_sessions
     SET phase = COALESCE($4, phase),
         title = COALESCE($25, title),
         goal = COALESCE($26, goal),
         composio_session_id = CASE WHEN $5::boolean THEN $6 ELSE composio_session_id END,
         workflow_run_id = CASE WHEN $7::boolean THEN $8 ELSE workflow_run_id END,
         spec_id = CASE WHEN $9::boolean THEN $10::uuid ELSE spec_id END,
         workflow_id = CASE WHEN $11::boolean THEN $12::uuid ELSE workflow_id END,
         intent_analysis_json = CASE WHEN $13::boolean THEN $14::jsonb ELSE intent_analysis_json END,
         resolved_intent_json = CASE WHEN $15::boolean THEN $16::jsonb ELSE resolved_intent_json END,
         discovered_tool_contracts_json = CASE WHEN $17::boolean THEN $18::jsonb ELSE discovered_tool_contracts_json END,
         build_contract_json = CASE WHEN $19::boolean THEN $20::jsonb ELSE build_contract_json END,
         current_proposal_json = CASE WHEN $21::boolean THEN $22::jsonb ELSE current_proposal_json END,
         error_json = CASE WHEN $23::boolean THEN $24::jsonb ELSE error_json END,
         revision = revision + 1,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     RETURNING ${SESSION_COLUMNS}`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function updateWorkflowBuilderAnalyzerUsageRow(
  auth: AuthContext,
  sessionId: string,
  usage: LoopBuilderUsage,
): Promise<number> {
  const result = await pool.query(
    `UPDATE workflow_builder_sessions
     SET analyzer_usage_json = $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [sessionId, auth.tenantId, auth.userId, JSON.stringify(usage)],
  );
  return result.rowCount ?? 0;
}

export async function linkWorkflowBuilderSessionToLoop(
  auth: AuthContext,
  sessionId: string,
  workflowId: string,
  specId: string,
): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_sessions
     SET workflow_id = $4, spec_id = $5, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [sessionId, auth.tenantId, auth.userId, workflowId, specId],
  );
}

export async function replaceWorkflowBuilderMessageRows(
  auth: AuthContext,
  sessionId: string,
  messages: UIMessage[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM workflow_builder_messages WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3`,
      [sessionId, auth.tenantId, auth.userId],
    );
    for (const message of messages) {
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

export async function listWorkflowBuilderMessageRows(
  auth: AuthContext,
  sessionId: string,
): Promise<UIMessage[]> {
  const result = await pool.query<{ message_json: UIMessage }>(
    `SELECT message_json
     FROM workflow_builder_messages
     WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY sequence ASC`,
    [sessionId, auth.tenantId, auth.userId],
  );
  return result.rows.map((row) => row.message_json);
}
