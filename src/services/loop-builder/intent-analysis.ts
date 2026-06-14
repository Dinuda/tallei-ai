import {
  loopIntentAnswerSchema,
  loopIntentContextSchema,
  type LoopIntentAnalysis,
  type LoopIntentAnswer,
  type LoopIntentContext,
} from "../loop-engine/intent-context.js";

function sanitizeStoredAnswer(value: string): string {
  return value
    .trim()
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[runtime email]")
    .replace(/\b(?:sk-|key_|token_)[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .slice(0, 1000);
}

export function isUserFacingIntentQuestion(question: LoopIntentAnalysis["questions"][number]): boolean {
  void question;
  return true;
}

export function resolveLoopIntentContext(input: {
  analysis: LoopIntentAnalysis;
  answers?: LoopIntentAnswer[];
  skippedQuestionIds?: string[];
}): LoopIntentContext {
  const questionIds = new Set(input.analysis.questions.map((question) => question.id));
  for (const answer of input.answers ?? []) {
    if (!questionIds.has(answer.questionId)) throw new Error(`Unknown intent question: ${answer.questionId}`);
  }
  for (const questionId of input.skippedQuestionIds ?? []) {
    if (!questionIds.has(questionId)) throw new Error(`Unknown skipped intent question: ${questionId}`);
  }
  const answers = new Map((input.answers ?? []).map((answer) => {
    const parsed = loopIntentAnswerSchema.parse(answer);
    return [parsed.questionId, parsed];
  }));
  const skipped = new Set(input.skippedQuestionIds ?? []);
  const decisions = input.analysis.questions.map((item) => {
    const answer = answers.get(item.id);
    const selected = answer?.choiceId ? item.choices.find((choice) => choice.id === answer.choiceId) : undefined;
    if (answer?.choiceId && !selected) throw new Error(`Unknown choice for intent question: ${item.id}`);
    const recommended = item.choices.find((choice) => choice.id === item.recommendedChoiceId) ?? item.choices[0]!;
    const answerText = sanitizeStoredAnswer(answer?.freeText || selected?.value || recommended.value);
    return {
      questionId: item.id,
      question: item.question,
      answer: answerText,
      source: answer && !skipped.has(item.id) ? "user" as const : "recommended_assumption" as const,
    };
  });
  const assumptions = [
    ...input.analysis.assumptions,
    ...decisions.filter((decision) => decision.source === "recommended_assumption")
      .map((decision) => `${decision.question} Assumed: ${decision.answer}`),
  ];
  const normalized = input.analysis.normalizedIntent;
  const resolvedIntent = [
    `Outcome: ${normalized.outcome}`,
    normalized.toolCategories.length > 0 ? `Tool categories: ${normalized.toolCategories.join(", ")}` : null,
    `Cadence: ${normalized.cadence}`,
    `Approval model: ${normalized.approvalModel}`,
    normalized.runtimeInputs.length > 0 ? `Runtime inputs: ${normalized.runtimeInputs.join(", ")}` : null,
    ...decisions.map((decision) => `Decision - ${decision.question}: ${decision.answer}`),
    ...assumptions.map((assumption) => `Assumption: ${assumption}`),
  ].filter(Boolean).join("\n");
  return loopIntentContextSchema.parse({
    analysis: input.analysis,
    decisions,
    assumptions,
    resolvedIntent,
    resolvedAt: new Date().toISOString(),
  });
}
