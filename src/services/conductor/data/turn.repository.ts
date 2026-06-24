import type { AuthContext } from "../../../domain/auth/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import type { BuilderState } from "../contracts/builder-types.js";

export type BuilderTurnStatus = "running" | "completed" | "failed" | "aborted";
export type BuilderActionKind = "server_action" | "client_action" | "assistant_message";
export type BuilderActionStatus = "running" | "completed" | "failed";

export type BuilderTurnEvent = {
  type: string;
  at: string;
  data?: unknown;
};

export type BuilderActionRecord = {
  id: string;
  turn_id: string;
  session_id: string;
  action_id: string;
  state: BuilderState;
  action_name: string;
  action_kind: BuilderActionKind;
  schema_version: number;
  status: BuilderActionStatus;
  input_json: Record<string, unknown>;
  output_json: Record<string, unknown> | null;
  repair_json: Record<string, unknown> | null;
  error_text: string | null;
  expected_revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function insertBuilderTurn(input: {
  auth: AuthContext;
  id: string;
  sessionId: string;
  sessionRevision: number;
  state: BuilderState;
}): Promise<void> {
  await pool.query(
    `INSERT INTO workflow_builder_turns
       (id, session_id, tenant_id, user_id, session_revision, state, events_json)
     VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb)`,
    [input.id, input.sessionId, input.auth.tenantId, input.auth.userId, input.sessionRevision, input.state],
  );
}

export async function appendBuilderTurnEvent(
  auth: AuthContext,
  turnId: string,
  event: BuilderTurnEvent,
): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_turns
     SET events_json = COALESCE(events_json, '[]'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [turnId, auth.tenantId, auth.userId, JSON.stringify([event])],
  );
}

export async function completeBuilderTurn(
  auth: AuthContext,
  turnId: string,
  status: BuilderTurnStatus,
  error?: string,
): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_turns
     SET status = $4,
         error_text = $5,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [turnId, auth.tenantId, auth.userId, status, error ?? null],
  );
}

export async function updateBuilderTurnRepair(
  auth: AuthContext,
  turnId: string,
  repair: Record<string, unknown> | null,
): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_turns
     SET repair_json = $4::jsonb,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [turnId, auth.tenantId, auth.userId, repair ? JSON.stringify(repair) : null],
  );
}

export async function insertOrGetBuilderAction(input: {
  auth: AuthContext;
  turnId: string;
  sessionId: string;
  actionId: string;
  state: BuilderState;
  actionName: string;
  actionKind: BuilderActionKind;
  inputJson: Record<string, unknown>;
  repairJson?: Record<string, unknown> | null;
  expectedRevision: number;
}): Promise<BuilderActionRecord> {
  const result = await pool.query<BuilderActionRecord>(
    `INSERT INTO workflow_builder_actions
       (turn_id, session_id, tenant_id, user_id, action_id, state, action_name, action_kind, input_json, repair_json, expected_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
     ON CONFLICT (turn_id, action_id) DO UPDATE
       SET updated_at = workflow_builder_actions.updated_at
     RETURNING id, turn_id, session_id, action_id, state, action_name, action_kind, schema_version, status,
       input_json, output_json, repair_json, error_text, expected_revision, created_at, updated_at`,
    [
      input.turnId,
      input.sessionId,
      input.auth.tenantId,
      input.auth.userId,
      input.actionId,
      input.state,
      input.actionName,
      input.actionKind,
      JSON.stringify(input.inputJson),
      input.repairJson ? JSON.stringify(input.repairJson) : null,
      input.expectedRevision,
    ],
  );
  return result.rows[0]!;
}

export async function completeBuilderAction(
  auth: AuthContext,
  actionId: string,
  output: Record<string, unknown>,
  repair?: Record<string, unknown> | null,
): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_actions
     SET status = 'completed',
         output_json = $4::jsonb,
         repair_json = COALESCE($5::jsonb, repair_json),
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [actionId, auth.tenantId, auth.userId, JSON.stringify(output), repair ? JSON.stringify(repair) : null],
  );
}

export async function failBuilderAction(
  auth: AuthContext,
  actionId: string,
  error: string,
  repair?: Record<string, unknown> | null,
): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_actions
     SET status = 'failed',
         error_text = $4,
         repair_json = COALESCE($5::jsonb, repair_json),
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [actionId, auth.tenantId, auth.userId, error, repair ? JSON.stringify(repair) : null],
  );
}
