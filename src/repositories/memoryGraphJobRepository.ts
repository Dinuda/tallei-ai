import { pool } from "../db/index.js";
import type { AuthContext } from "../types/auth.js";

export type MemoryGraphJobType = "extract" | "backfill";
export type MemoryGraphJobStatus = "queued" | "running" | "retry" | "failed" | "done";

export interface MemoryGraphJobRow {
  id: string;
  tenant_id: string;
  user_id: string;
  memory_id: string | null;
  job_type: MemoryGraphJobType;
  status: MemoryGraphJobStatus;
  attempt_count: number;
  next_run_at: string;
  error_code: string | null;
  error_message: string | null;
  payload_json: unknown;
  created_at: string;
  updated_at: string;
}

export class MemoryGraphJobRepository {
  async enqueueExtractJob(auth: AuthContext, memoryId: string, payload?: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO memory_graph_jobs (tenant_id, user_id, memory_id, job_type, status, payload_json)
       VALUES ($1, $2, $3, 'extract', 'queued', $4::jsonb)
       ON CONFLICT (tenant_id, user_id, memory_id, job_type)
       WHERE status IN ('queued', 'running', 'retry')
       DO NOTHING`,
      [auth.tenantId, auth.userId, memoryId, JSON.stringify(payload ?? {})]
    );
  }

  async enqueueBackfillForAllActiveMemories(limit = 5000): Promise<number> {
    const result = await pool.query<{ inserted: string }>(
      `WITH candidates AS (
         SELECT mr.tenant_id, mr.user_id, mr.id AS memory_id
         FROM memory_records mr
         WHERE mr.deleted_at IS NULL
         ORDER BY mr.created_at DESC
         LIMIT $1
       ),
       ins AS (
         INSERT INTO memory_graph_jobs (tenant_id, user_id, memory_id, job_type, status, payload_json)
         SELECT c.tenant_id, c.user_id, c.memory_id, 'backfill', 'queued', '{}'::jsonb
         FROM candidates c
         LEFT JOIN memory_graph_jobs j
           ON j.tenant_id = c.tenant_id
          AND j.user_id = c.user_id
          AND j.memory_id = c.memory_id
          AND j.job_type IN ('extract', 'backfill')
          AND j.status IN ('queued', 'running', 'retry', 'done')
         WHERE j.id IS NULL
         RETURNING 1
       )
       SELECT COUNT(*)::text AS inserted FROM ins`,
      [limit]
    );
    return Number(result.rows[0]?.inserted ?? "0");
  }

  async claimJobs(limit: number): Promise<MemoryGraphJobRow[]> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<MemoryGraphJobRow>(
        `WITH picked AS (
           SELECT id
           FROM memory_graph_jobs
           WHERE status IN ('queued', 'retry')
             AND next_run_at <= NOW()
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE memory_graph_jobs j
            SET status = 'running',
                attempt_count = j.attempt_count + 1,
                updated_at = NOW()
           FROM picked
          WHERE j.id = picked.id
          RETURNING j.*`,
        [limit]
      );
      await client.query("COMMIT");
      return claimed.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markDone(jobId: string): Promise<void> {
    await pool.query(
      `UPDATE memory_graph_jobs
       SET status = 'done',
           error_code = NULL,
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    );
  }

  async markRetry(jobId: string, delaySeconds: number, errorCode: string, message: string): Promise<void> {
    await pool.query(
      `UPDATE memory_graph_jobs
       SET status = 'retry',
           next_run_at = NOW() + ($2::int || ' seconds')::interval,
           error_code = $3,
           error_message = LEFT($4, 1000),
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, delaySeconds, errorCode, message]
    );
  }

  async markFailed(jobId: string, errorCode: string, message: string): Promise<void> {
    await pool.query(
      `UPDATE memory_graph_jobs
       SET status = 'failed',
           error_code = $2,
           error_message = LEFT($3, 1000),
           updated_at = NOW()
       WHERE id = $1`,
      [jobId, errorCode, message]
    );
  }
}
