import { getToolName, isReasoningUIPart, isToolUIPart, type UIMessage } from "ai";

import {
  isDataAgentPart as isStreamDataAgentPart,
  mergeToolPartIntoParts,
} from "@/lib/spec-run-tool-transcript";

import type { DataAgentPartData } from "@/components/ai-elements/transcript-message";

import {
  formatAgentStructuredOutput,
  isRunMetaNarration,
  type SpecRunInteraction,
  type SpecRunStep,
} from "./spec-run-view-utils";

const HIDDEN_CONTROL_TEXTS = new Set(["continue", "resume", "run", "rerun"]);
const GATE_TOOL_NAMES = new Set(["requestReview", "requestApproval", "requestInput"]);
const FINALIZE_TOOL_NAME = "finalizeAgent";

export function readMessageText(message: UIMessage): string {
  const part = message.parts.find((entry) => entry.type === "text");
  return part && part.type === "text" ? part.text.trim() : "";
}

export function isHiddenControlMessage(message: UIMessage): boolean {
  if (message.role !== "user") return false;
  return HIDDEN_CONTROL_TEXTS.has(readMessageText(message).toLowerCase());
}

export function hasSubstantiveAssistantMessages(messages: UIMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant") return false;
    return message.parts.some((part) => {
      if (part.type === "data-agent") return true;
      if (part.type === "text" && part.text.trim()) return true;
      if (part.type.startsWith("tool-") || part.type === "dynamic-tool") return true;
      return false;
    });
  });
}

function isDataAgentPart(
  part: UIMessage["parts"][number],
): part is { type: "data-agent"; data: DataAgentPartData } {
  return isStreamDataAgentPart(part);
}

export function readFinalizeAgentOutput(part: UIMessage["parts"][number]): string {
  if (!isToolUIPart(part) || getToolName(part) !== FINALIZE_TOOL_NAME) return "";
  if (part.state !== "output-available") return "";
  const input = part.input && typeof part.input === "object" && !Array.isArray(part.input)
    ? part.input as Record<string, unknown>
    : {};
  return formatAgentStructuredOutput(input.output);
}

function isDisplayableAssistantText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  if (/"emailDrafts"\s*:/.test(trimmed)) return false;
  if (isRunMetaNarration(trimmed)) return false;
  return true;
}

export function resolveStreamTextForStep(step: SpecRunStep, messages: UIMessage[]): string {
  for (const message of messages) {
    if (message.role !== "assistant") continue;

    let headerIndex = -1;
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (!isDataAgentPart(part)) continue;
      const matchesIndex = typeof part.data.stepIndex === "number"
        && part.data.stepIndex === step.step_index;
      const matchesAgent = typeof part.data.agentId === "string"
        && part.data.agentId === step.agent_id;
      if (matchesIndex || matchesAgent) {
        headerIndex = index;
        break;
      }
    }
    if (headerIndex < 0) continue;

    for (let index = headerIndex + 1; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (isDataAgentPart(part)) break;
      if (part.type === "text" && isDisplayableAssistantText(part.text)) {
        return part.text.trim();
      }
      const finalized = readFinalizeAgentOutput(part);
      if (finalized) return finalized;
    }
  }

  return "";
}

export function resolveFinalizeAgentFromMessages(
  step: SpecRunStep,
  messages: UIMessage[],
): string {
  for (const message of messages) {
    if (message.role !== "assistant") continue;

    let headerIndex = -1;
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (!isDataAgentPart(part)) continue;
      const matchesIndex = typeof part.data.stepIndex === "number"
        && part.data.stepIndex === step.step_index;
      const matchesAgent = typeof part.data.agentId === "string"
        && part.data.agentId === step.agent_id;
      if (matchesIndex || matchesAgent) {
        headerIndex = index;
        break;
      }
    }
    if (headerIndex < 0) continue;

    for (let index = headerIndex + 1; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (isDataAgentPart(part)) break;
      const finalized = readFinalizeAgentOutput(part);
      if (finalized) return finalized;
    }
  }

  return "";
}

/** Merge assistant parts for one step across multiple flushed messages (mirrors server normalize). */
function normalizeReasoningText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function pickPreferredReasoningPart(
  left: UIMessage["parts"][number],
  right: UIMessage["parts"][number],
): UIMessage["parts"][number] {
  if (!isReasoningUIPart(left) || !isReasoningUIPart(right)) return right;
  if (left.state === "streaming" && right.state !== "streaming") return left;
  if (right.state === "streaming" && left.state !== "streaming") return right;
  return (right.text?.length ?? 0) >= (left.text?.length ?? 0) ? right : left;
}

