import { unresolvedBuildRequirements } from "../../domain/build-contract.js";
import type { WorkflowBuilderSession } from "../../services/session.service.js";
import { canAdvancePhase } from "./graph.js";
import type { BuilderAnalyzerPhase, BuilderPhaseHandoff } from "./types.js";

const AGENT_LABELS: Record<BuilderAnalyzerPhase, string> = {
  discovery: "Intent Analyst",
  requirements: "Setup Coordinator",
  compile: "Flow Architect",
  verification: "Launch Specialist",
};

export function agentLabelForPhase(phase: BuilderAnalyzerPhase): string {
  return AGENT_LABELS[phase];
}

export function createHandoffLedger(): BuilderPhaseHandoff {
  return { steps: [] };
}

export function recordHandoffStep(
  handoff: BuilderPhaseHandoff,
  phase: BuilderAnalyzerPhase,
  session: WorkflowBuilderSession,
): void {
  const summary = summarizePhase(session, phase);
  const existing = handoff.steps.findIndex((step) => step.phase === phase);
  const entry = { phase, agentLabel: agentLabelForPhase(phase), summary };
  if (existing >= 0) handoff.steps[existing] = entry;
  else handoff.steps.push(entry);
}

function summarizePhase(session: WorkflowBuilderSession, phase: BuilderAnalyzerPhase): Record<string, unknown> {
  switch (phase) {
    case "discovery":
      return {
        resolvedIntent: session.resolvedIntent?.resolvedIntent ?? null,
        discoveredToolCount: session.discoveredToolContracts.length,
      };
    case "requirements":
      if (!session.buildContract) return { unresolvedRequirements: [], readyForCompile: false };
      return {
        unresolvedRequirements: unresolvedBuildRequirements(session.buildContract).map((req) => ({
          id: req.id,
          kind: req.kind,
          question: req.question,
        })),
        readyForCompile: unresolvedBuildRequirements(session.buildContract).length === 0,
      };
    case "compile":
      return {
        workflowId: session.workflowId ?? null,
        phase: session.phase,
      };
    case "verification":
      return {
        workflowId: session.workflowId ?? null,
        phase: session.phase,
      };
  }
}

export function formatHandoffAccessList(handoff: BuilderPhaseHandoff): string {
  if (handoff.steps.length === 0) return "No prior builder steps in this turn.";
  return handoff.steps.map((step, index) =>
    `- Step ${index} (${step.agentLabel}): ${JSON.stringify(step.summary)}`,
  ).join("\n");
}

export function resolveAnalyzerPhase(session: WorkflowBuilderSession): BuilderAnalyzerPhase {
  if (session.phase === "saved") return "verification";
  if (
    session.phase === "intent_resolved"
    || session.phase === "spec_drafted"
    || session.phase === "spec_approved"
  ) {
    return "compile";
  }
  if (session.phase === "resolving_requirements") return "requirements";
  return "discovery";
}

export function canAutoAdvancePhase(from: BuilderAnalyzerPhase, to: BuilderAnalyzerPhase): boolean {
  return canAdvancePhase(from, to);
}
