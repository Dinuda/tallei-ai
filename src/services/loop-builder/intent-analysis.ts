import type { AuthContext } from "../../domain/auth/index.js";
import {
  loopIntentAnalysisSchema,
  loopIntentAnswerSchema,
  loopIntentContextSchema,
  loopIntentQuestionSchema,
  type LoopIntentAnalysis,
  type LoopIntentAnswer,
  type LoopIntentContext,
} from "../loop-engine/intent-context.js";
import { loadWorkflowUserProfile } from "../loop-engine/workflow-user-profile.js";
import { discoverToolsForQueries } from "../tool-spec/discovery.js";
import { listPreferences } from "../memory.js";
import { loopBuilderOpenAiChat } from "./openai-chat.js";

function sanitizeStoredAnswer(value: string): string {
  return value
    .trim()
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[runtime email]")
    .replace(/\b(?:sk-|key_|token_)[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .slice(0, 1000);
}

function fallbackAnalysis(prompt: string, feasibility: LoopIntentAnalysis["connectorFeasibility"], model?: string): LoopIntentAnalysis {
  return loopIntentAnalysisSchema.parse({
    normalizedIntent: {
      outcome: prompt.trim().replace(/\s+/g, " "),
      toolCategories: [],
      cadence: "Resolve from the request.",
      approvalModel: "Resolve from the request or clarification decisions.",
      runtimeInputs: [],
    },
    questions: [],
    assumptions: ["Intent analysis failed; unresolved semantic decisions must be reviewed during planning."],
    connectorFeasibility: feasibility,
    ...(model ? { model } : {}),
    analyzedAt: new Date().toISOString(),
  });
}

export function isUserFacingIntentQuestion(question: LoopIntentAnalysis["questions"][number]): boolean {
  void question;
  return true;
}

export async function analyzeLoopBuilderIntent(input: { auth: AuthContext; prompt: string }): Promise<LoopIntentAnalysis> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const [preferences, profile] = await Promise.all([
    listPreferences(input.auth).catch(() => []),
    loadWorkflowUserProfile(input.auth).catch(() => null),
  ]);
  const searchResponse = await loopBuilderOpenAiChat({
    responseFormat: "json_object",
    temperature: 0,
    maxTokens: 600,
    reasoningEffort: "medium",
    messages: [
      {
        role: "system",
        content: "Return JSON with a queries array containing at most four concise connector capability searches needed to analyze the request. Return an empty array when no connector is relevant.",
      },
      { role: "user", content: prompt },
    ],
  }).catch(() => null);
  let queries: string[] = [];
  if (searchResponse) {
    try {
      const raw = JSON.parse(searchResponse.text) as { queries?: unknown };
      queries = Array.isArray(raw.queries)
        ? raw.queries.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 4)
        : [];
    } catch {
      queries = [];
    }
  }
  const discovered = await discoverToolsForQueries(input.auth, queries, 12).catch(() => []);
  const contractViews = discovered.map((entry) => ({
    toolRef: entry.contract.toolRef,
    name: entry.contract.name,
    description: entry.contract.description,
    inputSchema: entry.contract.inputSchema,
    outputSchema: entry.contract.outputSchema,
    declaredRisk: entry.contract.constraints.risk ?? null,
    connected: entry.connected,
  }));
  let lastModel: string | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await loopBuilderOpenAiChat({
        responseFormat: "json_object",
        temperature: 0.1,
        maxTokens: 3000,
        reasoningEffort: "medium",
        messages: [
          {
            role: "system",
            content: [
              "Analyze a recurring workflow request before its behavioral spec is drafted.",
              "Return JSON only. Ask at most three optional questions, and only when an answer materially changes the workflow, tool categories, approval model, required runtime inputs, output scope, or schedule.",
              "Questions and choices must be user-facing. Never expose tool refs, action slugs, JSON schemas, or implementation details.",
              "Do not ask about facts already clear from the request, capabilities, preferences, or profile.",
              "Assess action feasibility from the supplied exact contracts. Do not infer feasibility from action names alone.",
              "For scheduled workflows, cadence, execution time, and timezone are workflow decisions. Ask a material clarification question when any required schedule decision is absent rather than treating it as runtime input.",
              "Connector authorization and connection state are platform-managed runtime checkpoints, never user intent questions or required workflow values.",
              "A connector may be feasible even when currently disconnected.",
              "Do not silently choose materially different behavior. Record unresolved decisions or ask a question.",
              "Every question needs 2-4 choices, one recommendedChoiceId, a reason, and impact text per choice.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              request: prompt,
              exactConnectorContracts: contractViews,
              savedPreferences: preferences.slice(0, 8).map((item) => item.text),
              profile: profile?.profileText ?? "",
              outputShape: {
                normalizedIntent: {
                  outcome: "string",
                  toolCategories: ["string"],
                  cadence: "string",
                  approvalModel: "string",
                  runtimeInputs: ["string"],
                },
                questions: [],
                assumptions: ["string"],
                connectorFeasibility: [{
                  capability: "user-facing capability description",
                  feasible: true,
                  reason: "contract-based feasibility explanation",
                }],
                analyzedAt: new Date().toISOString(),
              },
            }),
          },
        ],
      });
      lastModel = response.model;
      const raw = JSON.parse(response.text) as Record<string, unknown>;
      const parsed = loopIntentAnalysisSchema.parse({
        ...raw,
        questions: (Array.isArray(raw.questions) ? raw.questions : [])
          .filter((item): item is LoopIntentAnalysis["questions"][number] =>
            loopIntentQuestionSchema.safeParse(item).success)
          .filter((item, index, rows) => rows.findIndex((candidate) =>
            candidate.id === item.id) === index)
          .slice(0, 3),
        model: response.model,
        analyzedAt: new Date().toISOString(),
      });
      return parsed;
    } catch {
      // Retry once, then fall back to deterministic analysis.
    }
  }
  return fallbackAnalysis(prompt, [], lastModel);
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
