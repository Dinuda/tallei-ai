import type { AgentHandoffBinding, LoopRunAgent } from "../loop-executor/types.js";
import type { LoopDefinition } from "../loop-executor/types.js";
import { resolveAgentHandoffBindings } from "./typed-handoff.js";
import type { RuntimeContext } from "./types.js";
import { resolvedRuntimeInputs } from "./input-satisfaction.js";

export type ArtifactMap = Record<string, unknown>;

export function resolveStepInputs(input: {
  agent: LoopRunAgent;
  artifacts: ArtifactMap;
  context: RuntimeContext;
  definition: LoopDefinition;
  stableConfig?: Record<string, unknown>;
}): { value: Record<string, unknown>; unresolved: AgentHandoffBinding[] } {
  if (input.agent.handoffBindings.length > 0) {
    const handoff = resolveAgentHandoffBindings({
      agent: input.agent,
      priorOutputs: input.artifacts,
      operatorInputs: resolvedRuntimeInputs(input.definition, input.context),
      stableConfig: input.stableConfig,
    });
    return {
      value: handoff.value,
      unresolved: handoff.resolvedBindings
        .filter((b) => b.binding.required && !b.resolved)
        .map((b) => b.binding),
    };
  }
  return {
    value: { ...input.artifacts, ...input.context.inputs },
    unresolved: [],
  };
}
