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

const intentQuestionsSchema = z.array(intentQuestionSchema).min(1).max(4).superRefine((questions, ctx) => {
  const seen = new Set<string>();
  for (const [index, question] of questions.entries()) {
    if (seen.has(question.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Intent question IDs must be unique",
        path: [index, "id"],
      });
      continue;
    }
    seen.add(question.id);
  }
});

export const intentDecisionSchema = z.object({
  questionId: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
});

export const intentExecutionStepSchema = z.object({
  role: approvalSensitiveRoleSchema,
  description: z.string().min(1),
});

export const intentAnalysisSchema = z.object({
  outcome: z.string().min(1),
  trigger: z.string().min(1),
  executionOrder: z.array(intentExecutionStepSchema).default([]),
  questions: intentQuestionsSchema,
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
export type IntentExecutionStep = z.infer<typeof intentExecutionStepSchema>;
export type IntentAnalysis = z.infer<typeof intentAnalysisSchema>;
export type IntentDiscoveryState = z.infer<typeof intentDiscoveryStateSchema>;
