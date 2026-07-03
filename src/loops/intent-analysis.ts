import type { AskQuestionInput, AskQuestionOutput } from "./conductor-tools.js";
import type { IntentApproval, IntentAnalysis, IntentQuestion } from "./intent-discovery.js";
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

export function isIntentResolutionPatch(patch: SpecPatch): boolean {
  const keys = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  return keys.length > 0 && keys.every((key) => key === "intentDiscovery" || key === "approval");
}

export function isIntentPhaseQuestionId(questionId: string): boolean {
  return questionId.trim().length > 0 && !questionId.startsWith("connector-app:");
}

function inferApprovalFromIntentAnswer(
  questionId: string,
  selectedValues: string[],
  answerText: string,
): IntentApproval | undefined {
  const value = selectedValues[0]?.toLowerCase() ?? "";
  const answer = answerText.toLowerCase();
  const approvalQuestion = questionId === "approval-mode"
    || /approval|review|auto.?send|send.?auto/i.test(questionId);

  if (!approvalQuestion) return undefined;

  if (value === "review_first" || value === "review" || /review/.test(answer)) {
    return {
      mode: "mixed",
      sensitiveRoles: ["destination"],
      sensitiveCapabilities: [],
    };
  }

  if (value === "auto" || /automatically|auto.?send|send.?auto/.test(answer)) {
    return {
      mode: "auto",
      sensitiveRoles: [],
      sensitiveCapabilities: [],
    };
  }

  return undefined;
}

export function buildIntentAnswerPatch(
  spec: LoopSpec,
  input: AskQuestionInput,
  output: AskQuestionOutput,
): SpecPatch | null {
  if (output.skipped) return null;
  if (!isIntentPhaseQuestionId(output.questionId)) return null;
  if (spec.intentDiscovery.status !== "needs_input") return null;
  if (spec.intentDiscovery.decisions.some((row) => row.questionId === output.questionId)) {
    return null;
  }

  const answer = output.answerText.trim()
    || output.selectedValues.join(", ").trim();
  if (!answer) return null;

  const decision = {
    questionId: output.questionId,
    question: input.question,
    answer,
  };
  const decisions = [...spec.intentDiscovery.decisions, decision];
  const askedQuestionIds = [...new Set([
    ...spec.intentDiscovery.askedQuestionIds,
    output.questionId,
  ])];

  const existingAnalysis = spec.intentDiscovery.analysis;
  const updatedAnalysis: IntentAnalysis | undefined = existingAnalysis
    ? {
        ...existingAnalysis,
        decisions,
        question: existingAnalysis.question?.id === output.questionId
          ? undefined
          : existingAnalysis.question,
      }
    : undefined;

  const provisionalState = {
    ...spec.intentDiscovery,
    decisions,
    askedQuestionIds,
    analysis: updatedAnalysis,
  };
  const stillUnresolved = updatedAnalysis
    ? unresolvedIntentQuestion(updatedAnalysis, provisionalState)
    : undefined;

  const approval = inferApprovalFromIntentAnswer(
    output.questionId,
    output.selectedValues,
    output.answerText,
  );

  return {
    intentDiscovery: {
      status: stillUnresolved ? "needs_input" : "ready",
      decisions,
      askedQuestionIds,
      ...(updatedAnalysis ? { analysis: updatedAnalysis } : {}),
      confirmedBriefHash: undefined,
    },
    ...(approval ? { approval: normalizeApprovalPolicyCore(approval) } : {}),
  };
}
