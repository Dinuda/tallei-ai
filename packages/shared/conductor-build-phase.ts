export const BUILD_PHASES = [
  "intent",
  "blueprint",
  "connectors",
  "bindings",
  "review",
  "compile",
  "test",
  "activation",
] as const;

export type ConductorBuildPhase = (typeof BUILD_PHASES)[number];
