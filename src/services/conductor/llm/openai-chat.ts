import OpenAI from "openai";

import { config } from "../../../config/index.js";
import { createLoopChatOpenAiSdk, resolveConfiguredChatModel } from "../../llm/loop-chat-client.js";
import { isOpenCodeZenChatCompletionsModel } from "../../llm/chat-model-routing.js";
import { openAiTemperatureParam } from "../../llm/openai-chat-params.js";
import { estimateLoopBuilderCostUsd, reportLoopBuilderProgress } from "../utils/progress.js";

/** Default completion budget for loop-builder LLM calls (spec draft, etc.). */
export const LOOP_BUILDER_DEFAULT_MAX_COMPLETION_TOKENS = 10_000;

/** Retry budget when the first completion hits the token limit. */
export const LOOP_BUILDER_RETRY_MAX_COMPLETION_TOKENS = 16_000;

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

export function loopBuilderOpenAiTimeoutMs(): number {
  const raw = process.env.TALLEI_LOOP_BUILDER__OPENAI_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return 45_000;
  return Math.max(5_000, Math.min(180_000, parsed));
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
  const fallback = requested ?? LOOP_BUILDER_DEFAULT_MAX_COMPLETION_TOKENS;
  return isLoopBuilderReasoningModel(model)
    ? Math.max(fallback, readLoopBuilderMinCompletionTokens())
    : fallback;
}

/** Completion budget for streamed analyzer turns (tool calls + visible text). */
export function loopBuilderStreamMaxOutputTokens(model = loopBuilderOpenAiModel()): number {
  return completionTokenBudget(model);
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

export function loopBuilderOpenAiModel(): string {
  const model = resolveConfiguredChatModel(process.env.TALLEI_LOOP_BUILDER__OPENAI_MODEL);
  if (!config.localModelMode && /^gpt-gpt-5-nano$/i.test(model)) return "gpt-4o";
  return model;
}

function loopBuilderOpenCodeThinkingEffort(): string | null {
  // Builder prompts forbid chain-of-thought; thinking models often emit reasoning-only
  // turns with no tool calls. Opt in via env when debugging model behavior.
  const raw = (process.env.TALLEI_LOOP_BUILDER__OPENCODE_THINKING_EFFORT ?? "off").trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0" || raw === "off" || raw === "none" || raw === "disabled") {
    return null;
  }
  return raw;
}

/** Provider options for streamed chat (analyzer + spec runs) on reasoning models. */
export function loopBuilderStreamProviderOptions(model = loopBuilderOpenAiModel()) {
  if (isLoopBuilderReasoningModel(model)) {
    const reasoningEffort = loopBuilderOpenAiReasoningEffort();
    return {
      openai: {
        // Loop builder replays the full client message history each turn without
        // previous_response_id chaining. store=true would emit item_reference
        // payloads OpenAI cannot resolve on a fresh request.
        store: false as const,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        reasoningSummary: "auto" as const,
      },
    };
  }

  // OpenCode Zen chat models (DeepSeek, Kimi, GLM) expose thinking via reasoning_content
  // when thinking mode is enabled — same Reasoning UI path as OpenAI reasoningSummary.
  if (config.llmProvider === "opencode" && isOpenCodeZenChatCompletionsModel(model)) {
    const reasoningEffort = loopBuilderOpenCodeThinkingEffort();
    if (!reasoningEffort) return undefined;
    return {
      opencode: {
        thinking: { type: "enabled" },
        reasoningEffort,
      },
    };
  }

  return undefined;
}

function openAiClient(): OpenAI {
  if (cachedClient) return cachedClient;
  cachedClient = createLoopChatOpenAiSdk();
  return cachedClient;
}

type LoopBuilderOpenAiChatResult = {
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

type LoopBuilderJsonSchemaFormat = {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
};

function createCallSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const onParentAbort = () => controller.abort();
  parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
    timedOut: () => didTimeout,
  };
}

export async function loopBuilderOpenAiChat(input: {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  temperature?: number;
  maxTokens?: number;
  exactMaxTokens?: boolean;
  retryEmptyResponses?: boolean;
  emptyResponseRetryMaxTokens?: number;
  responseFormat?: "json_object" | LoopBuilderJsonSchemaFormat;
  reasoningEffort?: LoopBuilderReasoningEffort | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LoopBuilderOpenAiChatResult> {
  const model = loopBuilderOpenAiModel();
  const useCompletionTokensParam = isGpt5Model(model);
  const timeoutMs = input.timeoutMs ?? loopBuilderOpenAiTimeoutMs();
  const baseMaxCompletionTokens = input.exactMaxTokens
    ? input.maxTokens ?? LOOP_BUILDER_DEFAULT_MAX_COMPLETION_TOKENS
    : completionTokenBudget(model, input.maxTokens);
  const configuredReasoningEffort = input.reasoningEffort === undefined
    ? loopBuilderOpenAiReasoningEffort()
    : input.reasoningEffort;

  async function callOnce(attempt: {
    reasoningEffort: LoopBuilderReasoningEffort | null;
    maxCompletionTokens: number;
  }): Promise<LoopBuilderOpenAiChatResult> {
    const callSignal = createCallSignal(input.signal, timeoutMs);
    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await openAiClient().chat.completions.create(
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
        { signal: callSignal.signal },
      );
    } catch (error) {
      if (callSignal.timedOut()) {
        throw new Error(`Loop builder LLM call timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw error;
    } finally {
      callSignal.cleanup();
    }
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
  if (input.retryEmptyResponses !== false) {
    if (isLoopBuilderReasoningModel(model) && configuredReasoningEffort && configuredReasoningEffort !== "minimal") {
      attempts.push({ reasoningEffort: "minimal", maxCompletionTokens: baseMaxCompletionTokens });
    }
    attempts.push({
      reasoningEffort: input.emptyResponseRetryMaxTokens ? configuredReasoningEffort : null,
      maxCompletionTokens: input.emptyResponseRetryMaxTokens
        ? Math.max(baseMaxCompletionTokens, input.emptyResponseRetryMaxTokens)
        : Math.max(baseMaxCompletionTokens * 2, readLoopBuilderMinCompletionTokens()),
    });
  }

  let lastResult: LoopBuilderOpenAiChatResult | null = null;
  for (const [attemptIndex, attempt] of attempts.entries()) {
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
        totalTokens: promptTokens + completionTokens,
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
    const nextAttempt = attempts[attemptIndex + 1];
    if (nextAttempt) {
      const promptTokens = result.usage.promptTokens ?? 0;
      const completionTokens = result.usage.completionTokens ?? 0;
      reportLoopBuilderProgress({
        stage: "llm_call",
        message: result.finishReason === "length"
          ? `Retrying ${result.model} after exhausting the serialization budget`
          : `Retrying ${result.model} after an empty response`,
        status: "running",
        model: result.model,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimatedCostUsd: estimateLoopBuilderCostUsd(result.model, promptTokens, completionTokens),
        details: {
          finishReason: result.finishReason,
          reasoningEffort: attempt.reasoningEffort,
          exhaustedMaxCompletionTokens: attempt.maxCompletionTokens,
          retryMaxCompletionTokens: nextAttempt.maxCompletionTokens,
          responseCharacters: result.text.length,
        },
      });
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
