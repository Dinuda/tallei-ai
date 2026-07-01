import type { IntentAnalysis, IntentQuestion } from "./intent-discovery.js";
import { unresolvedIntentQuestion } from "./intent-discovery.js";
import type { LoopSpec, SpecPatch } from "./spec.js";
import { normalizeApprovalPolicyCore } from "./approval-policy.js";

export function buildIntentAnalysisSpecPatch(
  currentSpec: LoopSpec,
  analysis: IntentAnalysis,
): { patch: SpecPatch; nextQuestion?: IntentQuestion } {
  const nextQuestion = unresolvedIntentQuestion(analysis, currentSpec.intentDiscovery);
  const askedQuestionIds = [...new Set([
    ...currentSpec.intentDiscovery.askedQuestionIds,
    ...(nextQuestion ? [nextQuestion.id] : []),
  ])];

  return {
    patch: {
      intent: {
        outcome: analysis.outcome,
      },
      intentDiscovery: {
        status: nextQuestion ? "needs_input" : "ready",
        analysis,
        decisions: analysis.decisions,
        askedQuestionIds,
        confirmedBriefHash: undefined,
      },
      ...(analysis.approval ? { approval: normalizeApprovalPolicyCore(analysis.approval) } : {}),
    },
    ...(nextQuestion ? { nextQuestion } : {}),
  };
}
