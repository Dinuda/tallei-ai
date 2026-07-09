import type { ConductorBuildPhase } from "./conductor-build-phase.js";

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
