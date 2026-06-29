import { z } from "zod";

export const intentQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  description: z.string().optional(),
});

export const intentQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().min(1),
  priority: z.enum(["safety", "outcome", "trigger", "scope", "success"]),
  options: z.array(intentQuestionOptionSchema).min(2).max(4),
  recommendedOptionId: z.string().min(1),
}).refine(
  (question) => question.options.some((option) => option.id === question.recommendedOptionId),
  { message: "recommendedOptionId must identify one of the question options" },
);

export const intentDecisionSchema = z.object({
  questionId: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  source: z.enum(["user", "recommended_assumption"]),
});

export const intentAnalysisSchema = z.object({
  normalizedOutcome: z.string().min(1),
  triggerOrCadence: z.string().min(1),
  requiredActions: z.array(z.string().min(1)).default([]),
  destinations: z.array(z.string().min(1)).default([]),
  successCriteria: z.array(z.string().min(1)).default([]),
  approvalAndSafety: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  questions: z.array(intentQuestionSchema).max(5).default([]),
  decisions: z.array(intentDecisionSchema).default([]),
});

export const intentDiscoveryStateSchema = z.object({
  status: z.enum(["pending", "needs_input", "ready", "confirmed"]).default("pending"),
  analysis: intentAnalysisSchema.optional(),
  decisions: z.array(intentDecisionSchema).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  askedQuestionIds: z.array(z.string().min(1)).default([]),
  confirmedBriefHash: z.string().min(1).optional(),
});

export type IntentQuestion = z.infer<typeof intentQuestionSchema>;
export type IntentDecision = z.infer<typeof intentDecisionSchema>;
export type IntentAnalysis = z.infer<typeof intentAnalysisSchema>;
export type IntentDiscoveryState = z.infer<typeof intentDiscoveryStateSchema>;

const QUESTION_PRIORITY: Record<IntentQuestion["priority"], number> = {
  safety: 0,
  outcome: 1,
  trigger: 2,
  scope: 3,
  success: 4,
};

export function unresolvedIntentQuestions(
  analysis: IntentAnalysis,
  state?: IntentDiscoveryState,
): IntentQuestion[] {
  const resolvedIds = new Set([
    ...(state?.askedQuestionIds ?? []),
    ...(state?.decisions ?? []).map((decision) => decision.questionId),
    ...analysis.decisions.map((decision) => decision.questionId),
  ]);
  return analysis.questions
    .filter((question) => !resolvedIds.has(question.id))
    .sort((a, b) => QUESTION_PRIORITY[a.priority] - QUESTION_PRIORITY[b.priority]);
}
