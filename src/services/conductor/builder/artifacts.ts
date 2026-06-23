import type { WorkflowBuilderPhase } from "../contracts/builder-types.js";
import type { WorkflowBuilderSession } from "../services/session.service.js";
import {
  artifactKeyForPhase,
  downstreamArtifactKeys,
  phaseOrder,
  type BuilderArtifactKey,
} from "./phases/graph.js";
import type { BuilderAnalyzerPhase } from "./phases/types.js";

export type { BuilderArtifactKey } from "./phases/graph.js";

export type BuilderArtifactSnapshot = {
  intent: {
    resolvedIntent: string | null;
    discoveredToolCount: number;
  } | null;
  buildContract: {
    requirementCount: number;
    unresolvedCount: number;
  } | null;
  spec: {
    specId: string | null;
    hasProposal: boolean;
    workflowId: string | null;
  } | null;
  verification: {
    workflowId: string | null;
    sessionPhase: WorkflowBuilderPhase;
  } | null;
};

export type InvalidationPlan = {
  targetPhase: BuilderAnalyzerPhase;
  preserved: BuilderArtifactKey[];
  invalidated: BuilderArtifactKey[];
};

export type RegressionSessionPatch = {
  phase: WorkflowBuilderPhase;
  resolvedIntent?: null;
  discoveredToolContracts?: [];
  buildContract?: null;
  artifactBundleJson?: null;
  spec?: null;
  workflowId?: null;
  currentProposal?: null;
  error?: null;
};

function hasIntent(session: WorkflowBuilderSession): boolean {
  return session.resolvedIntent != null || session.discoveredToolContracts.length > 0;
}

function hasBuildContract(session: WorkflowBuilderSession): boolean {
  return session.buildContract != null;
}

function hasSpec(session: WorkflowBuilderSession): boolean {
  return session.specId != null || session.currentProposal != null;
}

function hasVerification(session: WorkflowBuilderSession): boolean {
  return session.workflowId != null || session.phase === "saved";
}

export function readArtifacts(session: WorkflowBuilderSession): BuilderArtifactSnapshot {
  const unresolvedCount = session.buildContract
    ? session.buildContract.requirements.filter((entry: { required?: boolean; status?: string }) => entry.required && entry.status !== "resolved").length
    : 0;

  return {
    intent: hasIntent(session)
      ? {
          resolvedIntent: session.resolvedIntent?.resolvedIntent ?? null,
          discoveredToolCount: session.discoveredToolContracts.length,
        }
      : null,
    buildContract: hasBuildContract(session)
      ? {
          requirementCount: session.buildContract!.requirements.length,
          unresolvedCount,
        }
      : null,
    spec: hasSpec(session) || session.workflowId
      ? {
          specId: session.specId,
          hasProposal: session.currentProposal != null,
          workflowId: session.workflowId,
        }
      : null,
    verification: hasVerification(session)
      ? {
          workflowId: session.workflowId,
          sessionPhase: session.phase,
        }
      : null,
  };
}

export function invalidationPlan(targetPhase: BuilderAnalyzerPhase): InvalidationPlan {
  const order = phaseOrder();
  const targetIndex = order.indexOf(targetPhase);
  const preserved = order.slice(0, targetIndex).map((phase) => artifactKeyForPhase(phase));
  const invalidated = order.slice(targetIndex).map((phase) => artifactKeyForPhase(phase));
  return {
    targetPhase,
    preserved,
    invalidated,
  };
}

export function requiresRegressionConfirmation(plan: InvalidationPlan): boolean {
  return plan.invalidated.includes("intent") || plan.invalidated.includes("spec");
}

export function workflowPhaseForAnalyzerPhase(
  targetPhase: BuilderAnalyzerPhase,
  session: WorkflowBuilderSession,
): WorkflowBuilderPhase {
  switch (targetPhase) {
    case "discovery":
      return session.resolvedIntent ? "analyzing" : "new";
    case "requirements":
      return "resolving_requirements";
    case "compile":
      return session.phase === "saved" ? "intent_resolved" : "intent_resolved";
    case "verification":
      return session.workflowId ? "saved" : "intent_resolved";
  }
}

export function buildRegressionPatch(
  session: WorkflowBuilderSession,
  targetPhase: BuilderAnalyzerPhase,
): RegressionSessionPatch {
  const plan = invalidationPlan(targetPhase);
  const patch: RegressionSessionPatch = {
    phase: workflowPhaseForAnalyzerPhase(targetPhase, session),
    error: null,
  };

  if (plan.invalidated.includes("intent")) {
    patch.resolvedIntent = null;
    patch.discoveredToolContracts = [];
  }
  if (plan.invalidated.includes("buildContract")) {
    patch.buildContract = null;
    patch.artifactBundleJson = null;
  }
  if (plan.invalidated.includes("spec")) {
    patch.currentProposal = null;
    patch.spec = null;
    if (session.workflowId) patch.workflowId = null;
  }
  if (plan.invalidated.includes("verification") && session.phase === "saved") {
    patch.phase = workflowPhaseForAnalyzerPhase("compile", session);
    if (session.workflowId) patch.workflowId = null;
  }

  return patch;
}

export function revisedArtifactForPhase(targetPhase: BuilderAnalyzerPhase): BuilderArtifactKey {
  return artifactKeyForPhase(targetPhase);
}
