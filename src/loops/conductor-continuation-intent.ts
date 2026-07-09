import type { ConductorPhaseTurnPayload, LoopBuildEvent, PendingUiToolCall } from "./build-events.js";
import { completedToolEvents } from "./build-event-interpreter.js";
import type { BuildPhaseProgress } from "./build-phase-progress.js";

export type ConductorContinuationTrigger =
  | "ui_tool_answered"
  | "phase_handoff"
  | "budget_exhausted"
  | null;

export type ConductorContinuationIntent = {
  action: "wait" | "auto_continue" | "wait_for_user";
  reason: string;
  handoffId?: string;
  trigger: ConductorContinuationTrigger;
};

const UI_ONLY_TOOLS = new Set([
  "askQuestion",
  "pickConnectorApp",
  "presentReplyOptions",
  "confirmOutcomeBrief",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isServerTool(toolName: string): boolean {
  return toolName.length > 0 && !UI_ONLY_TOOLS.has(toolName);
}

function hasSuccessfulToolCompletion(events: LoopBuildEvent[], toolName: string): boolean {
  return completedToolEvents(events, toolName).some((event) => {
    if (!isRecord(event.output)) return false;
    return event.output.ok !== false;
  });
}

function hasCompletedUiToolOutput(events: LoopBuildEvent[]): boolean {
  return completedToolEvents(events).some((event) => {
    if (!UI_ONLY_TOOLS.has(event.toolName)) return false;
    return event.output != null;
  });
}

function pendingPhaseHandoff(
  latestPhaseTurn: ConductorPhaseTurnPayload | null,
  consumedHandoffIds: string[],
): { handoffId: string; nextPhase?: string } | null {
  if (!latestPhaseTurn?.handoffId) return null;

  if (latestPhaseTurn.outcome === "blocked"
    || latestPhaseTurn.outcome === "budget_exhausted"
    || latestPhaseTurn.outcome === "waiting_for_user") {
    return null;
  }

  const continuation = latestPhaseTurn.continuation;
  if (continuation === "next_phase") {
    if (latestPhaseTurn.outcome !== "phase_complete") return null;
  } else if (continuation === "continue_phase") {
    if (latestPhaseTurn.outcome !== "progress" || (latestPhaseTurn.stepsUsed ?? 0) === 0) {
      return null;
    }
  } else {
    return null;
  }

  if (consumedHandoffIds.includes(latestPhaseTurn.handoffId)) return null;
  return {
    handoffId: latestPhaseTurn.handoffId,
    ...(latestPhaseTurn.nextPhase ? { nextPhase: latestPhaseTurn.nextPhase } : {}),
  };
}

/** Authoritative client continuation signal projected from the build event log. */
export function projectConductorClientAction(input: {
  loopStatus: string;
  phaseProgress: BuildPhaseProgress | null;
  latestPhaseTurn: ConductorPhaseTurnPayload | null;
  pendingUiTool: PendingUiToolCall | null;
  consumedHandoffIds: string[];
  events: LoopBuildEvent[];
}): ConductorContinuationIntent {
  const { loopStatus, phaseProgress, latestPhaseTurn, pendingUiTool, consumedHandoffIds, events } = input;

  if (!phaseProgress) {
    return { action: "wait", reason: "no_phase_progress", trigger: null };
  }

  if (latestPhaseTurn?.outcome === "budget_exhausted") {
    return { action: "wait", reason: "budget_exhausted", trigger: "budget_exhausted" };
  }

  if (latestPhaseTurn?.outcome === "blocked") {
    return {
      action: "wait",
      reason: latestPhaseTurn.resolutionReason ?? "required_tool_not_called",
      trigger: null,
    };
  }

  if (loopStatus === "active" || phaseProgress.terminal) {
    return { action: "wait", reason: "build_terminal", trigger: null };
  }

  if (pendingUiTool) {
    return { action: "wait_for_user", reason: "pending_user_input", trigger: null };
  }

  const handoff = pendingPhaseHandoff(latestPhaseTurn, consumedHandoffIds);
  if (handoff) {
    return {
      action: "auto_continue",
      reason: latestPhaseTurn?.resolutionReason ?? "phase_handoff_pending",
      handoffId: handoff.handoffId,
      trigger: "phase_handoff",
    };
  }

  if (phaseProgress.handoffPending) {
    return {
      action: "auto_continue",
      reason: phaseProgress.reason ?? "handoff_pending",
      trigger: "phase_handoff",
    };
  }

  const nextTool = phaseProgress.nextTool;
  if (nextTool && isServerTool(nextTool) && !hasSuccessfulToolCompletion(events, nextTool)) {
    if (hasCompletedUiToolOutput(events)) {
      return {
        action: "auto_continue",
        reason: phaseProgress.reason ?? "ui_tool_answered",
        trigger: "ui_tool_answered",
      };
    }
  }

  return { action: "wait", reason: "idle", trigger: null };
}
