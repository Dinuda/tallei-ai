import { randomUUID } from "crypto";

import { pool } from "../../infrastructure/db/index.js";

export type LoopHeartbeatJobType = "agent" | "ceo_finalize";

export interface LoopHeartbeatJobRow {
  id: string;
  tenant_id: string;
  user_id: string;
  workflow_run_id: string;
  job_type: LoopHeartbeatJobType;
  task_id: string | null;
  status: string;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

function idempotencyKey(input: {
  runId: string;
  jobType: LoopHeartbeatJobType;
  taskId?: string | null;
}): string {
  if (input.jobType === "agent") {
    if (!input.taskId) throw new Error("Agent heartbeat job requires taskId");
    return `${input.runId}:agent:${input.taskId}`;
  }
  return `${input.runId}:ceo_finalize`;
}

export async function enqueueLoopHeartbeatJob(input: {
  tenantId: string;
  userId: string;
  runId: string;
  jobType: LoopHeartbeatJobType;
  taskId?: string | null;
}): Promise<{ enqueued: boolean; jobId: string | null }> {
  const key = idempotencyKey({
    runId: input.runId,
    jobType: input.jobType,
    taskId: input.taskId,
  });
  const result = await pool.query<{ id: string }>(
    `INSERT INTO loop_heartbeat_jobs
     (id, tenant_id, user_id, workflow_run_id, job_type, task_id, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET status = 'pending',
           task_id = EXCLUDED.task_id,
           next_attempt_at = NOW(),
           last_error = NULL,
           updated_at = NOW()
       WHERE loop_heartbeat_jobs.status IN ('failed', 'done', 'processing')
     RETURNING id`,
    [
      randomUUID(),
      input.tenantId,
      input.userId,
      input.runId,
      input.jobType,
      input.taskId ?? null,
      key,
    ]
  );
  return { enqueued: result.rows.length > 0, jobId: result.rows[0]?.id ?? null };
}

export async function claimLoopHeartbeatJobs(limit: number): Promise<LoopHeartbeatJobRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<LoopHeartbeatJobRow>(
      `SELECT id, tenant_id, user_id, workflow_run_id, job_type, task_id, status, idempotency_key, attempts, max_attempts, last_error
       FROM loop_heartbeat_jobs
       WHERE status = 'pending'
         AND next_attempt_at <= NOW()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [Math.max(1, Math.min(limit, 25))]
    );

    for (const row of result.rows) {
      await client.query(
        `UPDATE loop_heartbeat_jobs
         SET status = 'processing',
             attempts = attempts + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
    }

    await client.query("COMMIT");
    return result.rows.map((row) => ({ ...row, status: "processing" }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeLoopHeartbeatJob(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE loop_heartbeat_jobs
     SET status = 'done',
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [jobId]
  );
}

export async function failLoopHeartbeatJob(jobId: string, message: string, attempts: number, maxAttempts: number): Promise<void> {
  const retry = attempts < maxAttempts;
  const delaySeconds = Math.min(30 * attempts, 300);
  if (retry) {
    await pool.query(
      `UPDATE loop_heartbeat_jobs
       SET status = 'pending',
           last_error = $2,
           next_attempt_at = NOW() + ($3::text || ' seconds')::interval,
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, message.slice(0, 2000), String(delaySeconds)]
    );
    return;
  }
  await pool.query(
    `UPDATE loop_heartbeat_jobs
     SET status = 'failed',
         last_error = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [jobId, message.slice(0, 2000)]
  );
}
