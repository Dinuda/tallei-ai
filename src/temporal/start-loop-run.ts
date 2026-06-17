import { config } from "../config/index.js";
import { getTemporalClient, isTemporalEnabled } from "./client.js";
import { loopRunWorkflowId, loopScheduleId } from "./ids.js";
import { loopRunWorkflow } from "./workflows/loop-run.workflow.js";
import type { LoopRunWorkflowInput } from "./types.js";

export async function startLoopRunWorkflow(input: LoopRunWorkflowInput & { runId: string }): Promise<void> {
  if (!isTemporalEnabled()) {
    const { resolveLoopRunAuth } = await import("../services/loop-runtime/resolve-loop-run-auth.js");
    const { executeSpecRunHeadless } = await import("../services/loop-runtime/spec-runner.js");
    const auth = await resolveLoopRunAuth({
      tenantId: input.tenantId,
      userId: input.userId,
      workflowId: input.workflowId,
    });
    void executeSpecRunHeadless(auth, input.workflowId, input.runId).catch((error) => {
      console.error(`Loop headless run failed for workflow ${input.workflowId}:`, error);
    });
    return;
  }

  const client = await getTemporalClient();
  await client.workflow.start(loopRunWorkflow, {
    taskQueue: config.temporalTaskQueue,
    workflowId: loopRunWorkflowId(input.tenantId, input.workflowId, input.runId),
    args: [input],
  });
}

export async function cancelLoopRunWorkflow(input: {
  tenantId: string;
  workflowId: string;
  runId: string;
}): Promise<void> {
  if (!isTemporalEnabled()) return;
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(loopRunWorkflowId(input.tenantId, input.workflowId, input.runId));
  try {
    await handle.cancel();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not found|already completed|already cancelled/i.test(message)) {
      throw error;
    }
  }
}
