import { pool } from "../../infrastructure/db/index.js";

/** True when the run has a gate waiting on operator input. */
export async function hasPendingLoopRunGate(runId: string, tenantId?: string, userId?: string): Promise<boolean> {
  const result = tenantId && userId
    ? await pool.query(
      `SELECT 1 FROM loop_run_gates
       WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'pending'
       LIMIT 1`,
      [runId, tenantId, userId],
    )
    : await pool.query(
      `SELECT 1 FROM loop_run_gates WHERE workflow_run_id = $1 AND status = 'pending' LIMIT 1`,
      [runId],
    );
  return Boolean(result.rows[0]);
}

/** Release stray in-progress tasks when a gate pauses the run. */
export async function releaseInProgressTasksExcept(input: {
  runId: string;
  tenantId: string;
  userId: string;
  exceptTaskId?: string;
}): Promise<void> {
  if (input.exceptTaskId) {
    await pool.query(
      `UPDATE loop_run_tasks
       SET status = 'todo', checkout_locked_at = NULL, updated_at = NOW()
       WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3
         AND status = 'in_progress' AND id <> $4`,
      [input.runId, input.tenantId, input.userId, input.exceptTaskId],
    );
    return;
  }
  await pool.query(
    `UPDATE loop_run_tasks
     SET status = 'todo', checkout_locked_at = NULL, updated_at = NOW()
     WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'in_progress'`,
    [input.runId, input.tenantId, input.userId],
  );
}
