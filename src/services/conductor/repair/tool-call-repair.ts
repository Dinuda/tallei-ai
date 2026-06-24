import { InvalidToolInputError, type ModelMessage, type ToolCallRepairFunction, type ToolSet } from "ai";

import { buildRepairMetadata, classifyBuilderRepairFailure } from "../builder/repair-policy.js";
import { BUILDER_REPAIR_MAX_RETRIES, type BuilderRepairMetadata } from "../builder/repair-protocol.js";
import { repairArtifactSetupToolInput } from "../inputs/artifact-setup-input.js";
import { repairRenderTypeToolInput } from "../builder/render-type.js";
import {
  extractAppSelectionSlugsFromUnknown,
  normalizeGetAvailableToolsInput,
} from "../inputs/get-available-tools-input.js";
import { repairToolInputJsonString, tryParseToolInputJson } from "./tool-input-json-repair.js";

const JSON_REPAIR_TOOLS = new Set([
  "artifactSetup",
  "renderType",
  "requirementSetup",
  "intentClarification",
  "saveApproval",
  "activationApproval",
  "scheduleSetup",
  "connectorSetup",
  "knowledgeBaseSetup",
  "appSelection",
  "resolveIntent",
]);

type ToolCallLike = { type: "tool-call"; toolCallId: string; toolName: string; input: string };

function attemptToolInputRepair(
  toolCall: ToolCallLike,
  messages: ModelMessage[],
  sessionGoal: string,
): { repairedInput: string | null; attemptedFixes: string[] } {
  if (toolCall.toolName === "getAvailableTools") {
    return {
      repairedInput: repairGetAvailableToolsCall(toolCall, messages, sessionGoal),
      attemptedFixes: [
        "parsed partial tool JSON",
        "filled selected apps from prior app selection",
        "normalized the discovery payload",
      ],
    };
  }

  if (toolCall.toolName === "artifactSetup") {
    return {
      repairedInput: repairArtifactSetupToolInput(toolCall.input),
      attemptedFixes: ["repaired malformed artifact template JSON"],
    };
  }

  if (toolCall.toolName === "renderType") {
    return {
      repairedInput: repairRenderTypeToolInput(toolCall.input),
      attemptedFixes: ["normalized render type payload"],
    };
  }

  if (JSON_REPAIR_TOOLS.has(toolCall.toolName)) {
    return {
      repairedInput: repairToolInputJsonString(toolCall.input),
      attemptedFixes: ["repaired malformed tool JSON"],
    };
  }

  return {
    repairedInput: repairToolInputJsonString(toolCall.input),
    attemptedFixes: ["attempted generic JSON repair"],
  };
}

export function createLoopBuilderToolCallRepair(
  sessionGoal: string,
  options?: {
    onRepairAttempt?: (repair: BuilderRepairMetadata) => void | Promise<void>;
    onRepairExhausted?: (repair: BuilderRepairMetadata) => void | Promise<void>;
    onRepairRequired?: (repair: BuilderRepairMetadata) => void | Promise<void>;
  },
): ToolCallRepairFunction<ToolSet> {
  const attemptsByToolCallId = new Map<string, number>();

  return async ({ toolCall, error, messages }) => {
    const decision = classifyBuilderRepairFailure({ toolName: toolCall.toolName, error });
    const attemptCount = (attemptsByToolCallId.get(toolCall.toolCallId) ?? 0) + 1;
    attemptsByToolCallId.set(toolCall.toolCallId, attemptCount);

    const { repairedInput, attemptedFixes } = attemptToolInputRepair(toolCall, messages, sessionGoal);
    const metadata = buildRepairMetadata(toolCall.toolName, attemptCount, decision, repairedInput ? attemptedFixes : []);

    if (decision.outcome === "repair_and_retry" && InvalidToolInputError.isInstance(error) && repairedInput && attemptCount <= BUILDER_REPAIR_MAX_RETRIES) {
      await options?.onRepairAttempt?.(metadata);
      return { ...toolCall, input: repairedInput };
    }

    if (decision.outcome === "repair_and_retry") {
      const exhausted = {
        ...metadata,
        outcome: "pause_for_repair" as const,
        pausedForRepair: true,
      };
      await options?.onRepairExhausted?.(exhausted);
      await options?.onRepairRequired?.(exhausted);
      return {
        ...toolCall,
        toolName: "repairPrompt",
        input: JSON.stringify({
          blockedAction: toolCall.toolName,
          question: `I need one correction before I can continue with ${toolCall.toolName}.`,
          issue: exhausted.reason,
          fieldErrors: exhausted.fieldErrors,
          attemptedFixes: exhausted.attemptedFixes,
          repairContext: exhausted.lastValidationMessage,
        }),
      };
    }

    if (decision.outcome === "pause_for_repair") {
      await options?.onRepairRequired?.(metadata);
      return {
        ...toolCall,
        toolName: "repairPrompt",
        input: JSON.stringify({
          blockedAction: toolCall.toolName,
          question: `I need one correction before I can continue with ${toolCall.toolName}.`,
          issue: metadata.reason,
          fieldErrors: metadata.fieldErrors,
          attemptedFixes: metadata.attemptedFixes,
          repairContext: metadata.lastValidationMessage,
        }),
      };
    }

    return null;
  };
}

function repairGetAvailableToolsCall(
  toolCall: ToolCallLike,
  messages: ModelMessage[],
  sessionGoal: string,
): string | null {
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

  return JSON.stringify({
    outcome: normalized.outcome,
    cadence: normalized.cadence,
    approvalModel: normalized.approvalModel,
    selectedToolkits: normalized.selectedToolkits,
    capabilityQueries: normalized.capabilityQueries,
    assumptions: normalized.assumptions,
  });
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
