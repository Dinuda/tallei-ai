import { generateText } from "ai";

import { getStreamingLanguageModel } from "../../providers/ai/streaming/language-model.js";
import {
  buildRuntimePlannerPrompt,
  parsePlannerDecisionText,
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
}): Promise<ReturnType<typeof parsePlannerDecisionText>> {
  const memoryHits = await searchWorkspaceMemories(input.auth, input.plan.intent.goal, 5, {
    workflowId: input.plan.loopId,
  }).catch(() => []);

  const prompt = buildRuntimePlannerPrompt({
    planGoal: input.plan.intent.goal,
    toolCatalog: input.plan.toolCatalog.map((t) => ({
      id: t.id,
      capability: t.capability,
      connector: t.connector,
    })),
    stepHistory: input.state.toolResults,
    workspaceMemory: memoryHits.map((m) => m.text),
  });

  const { text } = await generateText({
    model: getStreamingLanguageModel("planner"),
    system: "You are Tallei's loop runtime planner. Reply with a single JSON object only.",
    prompt,
  });

  const decision = parsePlannerDecisionText(text);

  await insertRunStep({
    runId: input.runId,
    stepIndex: input.state.stepIndex,
    kind: "plan",
    outputJson: decision,
    status: "completed",
  });

  return decision;
}