function mergeReasoningPart(
  merged: UIMessage["parts"],
  part: UIMessage["parts"][number],
): UIMessage["parts"] {
  if (!isReasoningUIPart(part)) return [...merged, part];

  const normalized = normalizeReasoningText(part.text ?? "");
  if (!normalized) return [...merged, part];

  for (let index = 0; index < merged.length; index += 1) {
    const existing = merged[index];
    if (!isReasoningUIPart(existing)) continue;
    const existingNorm = normalizeReasoningText(existing.text ?? "");
    if (!existingNorm) continue;
    if (normalized === existingNorm
      || normalized.startsWith(existingNorm)
      || existingNorm.startsWith(normalized)) {
      const next = [...merged];
      next[index] = pickPreferredReasoningPart(existing, part);
      return next;
    }
  }

  return [...merged, part];
}

function mergeTextPart(
  merged: UIMessage["parts"],
  part: UIMessage["parts"][number],
): UIMessage["parts"] {
  if (part.type !== "text") return mergeReasoningPart(merged, part);
  const text = part.text?.trim() ?? "";
  if (!text) return merged;

  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const existing = merged[index];
    if (existing?.type !== "text") continue;
    const existingText = existing.text?.trim() ?? "";
    if (!existingText) continue;
    if (existingText === text) return merged;
    if (text.startsWith(existingText)) {
      const next = [...merged];
      next[index] = part;
      return next;
    }
    if (existingText.startsWith(text)) return merged;
    break;
  }

  return [...merged, part];
}

function mergeStreamPartsForStep(existing: UIMessage["parts"], incoming: UIMessage["parts"]): UIMessage["parts"] {
  let merged = [...existing];
  if (incoming.some(isDataAgentPart) && merged.some((part) => part.type === "text" || isReasoningUIPart(part))) {
    merged = merged.filter((part) => isDataAgentPart(part) || isToolUIPart(part));
  }

  for (const part of incoming) {
    if (isDataAgentPart(part)) {
      if (!merged.some(isDataAgentPart)) merged.push(part);
      continue;
    }
    if (isToolUIPart(part)) {
      merged = mergeToolPartIntoParts(merged, part);
      continue;
    }
    if (isReasoningUIPart(part)) {
      merged = mergeReasoningPart(merged, part);
      continue;
    }
    if (part.type === "text") {
      merged = mergeTextPart(merged, part);
      continue;
    }
    merged.push(part);
  }

  return merged;
}

/** Group streamed assistant message parts by step index, merging across message flushes. */
export function extractStreamPartsByStepIndex(messages: UIMessage[]): Map<number, UIMessage["parts"]> {
  const byStep = new Map<number, UIMessage["parts"]>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    let currentStepIndex: number | null = null;
    let currentParts: UIMessage["parts"] = [];

    const flush = () => {
      if (currentStepIndex === null || currentParts.length === 0) return;
      const existing = byStep.get(currentStepIndex) ?? [];
      byStep.set(currentStepIndex, mergeStreamPartsForStep(existing, currentParts));
      currentParts = [];
    };

    for (const part of message.parts) {
      if (isDataAgentPart(part) && typeof part.data.stepIndex === "number") {
        flush();
        currentStepIndex = part.data.stepIndex;
        currentParts = [part];
      } else if (currentStepIndex !== null) {
        currentParts.push(part);
      }
    }
    flush();
  }

  return byStep;
}

export function readAgentStepIndex(message: UIMessage): number | null {
  if (message.role !== "assistant") return null;
  for (const part of message.parts) {
    if (isDataAgentPart(part) && typeof part.data.stepIndex === "number") {
      return part.data.stepIndex;
    }
  }
  return null;
}

export function isAgentTurnMessage(message: UIMessage): boolean {
  return readAgentStepIndex(message) !== null;
}

/** One assistant block per agent step, merged from streamed chat messages only. */
export function normalizeTranscriptMessages(messages: UIMessage[]): UIMessage[] {
  const visible = messages.filter((message) => !isHiddenControlMessage(message));
  const streamByStep = extractStreamPartsByStepIndex(visible);
  const seenSteps = new Set<number>();
  const normalized: UIMessage[] = [];

  for (const message of visible) {
    if (message.role !== "assistant") {
      normalized.push(message);
      continue;
    }

    const stepIndex = readAgentStepIndex(message);
    if (stepIndex === null) {
      normalized.push(message);
      continue;
    }

    if (seenSteps.has(stepIndex)) continue;
    seenSteps.add(stepIndex);

    const parts = streamByStep.get(stepIndex);
    if (!parts || parts.length === 0) continue;

    normalized.push({
      ...message,
      id: message.id || `agent-turn-${stepIndex}`,
      role: "assistant",
      parts,
    });
  }

  return normalized;
}

