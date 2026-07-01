import {
  buildRuntimePlannerPrompt,
  runPlannerDecision,
} from "../../loops/planning-agent.js";
import { assertAgenticCompiledPlan } from "../../loops/plan-validators.js";
import { type CompiledPlan } from "../../loops/spec.js";
import { insertRunStep } from "../../loops/store.js";
import {
  extractTriggerKnownFields,
  formatTriggerKnownFields,
} from "../../integrations/composio/trigger-known-fields.js";
import { searchWorkspaceMemories } from "../../services/workspace-memory.js";
import type { AuthContext } from "../../domain/auth/index.js";
import type { AgentRunState } from "../types.js";

export async function plannerActivity(input: {
  auth: AuthContext;
  plan: CompiledPlan;
  runId: string;
  state: AgentRunState;
  eventPayload?: unknown;
  triggerSlug?: string;
  exhaustedToolIds?: string[];
}): Promise<Awaited<ReturnType<typeof runPlannerDecision>>> {
  assertAgenticCompiledPlan(input.plan);

  const memoryHits = await searchWorkspaceMemories(input.auth, input.plan.intent.goal, 5, {
    workflowId: input.plan.loopId,
  }).catch(() => []);

  const triggerFields = input.eventPayload
    ? extractTriggerKnownFields(input.eventPayload, input.triggerSlug)
    : {};
  const triggerContext = formatTriggerKnownFields(triggerFields);

  const prompt = buildRuntimePlannerPrompt({
    planOutcome: input.plan.intent.outcome,
    planGoal: input.plan.intent.goal,
    agentInstructions: input.plan.agent?.instructions,
    successCriteria: input.plan.intent.successCriteria,
    toolCatalog: input.plan.toolCatalog.map((t) => ({
      id: t.id,
      capability: t.capability,
      connector: t.connector,
      actionSlug: t.actionSlug,
      plannerCard: t.plannerCard,
      ...(t.modifiedInputSchema ? { modifiedInputSchema: t.modifiedInputSchema } : {}),
      ...(t.behaviorInstructions.length ? { behaviorInstructions: t.behaviorInstructions } : {}),
      ...(t.composioAction ? { composioAction: t.composioAction } : {}),
    })),
    stepHistory: input.state.toolResults,
    workspaceMemory: memoryHits.map((m) => m.text),
    connectorPlaybook: input.plan.connectorPlaybook,
    exhaustedToolIds: input.exhaustedToolIds,
    ...(triggerContext ? { triggerContext } : {}),
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
