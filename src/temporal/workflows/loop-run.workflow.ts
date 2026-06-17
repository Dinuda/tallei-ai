import { proxyActivities } from "@temporalio/workflow";

import type { LoopRunWorkflowInput } from "../types.js";
import type * as loopRunActivities from "../activities/loop-run.activity.js";

const { ensureLoopRun, executeLoopRun } = proxyActivities<typeof loopRunActivities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
  },
});

export async function loopRunWorkflow(input: LoopRunWorkflowInput): Promise<void> {
  const runId = input.runId ?? await ensureLoopRun(input);
  await executeLoopRun({ ...input, runId });
}
