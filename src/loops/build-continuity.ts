import { compileArtifactSchema, type LoopBuildState } from "./build-state.js";

export type CompiledPlanIdentity = {
  id: string;
  contentHash: string;
};

export type BuildContinuityRecovery = {
  phase: "compile";
  reason: string;
  parentArtifactHash: string;
};

export function isCompiledPlanCurrent(
  state: LoopBuildState | null | undefined,
  plan: CompiledPlanIdentity | null | undefined,
): boolean {
  const compileEnvelope = state?.artifacts.compile;
  const reviewHash = state?.artifacts.review?.artifactHash;
  if (!compileEnvelope || !reviewHash || !plan) return false;
  const parsed = compileArtifactSchema.safeParse(compileEnvelope.artifact);
  return Boolean(parsed.success
    && parsed.data.compiledPlanId === plan.id
    && parsed.data.compiledPlanHash === plan.contentHash
    && parsed.data.reviewHash === reviewHash
    && compileEnvelope.parentHash === reviewHash);
}

export function determineBuildContinuityRecovery(
  state: LoopBuildState,
  compiledPlan: CompiledPlanIdentity | null,
): BuildContinuityRecovery | null {
  if (state.buildPhase !== "test" && state.buildPhase !== "activation") return null;
  const reviewHash = state.artifacts.review?.artifactHash ?? "root";
  const compileEnvelope = state.artifacts.compile;
  if (!compileEnvelope) {
    return { phase: "compile", reason: "compiled_artifact_missing", parentArtifactHash: reviewHash };
  }
  const compiled = compileArtifactSchema.parse(compileEnvelope.artifact);
  if (compileEnvelope.parentHash !== reviewHash || compiled.reviewHash !== reviewHash) {
    return { phase: "compile", reason: "compiled_artifact_stale", parentArtifactHash: reviewHash };
  }
  if (!compiledPlan || compiledPlan.id !== compiled.compiledPlanId) {
    return { phase: "compile", reason: "compiled_plan_missing", parentArtifactHash: reviewHash };
  }
  if (compiledPlan.contentHash !== compiled.compiledPlanHash) {
    return { phase: "compile", reason: "compiled_plan_hash_mismatch", parentArtifactHash: reviewHash };
  }
  return null;
}
