import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";

export type LoopEngineCommandType =
  | "start_run"
  | "execute_step"
  | "continue_after_interaction"
  | "execute_write_action"
  | "finalize_run"
  | "retry_step";

type CommandRow = {
  id: string;
  command_type: LoopEngineCommandType;
  payload_json: unknown;
};

export async function enqueueLoopRunCommand(input: {
  auth: AuthContext;
  runId: string;
  commandType: LoopEngineCommandType;
  idempotencyKey: string;
  stepAttemptId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO loop_engine_commands
       (id, tenant_id, user_id, run_id, step_attempt_id, command_type, status, idempotency_key, payload_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8::jsonb, NOW(), NOW())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId ?? null,
      input.commandType,
      input.idempotencyKey,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

async function claimNextCommand(input: {
  auth: AuthContext;
  runId: string;
}): Promise<CommandRow | null> {
  const result = await pool.query<CommandRow>(
    `UPDATE loop_engine_commands
     SET status = 'processing',
         lease_owner = $4,
         lease_expires_at = NOW() + INTERVAL '2 minutes',
         attempts = attempts + 1,
         updated_at = NOW()
     WHERE id = (
       SELECT id
       FROM loop_engine_commands
       WHERE run_id = $1
         AND tenant_id = $2
         AND user_id = $3
         AND status = 'pending'
         AND not_before <= NOW()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, command_type, payload_json`,
    [input.runId, input.auth.tenantId, input.auth.userId, `runner:${process.pid}`],
  );
  return result.rows[0] ?? null;
}

async function completeCommand(id: string): Promise<void> {
  await pool.query(
    `UPDATE loop_engine_commands
     SET status = 'succeeded',
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

async function failCommand(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE loop_engine_commands
     SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
         last_error = $2,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [id, message],
  );
}

async function hasPendingCommand(input: { auth: AuthContext; runId: string }): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `SELECT id
     FROM loop_engine_commands
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'pending'
     LIMIT 1`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
  return result.rows.length > 0;
}

export async function drainLoopRunCommands(input: {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  executeFallback?: boolean;
}): Promise<void> {
  let processed = false;
  for (;;) {
    const command = await claimNextCommand(input);
    if (!command) break;
    processed = true;
    try {
      const { executeSpecRunHeadless } = await import("./spec-runner.js");
      await executeSpecRunHeadless(input.auth, input.workflowId, input.runId);
      await completeCommand(command.id);
    } catch (error) {
      await failCommand(command.id, error);
      throw error;
    }
  }

  if (!processed && input.executeFallback && !(await hasPendingCommand(input))) {
    const { executeSpecRunHeadless } = await import("./spec-runner.js");
    await executeSpecRunHeadless(input.auth, input.workflowId, input.runId);
  }
}
