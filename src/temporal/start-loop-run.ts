import { getTemporalClient } from "./client.js";
import { loopRunWorkflowId } from "./ids.js";
import { config } from "../config/index.js";
import type { LoopRunWorkflowInput } from "./types.js";

export async function startLoopRun(
  input: Omit<LoopRunWorkflowInput, "tenantId" | "userId"> & { tenantId?: string; userId?: string },
): Promise<{ workflowId: string; runId: string }> {
  const client = await getTemporalClient();
  const workflowId = loopRunWorkflowId(input.loopId, input.runId);
  await client.workflow.start("loopRunWorkflow", {
    taskQueue: config.temporalTaskQueue,
    workflowId,
    args: [{
      ...input,
      tenantId: input.tenantId ?? "unknown",
      userId: input.userId ?? "unknown",
    }],
  });
  return { workflowId, runId: input.runId };
}
