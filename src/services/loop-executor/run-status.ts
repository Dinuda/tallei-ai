/**
 * run-status.ts — Run status transitions (blocked, notifications).
 */

import { pool } from "../../infrastructure/db/index.js";
import { deliverStatusNotification } from "../channels.js";
import { authFromContext, loadRunContext, mergeLoopExecutorMeta } from "./run-context.js";
import { insertComment, insertEvent } from "./run-store.js";

/** Marks a run blocked and notifies the operator. */
export async function markRunFailed(input: {
  runId: string;
  tenantId: string;
  userId: string;
  message: string;
}): Promise<void> {
  await pool.query(
    `UPDATE workflow_runs
     SET status = 'failed',
         waiting_for_strategy_approval = FALSE,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [
      input.runId,
      input.tenantId,
      input.userId,
      JSON.stringify({
        loop_executor: {
          failedAt: new Date().toISOString(),
          error: { message: input.message.slice(0, 2000) },
        },
      }),
    ]
  );
}

export async function markRunBlocked(runId: string, message: string, taskId?: string | null): Promise<void> {
  const context = await loadRunContext(runId);
  const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
    blockedAt: new Date().toISOString(),
    error: { message },
  });
  await insertComment({
    context,
    taskId: taskId ?? null,
    author: "ceo",
    body: `Blocked: ${message}`,
  }).catch(() => undefined);
  await insertEvent({
    context,
    taskId: taskId ?? null,
    eventType: "run_blocked",
    payload: { message },
  }).catch(() => undefined);
  await pool.query(
    `UPDATE workflow_runs
     SET status = 'blocked', waiting_for_strategy_approval = FALSE,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      runId,
      context.tenantId,
      context.userId,
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]
  );
  await deliverStatusNotification({
    auth: authFromContext(context),
    title: `${context.workflowTitle} is blocked`,
    body: message,
    metadata: { workflowId: context.workflowId, runId: context.runId, status: "blocked" },
  }).catch(() => undefined);
}
