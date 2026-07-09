import { z } from "zod";

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

export const buildPhaseSchema = z.enum(BUILD_PHASES);

export type ConductorBuildPhase = z.infer<typeof buildPhaseSchema>;
