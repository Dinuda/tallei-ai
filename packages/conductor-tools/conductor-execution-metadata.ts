import { z } from "zod";

import { BUILD_PHASES, buildPhaseSchema } from "./conductor-build-phase.js";

export const conductorExecutionMetadataSchema = z.object({
  ok: z.boolean(),
  operationKey: z.string().min(1),
  phaseBefore: buildPhaseSchema,
  phaseAfter: buildPhaseSchema,
  phaseCompleted: z.boolean(),
  requiresUserInput: z.boolean(),
  retryAllowed: z.boolean(),
  parentArtifactHash: z.string().min(1),
  invalidatedPhases: z.array(buildPhaseSchema),
  error: z.string().min(1).optional(),
  recoverToPhase: buildPhaseSchema.optional(),
  recoverReason: z.string().min(1).optional(),
  recoveryPhase: buildPhaseSchema.optional(),
  recoveryReason: z.string().min(1).optional(),
  resumeTool: z.string().min(1).optional(),
  nextPhase: buildPhaseSchema.optional(),
  handoffId: z.string().min(1).optional(),
  compiledPlanId: z.string().uuid().optional(),
  noProgressFingerprint: z.string().min(1).optional(),
  turnOutcome: z.enum([
    "progress",
    "phase_complete",
    "waiting_for_user",
    "blocked",
    "budget_exhausted",
    "build_complete",
  ]),
  continuation: z.enum([
    "continue_phase",
    "next_phase",
    "wait_for_user",
    "stop",
  ]),
  stepsUsed: z.number().int().min(0),
  stepLimit: z.number().int().min(1),
});

export type ConductorExecutionMetadata = z.infer<typeof conductorExecutionMetadataSchema>;

export type PhaseExecutionContract = Readonly<{
  phase: z.infer<typeof buildPhaseSchema>;
  parentArtifactHash: string;
  allowedTools: readonly string[];
  nextTool: string | null;
  compiledPlanId: string | null;
  revision: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readConductorExecutionMetadata(value: unknown): ConductorExecutionMetadata | null {
  if (!isRecord(value)) return null;
  const candidate = {
    ok: value.ok,
    operationKey: value.operationKey,
    phaseBefore: value.phaseBefore,
    phaseAfter: value.phaseAfter,
    phaseCompleted: value.phaseCompleted,
    requiresUserInput: value.requiresUserInput,
    retryAllowed: value.retryAllowed,
    parentArtifactHash: value.parentArtifactHash,
    invalidatedPhases: value.invalidatedPhases,
    error: value.error,
    recoverToPhase: value.recoverToPhase,
    recoverReason: value.recoverReason,
    recoveryPhase: value.recoveryPhase,
    recoveryReason: value.recoveryReason,
    resumeTool: value.resumeTool,
    nextPhase: value.nextPhase,
    handoffId: value.handoffId,
    compiledPlanId: value.compiledPlanId,
    noProgressFingerprint: value.noProgressFingerprint,
    turnOutcome: value.turnOutcome,
    continuation: value.continuation,
    stepsUsed: value.stepsUsed,
    stepLimit: value.stepLimit,
  };
  const parsed = conductorExecutionMetadataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Prerequisite miss that redirects Conductor to an earlier phase in the same turn. */
export function isRecoverableConductorExecution(metadata: ConductorExecutionMetadata): boolean {
  return metadata.ok === false
    && metadata.retryAllowed === true
    && Boolean(metadata.recoverToPhase);
}

export function isConductorBuildPhase(value: unknown): value is z.infer<typeof buildPhaseSchema> {
  return typeof value === "string" && (BUILD_PHASES as readonly string[]).includes(value);
}
