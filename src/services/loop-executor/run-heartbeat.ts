/**
 * run-heartbeat.ts — Enqueue and optionally run heartbeat jobs immediately.
 *
 * Uses dynamic imports to avoid circular dependencies between executor, distribution, and gates.
 */

import {
  completeLoopHeartbeatJob,
  enqueueLoopHeartbeatJob,
  failLoopHeartbeatJob,
  findLoopHeartbeatJob,
} from "./heartbeat-jobs.js";
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
  jobType: "agent" | "ceo_finalize" | "distribution";
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
  await enqueueLoopHeartbeatJob(input);
  const job = await findLoopHeartbeatJob({
    runId: input.runId,
    jobType: input.jobType,
    taskId: input.taskId,
    idempotencySuffix: input.idempotencySuffix,
  });
  if (!job) return;

  try {
    if (input.jobType === "agent") {
      if (!input.taskId) throw new Error("Agent heartbeat job requires taskId");
      const { runAgentHeartbeat } = await import("./executor.js");
      await runAgentHeartbeat(input.runId, input.taskId);
    } else if (input.jobType === "distribution") {
      const { runDistributionHeartbeat } = await import("./distribution.js");
      await runDistributionHeartbeat(input.runId);
    } else {
      const { runCeoFinalizeHeartbeat } = await import("./executor.js");
      await runCeoFinalizeHeartbeat(input.runId);
    }
    await completeLoopHeartbeatJob(job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempt = job.attempts + 1;
    if (input.jobType === "agent" && RETRYABLE_AGENT_ERROR.test(message)) {
      await failLoopHeartbeatJob(job.id, message, attempt, job.max_attempts);
      return;
    }
    await failLoopHeartbeatJob(job.id, message, attempt, job.max_attempts);
    if (attempt >= job.max_attempts) {
      const { markRunBlocked } = await import("./run-status.js");
      await markRunBlocked(input.runId, `Heartbeat job failed: ${message}`, input.taskId ?? null).catch(() => undefined);
    }
  }
}
