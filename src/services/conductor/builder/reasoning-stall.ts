import { randomUUID } from "crypto";
import { isReasoningUIPart, isToolUIPart, getToolName, type UIMessage } from "ai";

import type { WorkflowBuilderSession } from "../services/session.service.js";

const CLIENT_UI_TOOL_NAMES = new Set([
  "appSelection",
  "connectorSetup",
  "scheduleSetup",
  "knowledgeBaseSetup",
  "artifactSetup",
  "requirementSetup",
  "intentClarification",
  "saveApproval",
  "activationApproval",
  "renderType",
]);

const ACTIVE_BUILDER_STATES = new Set([
  "intent.collecting",
  "intent.resolving",
  "requirements.selecting_apps",
  "requirements.discovering_tools",
  "requirements.resolving",
  "compile.previewing",
  "compile.awaiting_approval",
]);

export function isReasoningOnlyAssistantMessage(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;

  let hasReasoning = false;
  let hasUserFacingContent = false;

  for (const part of message.parts) {
    if (part.type === "text" && part.text?.trim()) {
      hasUserFacingContent = true;
      break;
    }
    if (isToolUIPart(part)) {
      hasUserFacingContent = true;
      break;
    }
    if (isReasoningUIPart(part) && (part.text?.trim() || part.state === "streaming")) {
      hasReasoning = true;
    }
  }

  return hasReasoning && !hasUserFacingContent;
}

function messageHasPendingClientUiTool(message: UIMessage): boolean {
  return message.parts.some((part) =>
    isToolUIPart(part)
    && CLIENT_UI_TOOL_NAMES.has(getToolName(part))
    && (part.state === "input-available" || part.state === "input-streaming"));
}

function lastAssistantStepParts(message: UIMessage): UIMessage["parts"] {
  const lastStepStartIndex = message.parts.reduce(
    (lastIndex, part, index) => (part.type === "step-start" ? index : lastIndex),
    0,
  );
  return message.parts.slice(lastStepStartIndex);
}

/** Model ended a step with narration but no tool call — common with thinking models. */
export function assistantTurnStalled(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  if (messageHasPendingClientUiTool(message)) return false;
  if (isReasoningOnlyAssistantMessage(message)) return true;

  const stepParts = lastAssistantStepParts(message);
  if (stepParts.some((part) => isToolUIPart(part))) return false;

  return stepParts.some((part) => part.type === "text" && part.text?.trim());
}

export function buildDiscoveryFallbackInteractivePrompt(goal: string) {
  const normalized = goal.trim().toLowerCase();
  const looksEventDriven = /monitor|ticket|email|message|alert|notify|whenever|arrives|incoming/.test(normalized);

  return {
    question: "How should this loop run?",
    options: [
      {
        id: "event",
        label: "Whenever new items arrive",
        value: "event_driven",
        description: "Run as soon as new tickets, messages, or records show up",
      },
      {
        id: "schedule",
        label: "On a regular schedule",
        value: "scheduled",
        description: "For example hourly, daily, or weekly checks",
      },
      {
        id: "manual",
        label: "Only when I ask",
        value: "manual",
        description: "Run on demand from the dashboard or chat",
      },
    ],
    recommendedOptionIds: [looksEventDriven ? "event" : "schedule"],
    allowMultiple: false,
    allowOther: true,
  };
}

