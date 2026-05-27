import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { getPlanForTenant } from "../../infrastructure/auth/tenancy.js";
import { pool } from "../../infrastructure/db/index.js";
import { nextCronRunAt } from "./cron.js";
import { executeLoopWorkflow } from "./executor.js";
import { LOOP_DEFINITION_VERSION } from "./types.js";

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerTickRunning = false;

type DueWorkflowRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  schedule_rrule: string;
  next_run_at: string;
};

async function claimDueWorkflows(limit: number): Promise<DueWorkflowRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<DueWorkflowRow>(
      `SELECT id, tenant_id, user_id, schedule_rrule, next_run_at
       FROM workflows
       WHERE definition_version = $1
         AND status = 'active'
         AND next_run_at IS NOT NULL
         AND next_run_at <= NOW()
       ORDER BY next_run_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [LOOP_DEFINITION_VERSION, limit]
    );

    for (const row of result.rows) {
      const nextRunAt = nextCronRunAt(row.schedule_rrule, new Date(row.next_run_at)).toISOString();
      await client.query(
        `UPDATE workflows
         SET last_scheduled_at = next_run_at,
             next_run_at = $2::timestamptz,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, nextRunAt]
      );
    }

    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function authForRow(row: DueWorkflowRow): Promise<AuthContext> {
  const plan = await getPlanForTenant(row.tenant_id);
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    authMode: "internal",
    plan,
  };
}

export async function dispatchDueLoopWorkflows(input?: { limit?: number; source?: "internal" | "cloudflare" }): Promise<{
  claimed: number;
  dispatched: number;
  failed: number;
  results: Array<{ workflowId: string; runId?: string; status?: string; error?: string }>;
}> {
  const limit = Math.max(1, Math.min(input?.limit ?? config.loopExecutorSchedulerBatchSize, 25));
  const rows = await claimDueWorkflows(limit);
  const results = await Promise.all(rows.map(async (row) => {
    try {
      const auth = await authForRow(row);
      const result = await executeLoopWorkflow({
        auth,
        workflowId: row.id,
        runMode: "scheduled",
        scheduledFor: row.next_run_at,
      });
      return { workflowId: row.id, runId: result.runId, status: result.status };
    } catch (error) {
      return { workflowId: row.id, error: error instanceof Error ? error.message : String(error) };
    }
  }));

  const failed = results.filter((result) => result.error).length;
  return {
    claimed: rows.length,
    dispatched: results.length - failed,
    failed,
    results,
  };
}

export function startLoopExecutorScheduler(): void {
  if (schedulerTimer || config.loopExecutorScheduler !== "internal") return;
  schedulerTimer = setInterval(() => {
    if (schedulerTickRunning) return;
    schedulerTickRunning = true;
    void dispatchDueLoopWorkflows({ source: "internal" })
      .catch((error) => console.error("[loop-executor] scheduler tick failed:", error))
      .finally(() => {
        schedulerTickRunning = false;
      });
  }, config.loopExecutorPollMs);
  schedulerTimer.unref?.();
}

export function stopLoopExecutorScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerTickRunning = false;
}
