import type { AuthContext } from "../../domain/auth/index.js";
import type { CompiledPlan } from "../../loops/spec.js";
import type { AgentRunState } from "../types.js";
import { persistLoopRunWorkspaceMemory } from "../../services/workspace-memory.js";
import { updateLoopRun } from "../../loops/store.js";

export async function deliverOutputActivity(input: {
  auth: AuthContext;
  plan: CompiledPlan;
  runId: string;
  loopId: string;
  state: AgentRunState;
  summary: string;
}): Promise<void> {
  await updateLoopRun(input.runId, {
    status: "completed",
    finishedAt: new Date().toISOString(),
    resultJson: { summary: input.summary, toolResults: input.state.toolResults },
  });

  await persistLoopRunWorkspaceMemory(input.auth, {
    workflowId: input.loopId,
    runId: input.runId,
    workflowTitle: input.plan.intent.goal,
    artifactTexts: [input.summary],
  });
}

export async function failRunActivity(input: {
  runId: string;
  error: string;
}): Promise<void> {
  await updateLoopRun(input.runId, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    errorJson: { error: input.error },
  });
}
