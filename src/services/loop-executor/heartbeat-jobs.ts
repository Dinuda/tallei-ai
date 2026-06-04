// @ts-nocheck
import { randomUUID } from "crypto";
import { pool } from "../../infrastructure/db/index.js";
function idempotencyKey(input) {
    if (input.jobType === "agent") {
        if (!input.taskId)
            throw new Error("Agent heartbeat job requires taskId");
        return `${input.runId}:agent:${input.taskId}`;
    }
    if (input.jobType === "distribution") {
        return `${input.runId}:distribution:${input.idempotencySuffix ?? "batch-0"}`;
    }
    if (input.jobType === "ceo_strategy") {
        return `${input.runId}:ceo_strategy`;
    }
    return `${input.runId}:ceo_finalize`;
}
export async function findLoopHeartbeatJob(input) {
    const key = idempotencyKey(input);
    const result = await pool.query(`SELECT id, tenant_id, user_id, workflow_run_id, job_type, task_id, status, idempotency_key, attempts, max_attempts, last_error
     FROM loop_heartbeat_jobs
     WHERE idempotency_key = $1
     LIMIT 1`, [key]);
    return result.rows[0] ?? null;
}
export async function enqueueLoopHeartbeatJob(input) {
    const key = idempotencyKey({
        runId: input.runId,
        jobType: input.jobType,
        taskId: input.taskId,
        idempotencySuffix: input.idempotencySuffix,
    });
    const result = await pool.query(`INSERT INTO loop_heartbeat_jobs
     (id, tenant_id, user_id, workflow_run_id, job_type, task_id, status, idempotency_key, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW() + ($8::text || ' seconds')::interval)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET status = 'pending',
           task_id = EXCLUDED.task_id,
           next_attempt_at = NOW() + ($8::text || ' seconds')::interval,
           attempts = CASE WHEN $9::boolean THEN 0 ELSE loop_heartbeat_jobs.attempts END,
           last_error = NULL,
           updated_at = NOW()
       WHERE loop_heartbeat_jobs.status IN ('failed', 'done', 'processing')
          OR $9::boolean
     RETURNING id`, [
        randomUUID(),
        input.tenantId,
        input.userId,
        input.runId,
        input.jobType,
        input.taskId ?? null,
        key,
        String(Math.max(0, input.delaySeconds ?? 0)),
        Boolean(input.resetAttempts),
    ]);
    return { enqueued: result.rows.length > 0, jobId: result.rows[0]?.id ?? null };
}
export async function claimLoopHeartbeatJobs(limit) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(`SELECT id, tenant_id, user_id, workflow_run_id, job_type, task_id, status, idempotency_key, attempts, max_attempts, last_error
       FROM loop_heartbeat_jobs
       WHERE status = 'pending'
         AND next_attempt_at <= NOW()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`, [Math.max(1, Math.min(limit, 25))]);
        for (const row of result.rows) {
            await client.query(`UPDATE loop_heartbeat_jobs
         SET status = 'processing',
             attempts = attempts + 1,
             updated_at = NOW()
         WHERE id = $1`, [row.id]);
        }
        await client.query("COMMIT");
        return result.rows.map((row) => ({ ...row, status: "processing", attempts: row.attempts + 1 }));
    }
    catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
    finally {
        client.release();
    }
}
export async function completeLoopHeartbeatJob(jobId) {
    await pool.query(`UPDATE loop_heartbeat_jobs
     SET status = 'done',
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1`, [jobId]);
}
export async function failLoopHeartbeatJob(jobId, message, attempts, maxAttempts) {
    const retry = attempts < maxAttempts;
    const delaySeconds = Math.min(30 * attempts, 300);
    if (retry) {
        await pool.query(`UPDATE loop_heartbeat_jobs
       SET status = 'pending',
           last_error = $2,
           next_attempt_at = NOW() + ($3::text || ' seconds')::interval,
           updated_at = NOW()
       WHERE id = $1`, [jobId, message.slice(0, 2000), String(delaySeconds)]);
        return;
    }
    await pool.query(`UPDATE loop_heartbeat_jobs
     SET status = 'failed',
         last_error = $2,
         updated_at = NOW()
     WHERE id = $1`, [jobId, message.slice(0, 2000)]);
}
//# sourceMappingURL=heartbeat-jobs.js.map