import { z } from "zod";

export const approvalSensitiveRoleSchema = z.enum(["trigger", "source", "transform", "destination"]);

export const intentApprovalSchema = z.object({
  mode: z.enum(["auto", "ask", "mixed"]),
  sensitiveRoles: z.array(approvalSensitiveRoleSchema).default([]),
  sensitiveCapabilities: z.array(z.string()).default([]),
});

export const intentQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
});

export const intentQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(intentQuestionOptionSchema).min(2).max(4),
});

export const intentDecisionSchema = z.object({
  questionId: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
});

export const intentAnalysisSchema = z.object({
  outcome: z.string().min(1),
  trigger: z.string().min(1),
  question: intentQuestionSchema.optional(),
  approval: intentApprovalSchema.optional(),
  decisions: z.array(intentDecisionSchema).default([]),
});

export const intentDiscoveryStateSchema = z.object({
  status: z.enum(["pending", "needs_input", "ready", "confirmed"]).default("pending"),
  analysis: intentAnalysisSchema.optional(),
  decisions: z.array(intentDecisionSchema).default([]),
  askedQuestionIds: z.array(z.string().min(1)).default([]),
  confirmedBriefHash: z.string().min(1).optional(),
});

export type IntentQuestion = z.infer<typeof intentQuestionSchema>;
export type IntentDecision = z.infer<typeof intentDecisionSchema>;
export type IntentApproval = z.infer<typeof intentApprovalSchema>;
export type IntentAnalysis = z.infer<typeof intentAnalysisSchema>;
export type IntentDiscoveryState = z.infer<typeof intentDiscoveryStateSchema>;

export function unresolvedIntentQuestion(
  analysis: IntentAnalysis,
  state?: IntentDiscoveryState,
): IntentQuestion | undefined {
  if (!analysis.question) return undefined;
  const resolvedIds = new Set([
    ...(state?.askedQuestionIds ?? []),
    ...(state?.decisions ?? []).map((d) => d.questionId),
    ...analysis.decisions.map((d) => d.questionId),
  ]);
  return resolvedIds.has(analysis.question.id) ? undefined : analysis.question;
}
