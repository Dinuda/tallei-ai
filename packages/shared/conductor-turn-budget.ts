import type { ConductorBuildPhase } from "./conductor-build-phase.js";

export type { ConductorBuildPhase } from "./conductor-build-phase.js";
export { BUILD_PHASES } from "./conductor-build-phase.js";

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

export const CONDUCTOR_BUDGET_EXHAUSTED_QUESTION =
  "I used the full step budget for this setup phase. Continue when you're ready and I'll pick up from the event log.";
