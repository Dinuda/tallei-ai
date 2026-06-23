import { pool } from "../../../infrastructure/db/index.js";
import { resolveLoopRunAuth } from "./resolve-loop-run-auth.js";
import { nextCronRunAt } from "../workflow/cron.js";
import { LOOP_DEFINITION_VERSION } from "../workflow/types.js";
import { createSpecLoopRun, runSpecLoopHeadless, scheduleTriggerLabel } from "./spec-runner.js";

let timer: NodeJS.Timeout | null = null;
let ticking = false;

async function tickSpecScheduledRuns(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const due = await pool.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      schedule_rrule: string;
    }>(
      `SELECT id, tenant_id, user_id, schedule_rrule
       FROM workflows
       WHERE status = 'active'
         AND definition_version = $1
         AND next_run_at IS NOT NULL
         AND next_run_at <= NOW()
       ORDER BY next_run_at ASC
       LIMIT 10
       FOR UPDATE SKIP LOCKED`,
      [LOOP_DEFINITION_VERSION],
    );

    for (const row of due.rows) {
      const auth = await resolveLoopRunAuth({
        tenantId: row.tenant_id,
        userId: row.user_id,
        workflowId: row.id,
      });
      try {
        const run = await createSpecLoopRun(auth, row.id, {
          source: "schedule",
          label: scheduleTriggerLabel(row.schedule_rrule),
        });
        await pool.query(
          `UPDATE workflows
           SET last_scheduled_at = NOW(),
               next_run_at = $2::timestamptz,
               updated_at = NOW()
           WHERE id = $1`,
          [row.id, nextCronRunAt(row.schedule_rrule).toISOString()],
        );
        void runSpecLoopHeadless(auth, row.id, run.id).catch((error) => {
          console.error(`Spec loop headless run failed for workflow ${row.id}:`, error);
        });
      } catch (error) {
        console.error(`Spec loop scheduler failed for workflow ${row.id}:`, error);
      }
    }
  } finally {
    ticking = false;
  }
}

export function startSpecLoopScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tickSpecScheduledRuns().catch((error) => {
      console.error("Spec loop scheduler tick failed:", error);
    });
  }, 60_000);
  timer.unref();
  void tickSpecScheduledRuns().catch((error) => {
    console.error("Spec loop scheduler initial tick failed:", error);
  });
}

export function stopSpecLoopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
