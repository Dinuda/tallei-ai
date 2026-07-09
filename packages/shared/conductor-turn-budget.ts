export type ConductorBuildPhase =
  | "intent"
  | "blueprint"
  | "connectors"
  | "bindings"
  | "review"
  | "compile"
  | "test"
  | "activation";

export const CONDUCTOR_PHASE_STEP_LIMITS: Record<ConductorBuildPhase, number> = {
  intent: 6,
  blueprint: 4,
  connectors: 8,
  bindings: 12,
  review: 6,
  compile: 8,
  test: 6,
  activation: 6,
};

export function conductorStepLimitForPhase(phase: ConductorBuildPhase): number {
  return CONDUCTOR_PHASE_STEP_LIMITS[phase] ?? CONDUCTOR_PHASE_STEP_LIMITS.blueprint;
}

export function isActionableConductorPhase(phase: ConductorBuildPhase | null | undefined): boolean {
  return Boolean(phase && phase !== "blueprint");
}

export const CONDUCTOR_CONTINUE_SUGGESTIONS = [
  { id: "continue", label: "Continue", message: "Continue" },
  { id: "okay", label: "Okay", message: "Okay" },
] as const;

export const CONDUCTOR_STALL_QUESTION = "I paused mid-setup. Continue when you're ready.";

export const CONDUCTOR_BUDGET_EXHAUSTED_QUESTION =
  "I used the full step budget for this setup phase. Continue when you're ready and I'll pick up from the event log.";

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

export type ConductorStallInput = {
  chatBusy: boolean;
  hasMessages: boolean;
  actionablePhase: boolean;
  hasUnansweredUiTools: boolean;
  buildIncomplete: boolean;
  lastRoleIsAssistant: boolean;
  hasTerminalExecution: boolean;
  textOnlyEnding: boolean;
  hasExecutions: boolean;
  wouldAutoContinue: boolean;
  hasAssistantParts: boolean;
  phaseHandoffPending?: boolean;
  reviewConfirmationHandoffPending?: boolean;
  answeredUiToolAwaitingContinue?: boolean;
  budgetExhausted?: boolean;
};

export function evaluateConductorStall(input: ConductorStallInput): ConductorStallResult {
  if (input.chatBusy) return { stalled: false };
  if (!input.hasMessages) return { stalled: false };
  if (!input.actionablePhase) return { stalled: false };
  if (!input.buildIncomplete) return { stalled: false };
  if (!input.lastRoleIsAssistant) return { stalled: false };
  if (input.hasUnansweredUiTools) return { stalled: false };
  if (input.hasTerminalExecution) return { stalled: false };
  if (input.wouldAutoContinue) return { stalled: false };
  if (input.phaseHandoffPending) return { stalled: false };
  if (input.reviewConfirmationHandoffPending) return { stalled: false };
  if (input.answeredUiToolAwaitingContinue) return { stalled: false };
  if (input.budgetExhausted) return { stalled: false };
  if (!input.hasAssistantParts) return { stalled: false };

  if (input.textOnlyEnding && !input.hasExecutions) {
    return { stalled: true, reason: "text_only_mid_phase" };
  }

  return { stalled: false };
}
