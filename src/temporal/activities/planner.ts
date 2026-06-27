import {
  buildRuntimePlannerPrompt,
  runPlannerDecision,
} from "../../loops/planning-agent.js";
import { type CompiledPlan } from "../../loops/spec.js";
import { insertRunStep } from "../../loops/store.js";
import { searchWorkspaceMemories } from "../../services/workspace-memory.js";
import type { AuthContext } from "../../domain/auth/index.js";
import type { AgentRunState } from "../types.js";

export async function plannerActivity(input: {
  auth: AuthContext;
  plan: CompiledPlan;
  runId: string;
  state: AgentRunState;
}): Promise<Awaited<ReturnType<typeof runPlannerDecision>>> {
  const memoryHits = await searchWorkspaceMemories(input.auth, input.plan.intent.goal, 5, {
    workflowId: input.plan.loopId,
  }).catch(() => []);

  const prompt = buildRuntimePlannerPrompt({
    planGoal: input.plan.intent.goal,
    toolCatalog: input.plan.toolCatalog.map((t) => ({
      id: t.id,
      capability: t.capability,
      connector: t.connector,
      actionSlug: t.actionSlug,
      inputSchema: t.inputSchema,
    })),
    stepHistory: input.state.toolResults,
    workspaceMemory: memoryHits.map((m) => m.text),
  });

  const decision = await runPlannerDecision(prompt, { userId: input.auth.userId });

  await insertRunStep({
    runId: input.runId,
    stepIndex: input.state.stepIndex,
    kind: "plan",
    outputJson: decision,
    status: "completed",
  });

  return decision;
}
