import { Context } from "@temporalio/activity";

import { resolveLoopRunAuth } from "../../services/conductor/runtime/resolve-loop-run-auth.js";
import {
  createSpecLoopRun,
} from "../../services/conductor/runtime/spec-runner.js";
import { drainLoopRunCommands } from "../../services/conductor/runtime/spec-run-commands.js";
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
  await drainLoopRunCommands({
    auth,
    workflowId: input.workflowId,
    runId: input.runId,
    executeFallback: true,
  });
}
