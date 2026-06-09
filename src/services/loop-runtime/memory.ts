import type { LoopDefinition, LoopGateType, LoopRunAgent } from "../loop-executor/types.js";

export type ApprovedMemory = {
  id: string;
  excerpt: string;
};

export type RunMemory = {
  inputs: Record<string, string>;
  approvedMemories: ApprovedMemory[];
  updatedAt: string;
};

export function emptyRunMemory(): RunMemory {
  return { inputs: {}, approvedMemories: [], updatedAt: new Date().toISOString() };
}

export function isInputValidationAgent(agent: { id: string; name?: string }): boolean {
  const label = `${agent.id} ${agent.name ?? ""}`.toLowerCase();
  return label.includes("validator") || label.includes("input_gate") || label.includes("input checker");
}

export function resolveRequiredInputKeys(
  definition: LoopDefinition,
  gateFields?: Array<{ key: string }>,
): string[] {
  if (definition.inputsRequired?.length) return [...definition.inputsRequired];
  const fromGraph: string[] = [];
  for (const child of definition.agentGraph?.children ?? []) {
    const schema = child.inputContract?.schema;
    const provided = schema && typeof schema === "object" ? (schema as Record<string, unknown>).provided : null;
    if (provided && typeof provided === "object" && !Array.isArray(provided)) {
      fromGraph.push(...Object.keys(provided as Record<string, unknown>).map((key) => key.replace(/\?$/, "")));
    }
  }
  if (fromGraph.length > 0) return [...new Set(fromGraph)];
  if (gateFields?.length) return gateFields.map((field) => field.key);
  return ["sprint_notes"];
}

export function hasRequiredRunInputs(
  definition: LoopDefinition,
  runMemory: RunMemory,
  gateFields?: Array<{ key: string }>,
): boolean {
  const keys = resolveRequiredInputKeys(definition, gateFields);
  return keys.every((key) => Boolean(runMemory.inputs[key]?.trim()));
}

function readGateEvalBlockers(gatePayload: Record<string, unknown>): string[] {
  const result = gatePayload.result && typeof gatePayload.result === "object" && !Array.isArray(gatePayload.result)
    ? gatePayload.result as Record<string, unknown>
    : {};
  const goalEval = result.goalEval && typeof result.goalEval === "object" && !Array.isArray(result.goalEval)
    ? result.goalEval as Record<string, unknown>
    : {};
  return Array.isArray(goalEval.blockers)
    ? goalEval.blockers.filter((blocker): blocker is string => typeof blocker === "string")
    : [];
}

/** True when a missing_input gate should advance on approve (draft review), not collect operator paste. */
export function isMisclassifiedDraftReviewGate(input: {
  gateType: LoopGateType;
  gateStatus: string;
  agent: LoopRunAgent;
  gatePayload: Record<string, unknown>;
  definition: LoopDefinition;
  runMemory: RunMemory;
}): boolean {
  if (input.gateType !== "missing_input" || input.gateStatus === "submitted") return false;
  if (isInputValidationAgent(input.agent)) return false;
  if (readGateEvalBlockers(input.gatePayload).includes("placeholder_detected")) return true;
  return hasRequiredRunInputs(input.definition, input.runMemory);
}

export function applyGateDecisionToRunMemory(input: {
  gateType: LoopGateType;
  decision: Record<string, unknown>;
  definition: LoopDefinition;
  gateFields?: Array<{ key: string }>;
}): Partial<Pick<RunMemory, "inputs" | "approvedMemories">> {
  if (input.gateType === "missing_input" && typeof input.decision.value === "string") {
    const value = input.decision.value.trim();
    if (!value) return {};
    return {
      inputs: Object.fromEntries(
        resolveRequiredInputKeys(input.definition, input.gateFields).map((key) => [key, value]),
      ),
    };
  }
  if (input.gateType === "memory_confirmation" && Array.isArray(input.decision.items)) {
    return {
      approvedMemories: input.decision.items
        .map((row) => {
          const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
          return typeof item.id === "string" && typeof item.excerpt === "string" && item.include !== false
            ? { id: item.id, excerpt: item.excerpt }
            : null;
        })
        .filter((row): row is ApprovedMemory => row !== null),
    };
  }
  return {};
}

export function buildAgentHandoff(
  agent: LoopRunAgent,
  memory: RunMemory,
  priorOutputs: Record<string, unknown>,
): Record<string, unknown> {
  const handoff: Record<string, unknown> = { ...priorOutputs, ...memory.inputs };
  if (memory.approvedMemories.length > 0) {
    handoff.approved_memories = memory.approvedMemories;
    handoff.memories = memory.approvedMemories;
  }
  if (Object.keys(memory.inputs).length > 0) handoff.operator_input = { inputs: memory.inputs };
  delete handoff[agent.id];
  return handoff;
}
