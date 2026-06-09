import type { LoopDefinition, LoopGateType, LoopRunAgent } from "../loop-executor/types.js";
import type { WebSearchSource } from "../loop-engine/contracts.js";

export type ApprovedMemory = {
  id: string;
  excerpt: string;
};

export type ApprovedWebSource = WebSearchSource;

export type OperatorRevision = {
  feedback?: string;
  editedText?: string;
  at: string;
};

export type RunMemory = {
  inputs: Record<string, string>;
  approvedMemories: ApprovedMemory[];
  approvedSources: Record<string, ApprovedWebSource[]>;
  operatorRevisions: Record<string, OperatorRevision>;
  updatedAt: string;
};

export function emptyRunMemory(): RunMemory {
  return {
    inputs: {},
    approvedMemories: [],
    approvedSources: {},
    operatorRevisions: {},
    updatedAt: new Date().toISOString(),
  };
}

export function isInputValidationAgent(agent: { id: string; name?: string }): boolean {
  const label = `${agent.id} ${agent.name ?? ""}`.toLowerCase();
  return label.includes("validator") || label.includes("input_gate") || label.includes("input checker");
}

const DELIVERY_CONFIG_INPUT_PATTERN = /subscriber|audience|recipient|mailing.?list|contact.?list|list.?id|send.?to|broadcast.?list/i;

export function isDeliveryConfigInputKey(key: string): boolean {
  return DELIVERY_CONFIG_INPUT_PATTERN.test(key.trim());
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

export function contentInputKeys(
  definition: LoopDefinition,
  gateFields?: Array<{ key: string }>,
): string[] {
  return resolveRequiredInputKeys(definition, gateFields).filter((key) => !isDeliveryConfigInputKey(key));
}

export function hasRequiredRunInputs(
  definition: LoopDefinition,
  runMemory: RunMemory,
  gateFields?: Array<{ key: string }>,
): boolean {
  const keys = resolveRequiredInputKeys(definition, gateFields);
  return keys.every((key) => Boolean(runMemory.inputs[key]?.trim()));
}

export function hasRequiredContentInputs(
  definition: LoopDefinition,
  runMemory: RunMemory,
  gateFields?: Array<{ key: string }>,
): boolean {
  const keys = contentInputKeys(definition, gateFields);
  if (keys.length === 0) return true;
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

function readApprovedWebSourceRow(row: unknown): ApprovedWebSource | null {
  const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const url = typeof item.url === "string" ? item.url.trim() : "";
  const snippet = typeof item.snippet === "string" ? item.snippet.trim() : "";
  if (!title || !url || !snippet) return null;
  if (item.include === false) return null;
  return { title, url, snippet };
}

export function applyGateDecisionToRunMemory(input: {
  gateType: LoopGateType;
  decision: Record<string, unknown>;
  definition: LoopDefinition;
  gateFields?: Array<{ key: string }>;
  gateAgentId?: string;
}): Partial<Pick<RunMemory, "inputs" | "approvedMemories" | "approvedSources" | "operatorRevisions">> {
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
  if (input.gateType === "source_confirmation") {
    const agentId = input.gateAgentId
      ?? (typeof input.decision.agentId === "string" ? input.decision.agentId : "");
    if (!agentId) return {};
    const rows: ApprovedWebSource[] = [];
    const seen = new Set<string>();
    const pushRow = (row: unknown) => {
      const parsed = readApprovedWebSourceRow(row);
      if (!parsed || seen.has(parsed.url)) return;
      seen.add(parsed.url);
      rows.push(parsed);
    };
    for (const row of Array.isArray(input.decision.items) ? input.decision.items : []) {
      pushRow(row);
    }
    for (const row of Array.isArray(input.decision.addedSources) ? input.decision.addedSources : []) {
      pushRow(row);
    }
    return { approvedSources: { [agentId]: rows } };
  }
  return {};
}

export function buildOperatorRevisionPatch(input: {
  agentId: string;
  feedback?: string;
  editedText?: string;
}): Partial<Pick<RunMemory, "operatorRevisions">> {
  const feedback = input.feedback?.trim();
  const editedText = input.editedText?.trim();
  if (!feedback && !editedText) return {};
  return {
    operatorRevisions: {
      [input.agentId]: {
        ...(feedback ? { feedback } : {}),
        ...(editedText ? { editedText } : {}),
        at: new Date().toISOString(),
      },
    },
  };
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
  if (Object.keys(memory.approvedSources).length > 0) {
    handoff.approved_sources = memory.approvedSources;
    for (const [agentId, sources] of Object.entries(memory.approvedSources)) {
      handoff[`approved_sources.${agentId}`] = sources;
    }
    const flatSources = Object.values(memory.approvedSources).flat();
    if (flatSources.length > 0) {
      handoff.curated_web_sources = flatSources;
    }
  }
  if (Object.keys(memory.inputs).length > 0) handoff.operator_input = { inputs: memory.inputs };
  if (Object.keys(memory.operatorRevisions).length > 0) {
    handoff.operator_revisions = memory.operatorRevisions;
    const revision = memory.operatorRevisions[agent.id];
    if (revision) {
      handoff.operator_revision = revision;
      if (revision.feedback) handoff.revision_feedback = revision.feedback;
      if (revision.editedText) handoff.revision_edited_text = revision.editedText;
    }
  }
  delete handoff[agent.id];
  return handoff;
}