function buildRequirementsFallbackToolPart(
  session: WorkflowBuilderSession,
): UIMessage["parts"][number] | null {
  const toolCallId = randomUUID();

  if (!session.resolvedIntent) {
    return {
      type: "tool-intentClarification",
      toolCallId,
      state: "input-available",
      input: buildDiscoveryFallbackInteractivePrompt(session.goal),
    } as UIMessage["parts"][number];
  }

  if (session.discoveredToolContracts.length === 0) {
    return {
      type: "tool-appSelection",
      toolCallId,
      state: "input-available",
      input: {
        question: "Which apps should this loop use?",
        recommendedToolkitSlugs: [],
        allowMultiple: true,
      },
    } as UIMessage["parts"][number];
  }

  const unresolved = session.buildContract?.requirements?.filter(
    (entry) => entry.required && entry.status !== "resolved",
  ) ?? [];

  for (const requirement of unresolved) {
    if (requirement.kind === "connector") {
      return {
        type: "tool-connectorSetup",
        toolCallId,
        state: "input-available",
        input: { requirementId: requirement.id },
      } as UIMessage["parts"][number];
    }
    if (requirement.kind === "trigger_schedule") {
      return {
        type: "tool-scheduleSetup",
        toolCallId,
        state: "input-available",
        input: {
          requirementId: requirement.id,
          question: requirement.question ?? "How often should this loop run?",
          allowOther: true,
        },
      } as UIMessage["parts"][number];
    }
    if (requirement.kind === "grounding") {
      return {
        type: "tool-knowledgeBaseSetup",
        toolCallId,
        state: "input-available",
        input: { requirementId: requirement.id },
      } as UIMessage["parts"][number];
    }
    if (requirement.kind === "artifact_contract") {
      return {
        type: "tool-artifactSetup",
        toolCallId,
        state: "input-available",
        input: { requirementId: requirement.id },
      } as UIMessage["parts"][number];
    }
    if (requirement.kind === "stable_input") {
      return {
        type: "tool-requirementSetup",
        toolCallId,
        state: "input-available",
        input: {
          requirementId: requirement.id,
          question: requirement.question ?? "What value should this loop use?",
          options: [
            { id: "continue", label: "Use a sensible default", value: "default" },
            { id: "custom", label: "I'll describe it", value: "custom" },
          ],
          allowOther: true,
        },
      } as UIMessage["parts"][number];
    }
  }

  return {
    type: "tool-saveApproval",
    toolCallId,
    state: "input-available",
    input: {
      question: "Ready to continue building this loop?",
      options: [
        { id: "continue", label: "Save and test the loop", value: "continue" },
        { id: "not_yet", label: "Not yet", value: "not_yet" },
      ],
      recommendedOptionIds: ["continue"],
      allowOther: true,
    },
  } as UIMessage["parts"][number];
}

function appendFallbackToolPart(message: UIMessage, part: UIMessage["parts"][number]): UIMessage {
  return {
    ...message,
    parts: [...message.parts, part],
  };
}

function buildAssistantWithFallbackTool(session: WorkflowBuilderSession): UIMessage | null {
  const part = buildRequirementsFallbackToolPart(session);
  if (!part) return null;
  return {
    id: randomUUID(),
    role: "assistant",
    parts: [
      { type: "step-start" } as UIMessage["parts"][number],
      part,
    ],
  };
}

function discoveryNeedsFallbackPrompt(messages: UIMessage[], session: WorkflowBuilderSession): boolean {
  if (session.resolvedIntent || session.builderState !== "intent.collecting") return false;
  const last = messages.at(-1);
  if (!last) return false;
  if (last.role === "user") return true;
  if (last.role !== "assistant") return false;
  if (isReasoningOnlyAssistantMessage(last)) return true;
  return assistantTurnStalled(last);
}

function builderNeedsProgressRepair(messages: UIMessage[], session: WorkflowBuilderSession): boolean {
  if (!ACTIVE_BUILDER_STATES.has(session.builderState)) return false;
  const last = messages.at(-1);
  if (!last) return false;
  if (last.role === "user") return true;
  if (last.role !== "assistant") return false;
  if (messageHasPendingClientUiTool(last)) return false;
  return assistantTurnStalled(last);
}

export function patchReasoningOnlyAssistantMessages(
  messages: UIMessage[],
  session: WorkflowBuilderSession,
): UIMessage[] {
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!last || last.role !== "assistant" || !assistantTurnStalled(last)) {
    return messages;
  }

  const part = buildRequirementsFallbackToolPart(session);
  if (!part) return messages;

  return messages.map((message, index) => (
    index === lastIndex ? appendFallbackToolPart(message, part) : message
  ));
}

export function ensureDiscoveryPromptMessages(
  messages: UIMessage[],
  session: WorkflowBuilderSession,
): UIMessage[] {
  if (!discoveryNeedsFallbackPrompt(messages, session)) return messages;

  const last = messages.at(-1);
  if (!last) return messages;

  if (last.role === "assistant") {
    return patchReasoningOnlyAssistantMessages(messages, session);
  }

  if (last.role === "user") {
    const assistant = buildAssistantWithFallbackTool(session);
    return assistant ? [...messages, assistant] : messages;
  }

  return messages;
}

/** Repair stalled builder turns across discovery and requirements (not connector-agent UI). */
export function ensureBuilderProgressMessages(
  messages: UIMessage[],
  session: WorkflowBuilderSession,
): UIMessage[] {
  const discoveryPatched = ensureDiscoveryPromptMessages(messages, session);
  if (discoveryPatched !== messages) return discoveryPatched;
  if (!builderNeedsProgressRepair(messages, session)) return messages;

  const last = messages.at(-1);
  if (!last) return messages;

  if (last.role === "assistant") {
    return patchReasoningOnlyAssistantMessages(messages, session);
  }

  if (last.role === "user") {
    const assistant = buildAssistantWithFallbackTool(session);
    return assistant ? [...messages, assistant] : messages;
  }

  return messages;
}
