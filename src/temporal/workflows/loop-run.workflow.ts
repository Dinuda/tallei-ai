import { proxyActivities, workflowInfo } from "@temporalio/workflow";

import type { LoopRunResult, LoopRunWorkflowInput } from "../types.js";

const activities = proxyActivities<typeof import("../activities/index.js")>({
  startToCloseTimeout: "60 minutes",
  retry: { maximumAttempts: 3 },
});

export { approvalDecisionSignal } from "./loop-run-approval.js";

export async function loopRunWorkflow(input: LoopRunWorkflowInput): Promise<LoopRunResult> {
  try {
    return await runLoopWorkflow(input);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
    const message = cause ?? (error instanceof Error ? error.message : String(error));
    await activities.failRunActivity({ runId: input.runId, error: message });
    return { status: "failed", error: message };
  }
}

async function runLoopWorkflow(input: LoopRunWorkflowInput): Promise<LoopRunResult> {
  const plan = await activities.loadCompiledPlanActivity(input.compiledPlanId);
  await activities.createRunRecordActivity({
    ...input,
    temporalWorkflowId: workflowInfo().workflowId,
  });

  if (plan.profile !== "agentic") {
    await activities.executeLoopRunHeadless(input);
    return { status: "completed" };
  }

  return activities.runAgenticLoopActivity({
    ...input,
    temporalWorkflowId: workflowInfo().workflowId,
  });
}
