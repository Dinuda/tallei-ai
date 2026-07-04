export type ConductorBuildPhase =
  | "intent"
  | "blueprint"
  | "connectors"
  | "bindings"
  | "review"
  | "compile"
  | "test"
  | "activation";

export function conductorStepLimitForPhase(phase: ConductorBuildPhase): number {
  switch (phase) {
    case "intent":
      return 6;
    case "connectors":
      return 8;
    case "bindings":
      return 12;
    case "review":
      return 6;
    case "compile":
      return 8;
    case "test":
      return 6;
    case "activation":
      return 6;
    case "blueprint":
    default:
      return 4;
  }
}

export function isActionableConductorPhase(phase: ConductorBuildPhase | null | undefined): boolean {
  return Boolean(phase && phase !== "blueprint");
}

export const CONDUCTOR_CONTINUE_SUGGESTIONS = [
  { id: "continue", label: "Continue", message: "Continue" },
  { id: "okay", label: "Okay", message: "Okay" },
] as const;

export const CONDUCTOR_STALL_QUESTION = "I paused mid-setup. Continue when you're ready.";

export type ConductorStallResult =
  | { stalled: true; reason: string }
  | { stalled: false };

export function isBuildIncomplete(
  buildPhase: ConductorBuildPhase | null | undefined,
  missingSlots: string[],
  loopStatus?: string,
): boolean {
  if (loopStatus === "active") return false;
  if (missingSlots.length > 0) return true;
  if (!buildPhase) return true;
  return buildPhase !== "activation" || loopStatus !== "active";
}

export function isRecoverableConductorExecution(output: Record<string, unknown>): boolean {
  return output.ok === false
    && output.retryAllowed === true
    && typeof output.recoverToPhase === "string"
    && output.recoverToPhase.length > 0;
}

export function evaluateConductorStall(input: {
  chatBusy: boolean;
  hasMessages: boolean;
  actionablePhase: boolean;
  hasUnansweredUiTools: boolean;
  buildIncomplete: boolean;
  lastRoleIsAssistant: boolean;
  hasTerminalExecution: boolean;
  textOnlyEnding: boolean;
  wouldAutoContinue: boolean;
  hasExecutions: boolean;
  hasAssistantParts: boolean;
  reviewConfirmationHandoffPending?: boolean;
}): ConductorStallResult {
  if (input.chatBusy) return { stalled: false };
  if (!input.hasMessages) return { stalled: false };
  if (!input.actionablePhase) return { stalled: false };
  if (input.hasUnansweredUiTools) return { stalled: false };
  if (!input.buildIncomplete) return { stalled: false };
  if (!input.lastRoleIsAssistant) return { stalled: false };
  if (input.hasTerminalExecution) return { stalled: false };

  if (input.textOnlyEnding) {
    if (input.reviewConfirmationHandoffPending) return { stalled: false };
    return { stalled: true, reason: "text_only_mid_phase" };
  }

  if (input.hasExecutions) {
    if (input.wouldAutoContinue) return { stalled: false };
    return { stalled: true, reason: "non_terminal_without_continue" };
  }

  if (input.hasAssistantParts) {
    return { stalled: true, reason: "no_action_completed" };
  }

  return { stalled: false };
}
