import OpenAI from "openai";

import { openAiTemperatureParam } from "../llm/openai-chat-params.js";
import { estimateLoopBuilderCostUsd, reportLoopBuilderProgress } from "./progress.js";

type LoopBuilderReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

const LOOP_BUILDER_REASONING_EFFORTS = new Set<LoopBuilderReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

let cachedClient: OpenAI | null = null;

function isGpt5Model(model: string): boolean {
  return model.toLowerCase().startsWith("gpt-5");
}

export function isLoopBuilderReasoningModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith("gpt-5")
    || normalized.startsWith("o1")
    || normalized.startsWith("o3")
    || normalized.startsWith("o4")
  );
}

export function loopBuilderOpenAiReasoningEffort(): LoopBuilderReasoningEffort | null {
  // Minimal default: structured JSON architect/spec calls need completion tokens for output,
  // not long internal reasoning chains (gpt-5-* can return empty content otherwise).
  const raw = (process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT ?? "minimal").trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0" || raw === "off" || raw === "none") return null;
  if (LOOP_BUILDER_REASONING_EFFORTS.has(raw as LoopBuilderReasoningEffort)) {
    return raw as LoopBuilderReasoningEffort;
  }
  return "minimal";
}

function readLoopBuilderMinCompletionTokens(): number {
  const raw = process.env.TALLEI_LOOP_BUILDER__GPT5_MIN_COMPLETION_TOKENS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 1024) return parsed;
  return 16_384;
}

function completionTokenBudget(model: string, requested?: number): number {
  const fallback = requested ?? 4096;
  return isLoopBuilderReasoningModel(model)
    ? Math.max(fallback, readLoopBuilderMinCompletionTokens())
    : fallback;
}

function normalizeTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const text = part && typeof part === "object" ? (part as { text?: string }).text : null;
      return typeof text === "string" ? text : "";
    })
    .join("")
    .trim();
}

function readOpenAiApiKey(): string {
  const key = process.env.TALLEI_LLM__OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!key) throw new Error("Loop builder requires OPENAI_API_KEY (or TALLEI_LLM__OPENAI_API_KEY).");
  return key;
}

export function loopBuilderOpenAiModel(): string {
  const raw = (
    process.env.TALLEI_LOOP_BUILDER__OPENAI_MODEL
    || process.env.TALLEI_LLM__CHAT_MODEL
    || "gpt-4o"
  ).trim();
  const normalized = raw.startsWith("openai/") ? raw.slice("openai/".length) : raw;
  if (/^gpt-4o-mini$/i.test(normalized)) return "gpt-4o";
  return /^gpt-/i.test(normalized) ? normalized : "gpt-4o";
}

function openAiClient(): OpenAI {
  if (cachedClient) return cachedClient;
  cachedClient = new OpenAI({ apiKey: readOpenAiApiKey() });
  return cachedClient;
}

export type LoopBuilderOpenAiChatResult = {
  text: string;
  model: string;
  finishReason: string | null;
  refusal: string | null;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
};

function readMessageRefusal(message: OpenAI.Chat.ChatCompletionMessage | undefined): string | null {
  const refusal = message && typeof message === "object" ? (message as { refusal?: unknown }).refusal : null;
  return typeof refusal === "string" && refusal.trim() ? refusal.trim() : null;
}

function formatLoopBuilderEmptyResponseError(input: {
  model: string;
  finishReason: string | null;
  refusal: string | null;
  usage: LoopBuilderOpenAiChatResult["usage"];
  maxCompletionTokens: number;
  reasoningEffort: LoopBuilderReasoningEffort | null;
}): string {
  const details = [
    `model=${input.model}`,
    `finish_reason=${input.finishReason ?? "unknown"}`,
    `max_completion_tokens=${input.maxCompletionTokens}`,
    input.reasoningEffort ? `reasoning_effort=${input.reasoningEffort}` : "reasoning_effort=disabled",
    input.usage.completionTokens != null ? `completion_tokens=${input.usage.completionTokens}` : null,
    input.refusal ? `refusal=${JSON.stringify(input.refusal)}` : null,
  ].filter(Boolean).join(", ");
  return `Loop builder LLM returned empty response (${details}).`;
}

export type LoopBuilderJsonSchemaFormat = {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
};

