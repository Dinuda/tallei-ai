import { InvalidToolInputError, type ModelMessage, type ToolCallRepairFunction, type ToolSet } from "ai";

import { repairArtifactSetupToolInput } from "../inputs/artifact-setup-input.js";
import {
  extractAppSelectionSlugsFromUnknown,
  normalizeGetAvailableToolsInput,
} from "../inputs/get-available-tools-input.js";
import { repairToolInputJsonString, tryParseToolInputJson } from "./tool-input-json-repair.js";

const JSON_REPAIR_TOOLS = new Set([
  "artifactSetup",
  "requirementSetup",
  "interactivePrompt",
  "scheduleSetup",
  "connectorSetup",
  "knowledgeBaseSetup",
  "appSelection",
]);

export function createLoopBuilderToolCallRepair(sessionGoal: string): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, error, messages }) => {
    if (!InvalidToolInputError.isInstance(error)) return null;

    if (toolCall.toolName === "getAvailableTools") {
      return repairGetAvailableToolsCall(toolCall, messages, sessionGoal);
    }

    if (toolCall.toolName === "artifactSetup") {
      const repaired = repairArtifactSetupToolInput(toolCall.input);
      return repaired ? { ...toolCall, input: repaired } : null;
    }

    if (JSON_REPAIR_TOOLS.has(toolCall.toolName)) {
      const repaired = repairToolInputJsonString(toolCall.input);
      return repaired ? { ...toolCall, input: repaired } : null;
    }

    const generic = repairToolInputJsonString(toolCall.input);
    return generic ? { ...toolCall, input: generic } : null;
  };
}

async function repairGetAvailableToolsCall(
  toolCall: { type: "tool-call"; toolCallId: string; toolName: string; input: string },
  messages: ModelMessage[],
  sessionGoal: string,
) {
  const parsed = tryParseToolInputJson(toolCall.input);
  const partial = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};

  const selectedFromMessages = extractAppSelectionSlugsFromMessages(messages);
  if (selectedFromMessages.length > 0) {
    partial.selectedToolkits = selectedFromMessages;
  }

  const normalized = normalizeGetAvailableToolsInput(partial, sessionGoal);
  if (!normalized.outcome.trim() || normalized.selectedToolkits.length === 0) {
    return null;
  }

  return {
    ...toolCall,
    input: JSON.stringify({
      outcome: normalized.outcome,
      cadence: normalized.cadence,
      approvalModel: normalized.approvalModel,
      selectedToolkits: normalized.selectedToolkits,
      capabilityQueries: normalized.capabilityQueries,
      assumptions: normalized.assumptions,
    }),
  };
}

function extractAppSelectionSlugsFromMessages(messages: ModelMessage[]): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    collectAppSelectionSlugs(message, slugs, seen);
  }
  return slugs;
}

function collectAppSelectionSlugs(value: unknown, slugs: string[], seen: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectAppSelectionSlugs(entry, slugs, seen);
    return;
  }

  const record = value as Record<string, unknown>;
  if (record.toolName === "appSelection" || record.type === "tool-result" && record.toolName === "appSelection") {
    const output = record.output ?? record.result ?? record.content;
    for (const slug of extractAppSelectionSlugsFromUnknown(output)) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
  }

  for (const nested of Object.values(record)) {
    collectAppSelectionSlugs(nested, slugs, seen);
  }
}
