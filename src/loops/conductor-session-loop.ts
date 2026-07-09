import type { UIMessage } from "ai";

import type { ConductorContinuationIntent } from "./conductor-continuation-intent.js";
import type { ConductorPhaseTurnPayload } from "./build-events.js";

/** Hard cap on in-request auto-continuations (phase handoffs + ui_tool_answered). */
export const CONDUCTOR_SESSION_MAX_AUTO_CONTINUATIONS = 16;

/** Reasons that must not auto-continue (mirror former client blocked set). */
export const CONDUCTOR_SESSION_BLOCKED_CONTINUE_REASONS = new Set([
  "required_tool_not_called",
  "repeated_no_progress",
  "no_actionable_next_tool",
]);

export type ConductorSessionStopReason =
  | "wait_for_user"
  | "wait"
  | "blocked"
  | "budget_exhausted"
  | "build_terminal"
  | "max_continuations"
  | "aborted"
  | "idle";

/**
 * Apply a UI-tool answer onto the transcript and truncate after the tool message.
 */
export function applyUiToolAnswerToMessages(
  messages: UIMessage[],
  toolCallId: string,
  output: unknown,
): UIMessage[] {
  const withOutput = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = (message.parts ?? []).map((part) => {
      const toolPart = part as { toolCallId?: string };
      if (toolPart.toolCallId !== toolCallId) return part;
      changed = true;
      return {
        ...part,
        state: "output-available",
        output,
      } as UIMessage["parts"][number];
    });
    return changed ? { ...message, parts } : message;
  });

  const toolMessageIndex = withOutput.findIndex((message) =>
    message.role === "assistant"
    && (message.parts ?? []).some((part) => (part as { toolCallId?: string }).toolCallId === toolCallId),
  );
  if (toolMessageIndex < 0) return withOutput;
  return withOutput.slice(0, toolMessageIndex + 1);
}

export function shouldAutoContinueConductorSession(
  intent: ConductorContinuationIntent | null | undefined,
): boolean {
  if (!intent || intent.action !== "auto_continue") return false;
  if (intent.trigger !== "phase_handoff" && intent.trigger !== "ui_tool_answered") return false;
  if (CONDUCTOR_SESSION_BLOCKED_CONTINUE_REASONS.has(intent.reason)) return false;
  return true;
}

export function mapContinuationIntentToStopReason(
  intent: ConductorContinuationIntent | null | undefined,
): ConductorSessionStopReason {
  if (!intent) return "idle";
  if (intent.action === "wait_for_user") return "wait_for_user";
  if (intent.trigger === "budget_exhausted" || intent.reason === "budget_exhausted") {
    return "budget_exhausted";
  }
  if (intent.reason === "build_terminal") return "build_terminal";
  if (intent.action === "wait") {
    if (CONDUCTOR_SESSION_BLOCKED_CONTINUE_REASONS.has(intent.reason)) return "blocked";
    return "wait";
  }
  return "idle";
}

export type PhaseHandoffConsumePayload = {
  handoffId: string;
  phase: string;
  nextPhase: string;
  parentArtifactHash: string;
};

/** Build a phase_handoff.consumed payload from the latest phase turn + intent. */
export function phaseHandoffConsumePayloadFromTurn(
  intent: ConductorContinuationIntent,
  latestPhaseTurn: ConductorPhaseTurnPayload | null,
): PhaseHandoffConsumePayload | null {
  const handoffId = intent.handoffId ?? latestPhaseTurn?.handoffId;
  if (!handoffId || !latestPhaseTurn?.phase || !latestPhaseTurn.parentArtifactHash) {
    return null;
  }
  const nextPhase = latestPhaseTurn.nextPhase;
  if (!nextPhase) return null;
  return {
    handoffId,
    phase: latestPhaseTurn.phase,
    nextPhase,
    parentArtifactHash: latestPhaseTurn.parentArtifactHash,
  };
}

export function makePhaseHandoffConsumedEvent(payload: PhaseHandoffConsumePayload) {
  return {
    eventKey: `phase-handoff-consumed:${payload.handoffId}`,
    type: "phase_handoff.consumed" as const,
    payload: {
      handoffId: payload.handoffId,
      phase: payload.phase,
      nextPhase: payload.nextPhase,
      parentArtifactHash: payload.parentArtifactHash,
    },
  };
}