function resolveAgentPhaseFromStep(step: SpecRunStep | undefined): DataAgentPartData["phase"] {
  if (!step) return "working";
  if (step.status === "running") return "working";
  if (step.status === "failed" || step.status === "cancelled") return "failed";
  if (step.status === "queued") return "queued";
  return "finished";
}

function patchAgentPhaseFromStep(
  parts: UIMessage["parts"],
  step: SpecRunStep | undefined,
): UIMessage["parts"] {
  const phase = resolveAgentPhaseFromStep(step);
  return parts.map((part) => {
    if (!isDataAgentPart(part)) return part;
    return {
      ...part,
      data: {
        ...part.data,
        phase,
        agentName: part.data.agentName ?? step?.agent_snapshot.name,
        task: part.data.task ?? step?.agent_snapshot.task,
        persona: part.data.persona ?? step?.agent_snapshot.persona,
      },
    };
  });
}

function syntheticAgentMessageForStep(step: SpecRunStep, totalAgents: number): UIMessage {
  return {
    id: `synthetic-agent-turn:${step.id}`,
    role: "assistant",
    parts: [{
      type: "data-agent",
      data: {
        agentId: step.agent_id,
        agentName: step.agent_snapshot.name ?? step.agent_id,
        stepIndex: step.step_index,
        totalAgents,
        task: step.agent_snapshot.task,
        persona: step.agent_snapshot.persona,
        phase: resolveAgentPhaseFromStep(step),
      },
    } as UIMessage["parts"][number]],
  };
}

export function hydrateMessagesFromSteps(
  messages: UIMessage[],
  steps: SpecRunStep[] = [],
  _interactions: SpecRunInteraction[] = [],
): UIMessage[] {
  const normalized = normalizeTranscriptMessages(messages);
  const stepByIndex = new Map(steps.map((step) => [step.step_index, step]));
  const totalAgents = steps.length > 0 ? Math.max(...steps.map((step) => step.step_index)) + 1 : 0;
  const patched = normalized.map((message) => {
    const stepIndex = readAgentStepIndex(message);
    if (stepIndex === null) return message;
    const step = stepByIndex.get(stepIndex);
    return {
      ...message,
      parts: patchAgentPhaseFromStep(message.parts, step),
    };
  });

  if (steps.length === 0) return patched;

  const latestSteps = [...stepByIndex.values()].sort((left, right) => left.step_index - right.step_index);
  const existingSteps = new Set(
    patched
      .map(readAgentStepIndex)
      .filter((stepIndex): stepIndex is number => stepIndex !== null),
  );
  let nextStepOffset = 0;
  const hydrated: UIMessage[] = [];

  const appendMissingBefore = (stepIndex: number) => {
    while (nextStepOffset < latestSteps.length) {
      const step = latestSteps[nextStepOffset]!;
      if (step.step_index >= stepIndex) return;
      if (!existingSteps.has(step.step_index)) {
        hydrated.push(syntheticAgentMessageForStep(step, totalAgents));
        existingSteps.add(step.step_index);
      }
      nextStepOffset += 1;
    }
  };

  for (const message of patched) {
    const stepIndex = readAgentStepIndex(message);
    if (stepIndex !== null) {
      appendMissingBefore(stepIndex);
      while (nextStepOffset < latestSteps.length && latestSteps[nextStepOffset]!.step_index <= stepIndex) {
        nextStepOffset += 1;
      }
    }
    hydrated.push(message);
  }
  appendMissingBefore(Number.POSITIVE_INFINITY);
  return hydrated;
}

export function isGateCompletionMessage(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if (!isToolUIPart(part)) return false;
    // Include both successful (output-available) and failed (input-available with error text)
    // completions so validation errors don't silently vanish from the transcript.
    const state = part.state;
    if (state !== "output-available" && state !== "input-available") return false;
    return GATE_TOOL_NAMES.has(getToolName(part));
  });
}

export function shouldAutoStartRunStream(input: {
  runStatus: string;
  messages: UIMessage[];
  pendingInteraction: boolean;
  chatStatus: string;
}): boolean {
  if (input.pendingInteraction) return false;
  if (input.chatStatus === "streaming" || input.chatStatus === "submitted") return false;
  if (input.runStatus !== "queued" && input.runStatus !== "running") return false;
  return !hasSubstantiveAssistantMessages(input.messages);
}
