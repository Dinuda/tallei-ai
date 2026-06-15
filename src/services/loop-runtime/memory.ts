import type { LoopDefinition, LoopGateType, LoopRunAgent } from "../loop-executor/types.js";
import {
  buildDeliveryRecipientsPatch,
  contactsFromDecision,
  type DeliveryRecipients,
} from "./contacts-context.js";
import type { WebSearchSource } from "../loop-engine/contracts.js";

type ApprovedMemory = {
  id: string;
  excerpt: string;
};

type ApprovedWebSource = WebSearchSource;

type OperatorRevision = {
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
  return "nodeKind" in agent && agent.nodeKind === "operator_input";
}

/** True when this agent step owns run_start operator input collection (not research/draft agents). */
export function agentCollectsRunStartInput(agent: {
  id: string;
  name?: string;
  nodeKind?: string;
  tools?: Array<{ ref: string }>;
  gate?: { type: string } | null;
}): boolean {
  return agent.nodeKind === "operator_input" || agent.tools?.some((tool) => tool.ref === "internal.operator_input") === true;
}

const DELIVERY_CONFIG_INPUT_PATTERN = /subscriber|audience|recipient|mailing.?list|contact.?list|list.?id|send.?to|broadcast.?list/i;

function isDeliveryConfigInputKey(key: string): boolean {
  return DELIVERY_CONFIG_INPUT_PATTERN.test(key.trim());
}

export function resolveRequiredInputKeys(
  definition: LoopDefinition,
  gateFields?: Array<{ key: string }>,
): string[] {
  if (definition.inputRequirements?.length) return definition.inputRequirements.map((item) => item.key);
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
  return [];
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
  if (readGateEvalBlockers(input.gatePayload).includes("placeholder_detected")) {
    return hasRequiredContentInputs(input.definition, input.runMemory);
  }
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

type GateMemoryPatch = Partial<Pick<RunMemory, "inputs" | "approvedMemories" | "approvedSources" | "operatorRevisions">> & {
  deliveryRecipients?: DeliveryRecipients;
};

export function applyGateDecisionToRunMemory(input: {
  gateType: LoopGateType;
  decision: Record<string, unknown>;
  definition: LoopDefinition;
  gateFields?: Array<{ key: string }>;
  gateAgentId?: string;
}): GateMemoryPatch {
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
  if (input.gateType === "pre_send") {
    const contacts = contactsFromDecision(input.decision);
    if (contacts.length === 0) return {};
    const audienceId = typeof input.decision.audienceId === "string" ? input.decision.audienceId.trim() : undefined;
    return {
      deliveryRecipients: buildDeliveryRecipientsPatch({ contacts, source: "uploaded", audienceId }),
    };
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
  options?: {
    userProfile?: {
      profileText: string;
      memories?: Array<{ id: string; text: string }>;
    } | null;
  },
): Record<string, unknown> {
  const handoff: Record<string, unknown> = { ...priorOutputs, ...memory.inputs };
  if (options?.userProfile?.profileText) {
    handoff.user_profile = options.userProfile.profileText;
    if (options.userProfile.memories?.length) {
      handoff.user_profile_memories = options.userProfile.memories;
    }
  }
  if (Object.keys(memory.operatorRevisions).length > 0) {
    handoff.operator_revisions = memory.operatorRevisions;
  }
  delete handoff[agent.id];
  return handoff;
}
