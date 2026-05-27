import { config } from "../../config/index.js";
import {
  claimLoopHeartbeatJobs,
  completeLoopHeartbeatJob,
  failLoopHeartbeatJob,
} from "./heartbeat-jobs.js";
import { markRunBlocked, runAgentHeartbeat, runCeoFinalizeHeartbeat } from "./executor.js";

async function executeLoopHeartbeatJob(job: {
  id: string;
  workflow_run_id: string;
  job_type: string;
  task_id: string | null;
  attempts: number;
  max_attempts: number;
}): Promise<void> {
  if (job.job_type === "agent") {
    if (!job.task_id) throw new Error("Agent heartbeat job missing task_id");
    await runAgentHeartbeat(job.workflow_run_id, job.task_id);
    return;
  }
  if (job.job_type === "ceo_finalize") {
    await runCeoFinalizeHeartbeat(job.workflow_run_id);
    return;
  }
  throw new Error(`Unknown heartbeat job type: ${job.job_type}`);
}

export async function dispatchLoopHeartbeatJobs(input?: {
  limit?: number;
  source?: "internal" | "cloudflare" | "immediate";
}): Promise<{
  claimed: number;
  completed: number;
  failed: number;
  results: Array<{ jobId: string; runId: string; status: "done" | "failed"; error?: string }>;
}> {
  const limit = Math.max(1, Math.min(input?.limit ?? config.loopExecutorHeartbeatBatchSize, 25));
  const jobs = await claimLoopHeartbeatJobs(limit);
  const results = await Promise.all(jobs.map(async (job) => {
    try {
      await executeLoopHeartbeatJob(job);
      await completeLoopHeartbeatJob(job.id);
      return { jobId: job.id, runId: job.workflow_run_id, status: "done" as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failLoopHeartbeatJob(job.id, message, job.attempts, job.max_attempts);
      if (job.attempts >= job.max_attempts) {
        await markRunBlocked(job.workflow_run_id, `Heartbeat job failed: ${message}`, job.task_id).catch(() => undefined);
      }
      return { jobId: job.id, runId: job.workflow_run_id, status: "failed" as const, error: message };
    }
  }));

  return {
    claimed: jobs.length,
    completed: results.filter((row) => row.status === "done").length,
    failed: results.filter((row) => row.status === "failed").length,
    results,
  };
}
