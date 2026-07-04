import type { BuildPhase } from "./build-state.js";

export function conductorStepLimitForPhase(phase: BuildPhase): number {
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

export function isActionableConductorPhase(phase: BuildPhase | null | undefined): boolean {
  return Boolean(phase && phase !== "blueprint");
}
