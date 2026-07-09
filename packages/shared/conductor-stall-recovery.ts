import type { ConductorBuildPhase } from "./conductor-turn-budget.js";

export type StallRecoveryPhaseProgress = {
  phase?: ConductorBuildPhase | string;
  reason?: string;
  status?: "pending" | "in_progress" | "complete" | "waiting" | string;
  terminal?: boolean;
};

/** Event-log projection says the bounded phase has finished. */
export function isPhaseProgressTerminal(
  phaseProgress?: StallRecoveryPhaseProgress | null,
): boolean {
  if (!phaseProgress) return false;
  if (phaseProgress.terminal === true) return true;
  return phaseProgress.status === "complete";
}

/** Build is done — stall recovery must not be offered. */
export function isBuildTerminalForStall(input: {
  loopStatus?: string;
  phaseProgress?: StallRecoveryPhaseProgress | null;
}): boolean {
  if (input.loopStatus === "active") return true;
  if (phaseProgressReasonIsActivationComplete(input.phaseProgress)) return true;
  if (input.phaseProgress?.reason === "activation_phase_inactive") return true;
  return isPhaseProgressTerminal(input.phaseProgress);
}

function phaseProgressReasonIsActivationComplete(
  phaseProgress?: StallRecoveryPhaseProgress | null,
): boolean {
  return phaseProgress?.reason === "activation_complete";
}

/**
 * Whether the current phase is open for stall recovery.
 * - false: terminal / complete (no recovery)
 * - true: phase in flight (recovery allowed when turn stalled)
 * - null: unknown (hydration gap — caller uses narrow loopStatus fallback)
 */
export function isPhaseOpenForStallRecovery(
  phaseProgress?: StallRecoveryPhaseProgress | null,
): boolean | null {
  if (!phaseProgress) return null;
  if (isPhaseProgressTerminal(phaseProgress)) return false;
  if (phaseProgress.terminal === false) return true;
  if (phaseProgress.status === "in_progress" || phaseProgress.status === "pending") {
    return true;
  }
  return null;
}
