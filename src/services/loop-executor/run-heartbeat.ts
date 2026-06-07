/**
 * run-heartbeat.ts — Enqueue and optionally run heartbeat jobs immediately.
 *
 * Uses dynamic imports to avoid circular dependencies between executor, distribution, and gates.
 */

import {
  claimLoopHeartbeatJob,
  completeLoopHeartbeatJob,
  enqueueLoopHeartbeatJob,
  failLoopHeartbeatJob,
  findLoopHeartbeatJob,
} from "./heartbeat-jobs.js";
import { hasPendingLoopRunGate } from "./run-execution-guard.js";
import { loadRunContext } from "./run-context.js";
const RETRYABLE_AGENT_ERROR = /timed out|timeout|aborted|aborterror|rate limit|temporarily unavailable|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i;

export function scheduleDelayedHeartbeatDispatch(delaySeconds: number): void {
  const timer = setTimeout(() => {
    void import("./heartbeat-dispatch.js")
      .then(({ dispatchLoopHeartbeatJobs }) => dispatchLoopHeartbeatJobs({ source: "immediate" }))
      .catch((error) => console.error("[loop-executor] delayed heartbeat dispatch failed:", error));
  }, Math.max(0, delaySeconds) * 1000 + 250);
  timer.unref?.();
}

export type ScheduleHeartbeatInput = {
  tenantId: string;
  userId: string;
  runId: string;
  jobType: "agent" | "ceo_strategy" | "ceo_finalize" | "distribution";
  taskId?: string;
  delaySeconds?: number;
  resetAttempts?: boolean;
  idempotencySuffix?: string;
};

/**
 * Persists a heartbeat job and attempts to run it in-process.
 * On failure the job remains pending for the heartbeat worker.
 */
export async function scheduleHeartbeat(input: ScheduleHeartbeatInput): Promise<void> {
  if (input.jobType === "agent" || input.jobType === "ceo_finalize") {
    try {
      const context = await loadRunContext(input.runId);
      if (context.runStatus === "waiting_for_gate") return;
      if (await hasPendingLoopRunGate(input.runId, input.tenantId, input.userId)) return;
    } catch {
      return;
    }
  }

  await enqueueLoopHeartbeatJob(input);
  const job = await findLoopHeartbeatJob({
    runId: input.runId,
    jobType: input.jobType,
    taskId: input.taskId,
    idempotencySuffix: input.idempotencySuffix,
  });
  if (!job) return;
  const claimedJob = await claimLoopHeartbeatJob(job.id);
  if (!claimedJob) return;

  try {
    if (input.jobType === "agent") {
      if (!input.taskId) throw new Error("Agent heartbeat job requires taskId");
      const { runAgentHeartbeat } = await import("./executor.js");
      await runAgentHeartbeat(input.runId, input.taskId);
    } else if (input.jobType === "ceo_strategy") {
      const { runCeoStrategyHeartbeat } = await import("./executor.js");
      const { markRunFailed } = await import("./run-status.js");
      try {
        await runCeoStrategyHeartbeat(input.runId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markRunFailed({
          runId: input.runId,
          tenantId: input.tenantId,
          userId: input.userId,
          message,
        });
        throw error;
      }
    } else if (input.jobType === "distribution") {
      const { runDistributionHeartbeat } = await import("./distribution.js");
      await runDistributionHeartbeat(input.runId, input.taskId);
    } else {
      const { runCeoFinalizeHeartbeat } = await import("./executor.js");
      await runCeoFinalizeHeartbeat(input.runId);
    }
    await completeLoopHeartbeatJob(claimedJob.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempt = claimedJob.attempts;
    if (input.jobType === "agent" && RETRYABLE_AGENT_ERROR.test(message)) {
      await failLoopHeartbeatJob(claimedJob.id, message, attempt, claimedJob.max_attempts);
      return;
    }
    await failLoopHeartbeatJob(claimedJob.id, message, attempt, claimedJob.max_attempts);
    if (attempt >= claimedJob.max_attempts) {
      const { markRunBlocked } = await import("./run-status.js");
      await markRunBlocked(input.runId, `Heartbeat job failed: ${message}`, input.taskId ?? null).catch(() => undefined);
    }
  }
}
