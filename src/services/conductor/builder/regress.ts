import { randomUUID } from "crypto";

import type { AuthContext } from "../../../domain/auth/index.js";
import { clearCachedRuntimeSnapshot } from "../commands/snapshot-cache.js";
import type { PhaseTransitionEvent } from "../contracts/phase-history.js";
import {
  appendWorkflowBuilderPhaseHistory,
  requireWorkflowBuilderSession,
  updateWorkflowBuilderSession,
  type WorkflowBuilderSession,
} from "../services/session.service.js";
import {
  buildRegressionPatch,
  invalidationPlan,
  revisedArtifactForPhase,
  type InvalidationPlan,
} from "./artifacts.js";
import { resolveAnalyzerPhase } from "./phases/handoff.js";
import type { BuilderAnalyzerPhase } from "./phases/types.js";

export type RegressToPhaseInput = {
  targetPhase: BuilderAnalyzerPhase;
  reason: PhaseTransitionEvent["reason"];
  userMessageId?: string;
  revisedArtifact?: PhaseTransitionEvent["revisedArtifact"];
};

export type RegressToPhaseResult = {
  session: WorkflowBuilderSession;
  event: PhaseTransitionEvent;
  plan: InvalidationPlan;
};

export async function regressToPhase(
  auth: AuthContext,
  sessionId: string,
  input: RegressToPhaseInput,
): Promise<RegressToPhaseResult> {
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  const fromPhase = resolveAnalyzerPhase(session);
  const plan = invalidationPlan(input.targetPhase);
  const patch = buildRegressionPatch(session, input.targetPhase);

  const updated = await updateWorkflowBuilderSession(auth, sessionId, {
    phase: patch.phase,
    error: patch.error ?? null,
    ...("resolvedIntent" in patch ? { resolvedIntent: patch.resolvedIntent ?? null } : {}),
    ...("discoveredToolContracts" in patch ? { discoveredToolContracts: patch.discoveredToolContracts ?? [] } : {}),
    ...("buildContract" in patch ? { buildContract: patch.buildContract ?? null } : {}),
    ...("artifactBundleJson" in patch ? { artifactBundleJson: patch.artifactBundleJson ?? null } : {}),
    ...("currentProposal" in patch ? { currentProposal: patch.currentProposal ?? null } : {}),
    ...("workflowId" in patch ? { workflowId: patch.workflowId ?? null } : {}),
    ...(plan.invalidated.includes("spec") ? { spec: null } : {}),
  });

  clearCachedRuntimeSnapshot(sessionId);

  const event: PhaseTransitionEvent = {
    id: randomUUID(),
    at: new Date().toISOString(),
    from: fromPhase,
    to: input.targetPhase,
    reason: input.reason,
    revisedArtifact: input.revisedArtifact ?? revisedArtifactForPhase(input.targetPhase),
    invalidated: plan.invalidated,
    preserved: plan.preserved,
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
  };
  await appendWorkflowBuilderPhaseHistory(auth, sessionId, [event]);

  const refreshed = await requireWorkflowBuilderSession(auth, sessionId);
  return { session: refreshed, event, plan };
}
