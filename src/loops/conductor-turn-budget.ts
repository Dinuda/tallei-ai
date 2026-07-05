import type { BuildPhase } from "./build-state.js";

export {
  CONDUCTOR_BUDGET_EXHAUSTED_QUESTION,
  isBuildIncomplete,
  isRecoverableConductorExecution,
  type ConductorStallResult,
} from "../../shared/conductor-turn-budget.js";

export const CONDUCTOR_PHASE_STEP_LIMITS: Record<BuildPhase, number> = {
  intent: 6,
  blueprint: 4,
  connectors: 8,
  bindings: 12,
  review: 6,
  compile: 8,
  test: 6,
  activation: 6,
};

export function conductorStepLimitForPhase(phase: BuildPhase): number {
  return CONDUCTOR_PHASE_STEP_LIMITS[phase] ?? CONDUCTOR_PHASE_STEP_LIMITS.blueprint;
}

export function isActionableConductorPhase(phase: BuildPhase | null | undefined): boolean {
  return Boolean(phase && phase !== "blueprint");
}
