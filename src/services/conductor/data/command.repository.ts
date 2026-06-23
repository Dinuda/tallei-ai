import type { AuthContext } from "../../../domain/auth/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import type { LoopBuilderProgressEvent, LoopBuilderUsage } from "../utils/progress.js";
import type { BuilderToolName } from "../contracts/builder-types.js";

export type CommandRow = {
  id: string;
  session_id: string;
  tool_name: BuilderToolName;
  status: "pending" | "running" | "completed" | "failed" | "rejected";
  events_json: LoopBuilderProgressEvent[];
  usage_json: LoopBuilderUsage;
  result_json: Record<string, unknown> | null;
  error_text: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function markCommandRunning(commandId: string): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_commands SET status = 'running', updated_at = NOW() WHERE id = $1`,
    [commandId],
  );
}

export async function updateCommandProgress(
  commandId: string,
  events: LoopBuilderProgressEvent[],
  usage: LoopBuilderUsage,
): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_commands SET events_json = $2::jsonb, usage_json = $3::jsonb, updated_at = NOW() WHERE id = $1`,
    [commandId, JSON.stringify(events), JSON.stringify(usage)],
  );
}

export async function completeCommand(
  commandId: string,
  result: Record<string, unknown>,
  events: LoopBuilderProgressEvent[],
  usage: LoopBuilderUsage,
): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_commands
     SET status = 'completed', result_json = $2::jsonb, events_json = $3::jsonb, usage_json = $4::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [commandId, JSON.stringify(result), JSON.stringify(events), JSON.stringify(usage)],
  );
}

export async function failCommand(commandId: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE workflow_builder_commands SET status = 'failed', error_text = $2, updated_at = NOW() WHERE id = $1`,
    [commandId, message],
  );
}

export async function insertWorkflowBuilderCommand(
  auth: AuthContext,
  input: {
    id: string;
    sessionId: string;
    toolName: BuilderToolName;
    inputJson: Record<string, unknown>;
    usage: LoopBuilderUsage;
  },
): Promise<CommandRow> {
  const result = await pool.query<CommandRow>(
    `INSERT INTO workflow_builder_commands
       (id, session_id, tenant_id, user_id, tool_name, input_json, events_json, usage_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, $7::jsonb)
     RETURNING id, session_id, tool_name, status, events_json, usage_json, result_json, error_text, created_at, updated_at`,
    [
      input.id,
      input.sessionId,
      auth.tenantId,
      auth.userId,
      input.toolName,
      JSON.stringify(input.inputJson),
      JSON.stringify(input.usage),
    ],
  );
  return result.rows[0]!;
}

export async function findWorkflowBuilderCommandRow(
  auth: AuthContext,
  commandId: string,
): Promise<CommandRow | null> {
  const result = await pool.query<CommandRow>(
    `SELECT id, session_id, tool_name, status, events_json, usage_json, result_json, error_text, created_at, updated_at
     FROM workflow_builder_commands WHERE id = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1`,
    [commandId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ?? null;
}

export type RetryableCommandRow = {
  id: string;
  tool_name: BuilderToolName;
  input_json: Record<string, unknown>;
  status: string;
};

export async function findRetryableCommandRow(
  auth: AuthContext,
  sessionId: string,
  commandId?: string,
): Promise<RetryableCommandRow | null> {
  const result = commandId
    ? await pool.query<RetryableCommandRow>(
      `SELECT id, tool_name, input_json, status
       FROM workflow_builder_commands
       WHERE id = $1 AND session_id = $2 AND tenant_id = $3 AND user_id = $4
       LIMIT 1`,
      [commandId, sessionId, auth.tenantId, auth.userId],
    )
    : await pool.query<RetryableCommandRow>(
      `SELECT id, tool_name, input_json, status
       FROM workflow_builder_commands
       WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3 AND status IN ('failed', 'rejected')
       ORDER BY created_at DESC
       LIMIT 1`,
      [sessionId, auth.tenantId, auth.userId],
    );
  return result.rows[0] ?? null;
}