export async function loopBuilderOpenAiChat(input: {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  temperature?: number;
  maxTokens?: number;
  exactMaxTokens?: boolean;
  retryEmptyResponses?: boolean;
  responseFormat?: "json_object" | LoopBuilderJsonSchemaFormat;
  reasoningEffort?: LoopBuilderReasoningEffort | null;
  signal?: AbortSignal;
}): Promise<LoopBuilderOpenAiChatResult> {
  const model = loopBuilderOpenAiModel();
  const useCompletionTokensParam = isGpt5Model(model);
  const baseMaxCompletionTokens = input.exactMaxTokens
    ? input.maxTokens ?? 4096
    : completionTokenBudget(model, input.maxTokens);
  const configuredReasoningEffort = input.reasoningEffort === undefined
    ? loopBuilderOpenAiReasoningEffort()
    : input.reasoningEffort;

  async function callOnce(attempt: {
    reasoningEffort: LoopBuilderReasoningEffort | null;
    maxCompletionTokens: number;
  }): Promise<LoopBuilderOpenAiChatResult> {
    const response = await openAiClient().chat.completions.create(
      {
        model,
        messages: input.messages,
        ...openAiTemperatureParam(model, input.temperature),
        response_format: input.responseFormat === "json_object"
          ? { type: "json_object" as const }
          : input.responseFormat && typeof input.responseFormat === "object"
            ? {
                type: "json_schema" as const,
                json_schema: {
                  name: input.responseFormat.name,
                  strict: true,
                  schema: input.responseFormat.schema,
                },
              }
            : undefined,
        ...(isLoopBuilderReasoningModel(model) && attempt.reasoningEffort
          ? { reasoning_effort: attempt.reasoningEffort }
          : {}),
        ...(useCompletionTokensParam
          ? { max_completion_tokens: attempt.maxCompletionTokens }
          : { max_tokens: attempt.maxCompletionTokens }),
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    const message = response.choices[0]?.message;
    return {
      text: normalizeTextContent(message?.content).trim(),
      model: response.model || model,
      finishReason: response.choices[0]?.finish_reason ?? null,
      refusal: readMessageRefusal(message),
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? null,
        completionTokens: response.usage?.completion_tokens ?? null,
        totalTokens: response.usage?.total_tokens ?? null,
      },
    };
  }

  const attempts: Array<{ reasoningEffort: LoopBuilderReasoningEffort | null; maxCompletionTokens: number }> = [
    { reasoningEffort: configuredReasoningEffort, maxCompletionTokens: baseMaxCompletionTokens },
  ];
  if (isLoopBuilderReasoningModel(model) && input.retryEmptyResponses !== false) {
    if (configuredReasoningEffort && configuredReasoningEffort !== "minimal") {
      attempts.push({ reasoningEffort: "minimal", maxCompletionTokens: baseMaxCompletionTokens });
    }
    attempts.push({
      reasoningEffort: null,
      maxCompletionTokens: Math.max(baseMaxCompletionTokens * 2, readLoopBuilderMinCompletionTokens()),
    });
  }

  let lastResult: LoopBuilderOpenAiChatResult | null = null;
  for (const attempt of attempts) {
    const result = await callOnce(attempt);
    lastResult = result;
    if (result.text) {
      const promptTokens = result.usage.promptTokens ?? 0;
      const completionTokens = result.usage.completionTokens ?? 0;
      reportLoopBuilderProgress({
        stage: "llm_call",
        message: `Completed ${result.model} planning call`,
        status: "completed",
        model: result.model,
        promptTokens,
        completionTokens,
        totalTokens: result.usage.totalTokens ?? promptTokens + completionTokens,
        estimatedCostUsd: estimateLoopBuilderCostUsd(result.model, promptTokens, completionTokens),
        details: {
          finishReason: result.finishReason,
          reasoningEffort: attempt.reasoningEffort,
          maxCompletionTokens: attempt.maxCompletionTokens,
          usage: result.usage,
          responseCharacters: result.text.length,
        },
      });
      return result;
    }
    if (result.refusal) {
      throw new Error(formatLoopBuilderEmptyResponseError({
        model: result.model,
        finishReason: result.finishReason,
        refusal: result.refusal,
        usage: result.usage,
        maxCompletionTokens: attempt.maxCompletionTokens,
        reasoningEffort: attempt.reasoningEffort,
      }));
    }
  }

  const failed = lastResult ?? {
    text: "",
    model,
    finishReason: null,
    refusal: null,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
  };
  throw new Error(formatLoopBuilderEmptyResponseError({
    model: failed.model,
    finishReason: failed.finishReason,
    refusal: failed.refusal,
    usage: failed.usage,
    maxCompletionTokens: attempts[attempts.length - 1]?.maxCompletionTokens ?? baseMaxCompletionTokens,
    reasoningEffort: attempts[attempts.length - 1]?.reasoningEffort ?? configuredReasoningEffort,
  }));
}
