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

const implementationQuestionPattern = /\b(app|apps|platform|platforms|channel|channels|connector|connectors|integration|integrations|toolkit|toolkits|provider|providers|inbox|email|mail|gmail|outlook|zendesk|freshdesk|intercom|slack|notion|hubspot|mailchimp)\b/i;
const sourceSelectionQuestionPattern = /\b(where|which)\b.{0,60}\b(ticket|tickets|request|requests|message|messages)\b.{0,40}\b(come from|arrive from|source)\b/i;

const intentQuestionsSchema = z.array(intentQuestionSchema).max(4).default([]).superRefine((questions, ctx) => {
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
    const implementationText = [
      question.question,
      ...question.options.flatMap((option) => [option.label, option.value]),
    ].join(" ");
    if (implementationQuestionPattern.test(implementationText)
      || sourceSelectionQuestionPattern.test(implementationText)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Intent questions must cover business behavior, not apps or platforms",
        path: [index, "question"],
      });
    }
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

const intentExecutionOrderSchema = z.array(intentExecutionStepSchema).min(2).max(12).superRefine((steps, ctx) => {
  if (steps[0]?.role !== "trigger") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The execution plan must start with a trigger step",
      path: [0, "role"],
    });
  }
  if (!steps.some((step) => step.role !== "trigger")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The execution plan must include work after the trigger",
    });
  }
});

export const intentAnalysisSchema = z.object({
  outcome: z.string().min(1),
  trigger: z.string().min(1),
  executionOrder: intentExecutionOrderSchema,
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
