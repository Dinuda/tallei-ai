import type { LoopRunAgent } from "../loop-executor/types.js";
import { agentCollectsRunStartInput } from "./memory.js";

export type StepKind = "operator_input" | "action" | "agent";

/** Resolve which execution track applies for a roster step. */
export function resolveStepKind(agent: LoopRunAgent, hasConnectorAction: boolean): StepKind {
  if (agentCollectsRunStartInput(agent) || agent.tools.some((tool) => tool.ref === "internal.operator_input")) {
    return "operator_input";
  }
  if (hasConnectorAction) return "action";
  return "agent";
}
