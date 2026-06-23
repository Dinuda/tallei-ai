import { z } from "zod";

import { readArtifacts } from "../builder/artifacts.js";
import type { BuilderArtifactKey } from "../builder/artifacts.js";
import { canRegressPhase } from "../builder/phases/graph.js";
import { resolveAnalyzerPhase } from "../builder/phases/handoff.js";
import type { BuilderAnalyzerPhase } from "../builder/phases/types.js";
import { loopBuilderOpenAiChat } from "../llm/openai-chat.js";
import type { WorkflowBuilderSession } from "../services/session.service.js";

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

const REVISION_CONFIDENCE_THRESHOLD = 0.7;

export const loopIntentRevisionSchema = z.object({
  targetPhase: z.enum(["discovery", "requirements", "compile", "verification"]).nullable(),
  revisedArtifact: z.enum(["intent", "buildContract", "spec", "verification"]).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type RevisionIntentResult = {
  targetPhase: BuilderAnalyzerPhase | null;
  revisedArtifact: BuilderArtifactKey | null;
  confidence: number;
  reason: string;
};

export function isAutoContinueUserMessage(text: string): boolean {
  return /^(continue|resume)$/i.test(text.trim());
}

export function evaluateRevisionIntentGuardrails(
  object: z.infer<typeof loopIntentRevisionSchema>,
  currentPhase: BuilderAnalyzerPhase,
): RevisionIntentResult {
  if (!object.targetPhase || object.confidence < REVISION_CONFIDENCE_THRESHOLD) {
    return {
      targetPhase: null,
      revisedArtifact: object.revisedArtifact,
      confidence: object.confidence,
      reason: object.reason,
    };
  }

  if (!canRegressPhase(currentPhase, object.targetPhase)) {
    return {
      targetPhase: null,
      revisedArtifact: object.revisedArtifact,
      confidence: object.confidence,
      reason: `Regression to ${object.targetPhase} is not allowed from ${currentPhase}`,
    };
  }

  return {
    targetPhase: object.targetPhase,
    revisedArtifact: object.revisedArtifact,
    confidence: object.confidence,
    reason: object.reason,
  };
}

export async function classifyRevisionIntent(input: {
  session: WorkflowBuilderSession;
  userMessage: string;
  userMessageId?: string;
}): Promise<RevisionIntentResult> {
  if (!input.userMessage.trim() || isAutoContinueUserMessage(input.userMessage)) {
    return {
      targetPhase: null,
      revisedArtifact: null,
      confidence: 0,
      reason: "Auto-continue or empty message",
    };
  }

  const currentPhase = resolveAnalyzerPhase(input.session);
  const artifacts = readArtifacts(input.session);

  const response = await loopBuilderOpenAiChat({
    messages: [
      {
        role: "system",
        content: [
          "Classify whether a loop-builder user message requests revising an earlier builder phase.",
          'Return JSON: { "targetPhase": "discovery"|"requirements"|"compile"|"verification"|null,',
          '"revisedArtifact": "intent"|"buildContract"|"spec"|"verification"|null,',
          '"confidence": number, "reason": string }.',
          "Use targetPhase=null when the user is continuing normally, answering a setup question, or approving a step.",
          "Return the earliest affected phase when the user wants to change prior work (intent, connectors, schedule, spec, or launch).",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Current analyzer phase: ${currentPhase}`,
          `Artifacts summary: ${JSON.stringify(artifacts)}`,
          `User message: ${input.userMessage}`,
        ].join("\n"),
      },
    ],
    responseFormat: "json_object",
    temperature: 0.2,
  });

  const object = loopIntentRevisionSchema.parse(JSON.parse(response.text));
  return evaluateRevisionIntentGuardrails(object, currentPhase);
}
