import { z } from "zod";

const loopIntentChoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  impact: z.string().min(1),
});

const loopIntentQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().min(1),
  choices: z.array(loopIntentChoiceSchema).min(2).max(4),
  recommendedChoiceId: z.string().min(1),
}).refine((question) => question.choices.some((choice) => choice.id === question.recommendedChoiceId), {
  message: "recommendedChoiceId must identify one of the question choices.",
  path: ["recommendedChoiceId"],
});

const loopIntentInteractiveOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
});

const loopIntentInteractivePromptSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(loopIntentInteractiveOptionSchema).min(2).max(6),
});

export const loopIntentAnalysisSchema = z.object({
  normalizedIntent: z.object({
    outcome: z.string().min(1),
    toolCategories: z.array(z.string().min(1)).default([]),
    cadence: z.string().min(1),
    approvalModel: z.string().min(1),
    runtimeInputs: z.array(z.string().min(1)).default([]),
  }),
  questions: z.array(loopIntentQuestionSchema).max(3).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  connectorFeasibility: z.array(z.object({
    capability: z.string().min(1),
    feasible: z.boolean(),
    reason: z.string().min(1),
  })).max(8).default([]),
  interactivePrompts: z.array(loopIntentInteractivePromptSchema).max(3).default([]),
  events: z.array(z.record(z.unknown())).max(10).default([]),
  model: z.string().optional(),
  analyzedAt: z.string().min(1),
});

const loopIntentAnswerSchema = z.object({
  questionId: z.string().min(1),
  choiceId: z.string().min(1).optional(),
  freeText: z.string().trim().min(1).max(1000).optional(),
}).refine((answer) => Boolean(answer.choiceId || answer.freeText), {
  message: "An answer requires a choice or free-text value.",
});

const loopIntentDecisionSchema = z.object({
  questionId: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  source: z.enum(["user", "recommended_assumption"]),
});

export const loopIntentContextSchema = z.object({
  analysis: loopIntentAnalysisSchema,
  decisions: z.array(loopIntentDecisionSchema).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  resolvedIntent: z.string().min(1),
  resolvedAt: z.string().min(1),
});

export type LoopIntentAnalysis = z.infer<typeof loopIntentAnalysisSchema>;
type LoopIntentAnswer = z.infer<typeof loopIntentAnswerSchema>;
export type LoopIntentContext = z.infer<typeof loopIntentContextSchema>;

function assumptionsMirrorAnalysis(context: LoopIntentContext): boolean {
  const top = context.assumptions;
  const fromAnalysis = context.analysis.assumptions;
  return top.length === fromAnalysis.length && top.every((entry, index) => entry === fromAnalysis[index]);
}

/** Drop top-level assumptions when they only duplicate analysis.assumptions (legacy rows). */
export function normalizeLoopIntentContext(context: LoopIntentContext): LoopIntentContext {
  if (!assumptionsMirrorAnalysis(context)) return context;
  return { ...context, assumptions: [] };
}

export function createLoopIntentContext(input: {
  analysis: LoopIntentAnalysis;
  resolvedIntent: string;
  resolvedAt?: string;
  decisions?: LoopIntentContext["decisions"];
  assumptions?: string[];
}): LoopIntentContext {
  return normalizeLoopIntentContext(loopIntentContextSchema.parse({
    analysis: input.analysis,
    decisions: input.decisions ?? [],
    assumptions: input.assumptions ?? [],
    resolvedIntent: input.resolvedIntent,
    resolvedAt: input.resolvedAt ?? new Date().toISOString(),
  }));
}
