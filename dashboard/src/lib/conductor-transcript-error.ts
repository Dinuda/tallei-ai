import type { UIMessage } from "ai";

import type { ConductorContinuationIntent } from "@/lib/conductor-continuation-intent";
import type { PhaseHandoffProgress } from "@tallei/shared/conductor-phase-handoff";

type ConductorChatStatus = "ready" | "streaming" | "submitted" | "error";

function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

export type ConductorTranscriptError = {
  title: string;
  message: string;
  detail?: string;
  retryable: boolean;
};

export type ConductorPhaseTurnSummary = {
  outcome?: string;
  resolutionReason?: string;
  continuation?: string;
  stepsUsed?: number;
};

export function isReasoningOnlyAssistantMessage(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  const parts = message.parts ?? [];
  if (parts.length === 0) return false;

  const hasReasoning = parts.some((part) => part.type === "reasoning");
  const hasText = parts.some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
  );
  const hasTool = parts.some((part) => isToolPart(part.type));
  return hasReasoning && !hasText && !hasTool;
}

function formatExpectedTool(nextTool: string): string {
  return nextTool.replace(/([A-Z])/g, " $1").trim();
}

function formatPhaseLabel(phase?: string | null): string {
  if (!phase) return "this setup step";
  return phase.replace(/_/g, " ");
}

export function deriveConductorTranscriptError(input: {
  messages: UIMessage[];
  chatStatus: ConductorChatStatus;
  streamError?: string | null;
  phaseProgress?: PhaseHandoffProgress | null;
  loopStatus?: string;
  latestPhaseTurn?: ConductorPhaseTurnSummary | null;
  continuationIntent?: ConductorContinuationIntent;
  hasPendingQuestion?: boolean;
}): ConductorTranscriptError | null {
  if (input.streamError?.trim()) {
    return {
      title: "Conductor could not finish",
      message: input.streamError.trim(),
      retryable: true,
    };
  }

  if (input.chatStatus === "error") {
    return {
      title: "Response interrupted",
      message: "The stream ended before Conductor could finish. Your message was saved — try again.",
      retryable: true,
    };
  }

  if (input.chatStatus !== "ready" || input.hasPendingQuestion) return null;
  if (input.loopStatus === "active" || input.phaseProgress?.terminal) return null;

  const nextTool = input.phaseProgress?.nextTool;
  if (!nextTool) return null;

  const last = input.messages.at(-1);
  if (!last || last.role !== "assistant") return null;

  const reasoningOnly = isReasoningOnlyAssistantMessage(last);
  const blocked = input.latestPhaseTurn?.outcome === "blocked";
  const noToolSteps = input.latestPhaseTurn?.stepsUsed === 0;

  if (!reasoningOnly && !blocked) return null;

  const resolutionReason = input.latestPhaseTurn?.resolutionReason
    ?? input.continuationIntent?.reason;
  const toolLabel = formatExpectedTool(nextTool);
  const phaseLabel = formatPhaseLabel(input.phaseProgress?.phase);

  if (blocked && resolutionReason === "repeated_no_progress") {
    return {
      title: "Conductor stopped — no progress",
      message: `During the ${phaseLabel} step, the model thought again without calling ${toolLabel}. Send Continue or Retry when you're ready.`,
      detail: resolutionReason,
      retryable: true,
    };
  }

  if (blocked && resolutionReason === "required_tool_not_called") {
    return {
      title: "Required tool was not called",
      message: `During the ${phaseLabel} step, the model finished thinking but did not call ${toolLabel}. Send Continue or use Retry to try again.`,
      detail: resolutionReason,
      retryable: true,
    };
  }

  if (blocked) {
    return {
      title: "Conductor stopped — required tool missing",
      message: `During the ${phaseLabel} step, the model did not call ${toolLabel}. Send Continue or use Retry to try again.`,
      detail: resolutionReason,
      retryable: true,
    };
  }

  if (reasoningOnly || noToolSteps) {
    return {
      title: "Required tool was not called",
      message: `During the ${phaseLabel} step, the model thought about your request but did not call ${toolLabel}. Send Continue or use Retry to try again.`,
      detail: resolutionReason ?? (noToolSteps ? "no_tool_calls" : "reasoning_only"),
      retryable: true,
    };
  }

  return null;
}
