import OpenAI from "openai";

import { openAiTemperatureParam } from "../llm/openai-chat-params.js";

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
  const raw = (process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT ?? "medium").trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0" || raw === "off" || raw === "none") return null;
  if (LOOP_BUILDER_REASONING_EFFORTS.has(raw as LoopBuilderReasoningEffort)) {
    return raw as LoopBuilderReasoningEffort;
  }
  return "medium";
}

function readLoopBuilderMinCompletionTokens(): number {
  const raw = process.env.TALLEI_LOOP_BUILDER__GPT5_MIN_COMPLETION_TOKENS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 1024) return parsed;
  return 8192;
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

export async function loopBuilderOpenAiChat(input: {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json_object";
  signal?: AbortSignal;
}): Promise<{ text: string; model: string }> {
  const model = loopBuilderOpenAiModel();
  const useCompletionTokensParam = isGpt5Model(model);
  const maxCompletionTokens = completionTokenBudget(model, input.maxTokens);
  const reasoningEffort = loopBuilderOpenAiReasoningEffort();
  const response = await openAiClient().chat.completions.create(
    {
      model,
      messages: input.messages,
      ...openAiTemperatureParam(model, input.temperature),
      response_format: input.responseFormat === "json_object" ? { type: "json_object" } : undefined,
      ...(isLoopBuilderReasoningModel(model) && reasoningEffort
        ? { reasoning_effort: reasoningEffort }
        : {}),
      ...(useCompletionTokensParam
        ? { max_completion_tokens: maxCompletionTokens }
        : { max_tokens: maxCompletionTokens }),
    },
    input.signal ? { signal: input.signal } : undefined,
  );
  return {
    text: normalizeTextContent(response.choices[0]?.message?.content).trim(),
    model: response.model || model,
  };
}
