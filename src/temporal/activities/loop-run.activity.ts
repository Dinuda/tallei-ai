import { Context } from "@temporalio/activity";

import { resolveLoopRunAuth } from "../../services/loop-runtime/resolve-loop-run-auth.js";
import {
  createSpecLoopRun,
  executeSpecRunHeadless,
} from "../../services/loop-runtime/spec-runner.js";
import type { LoopRunWorkflowInput } from "../types.js";

export async function ensureLoopRun(input: LoopRunWorkflowInput): Promise<string> {
  Context.current().heartbeat();
  const auth = await resolveLoopRunAuth({
    tenantId: input.tenantId,
    userId: input.userId,
    workflowId: input.workflowId,
  });
  const run = await createSpecLoopRun(auth, input.workflowId, input.trigger);
  return run.id;
}

export async function executeLoopRun(input: LoopRunWorkflowInput & { runId: string }): Promise<void> {
  Context.current().heartbeat();
  const auth = await resolveLoopRunAuth({
    tenantId: input.tenantId,
    userId: input.userId,
    workflowId: input.workflowId,
  });
  await executeSpecRunHeadless(auth, input.workflowId, input.runId);
}
