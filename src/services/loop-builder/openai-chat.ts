import OpenAI from "openai";

let cachedClient: OpenAI | null = null;

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
  const useCompletionTokensParam = model.toLowerCase().startsWith("gpt-5");
  const response = await openAiClient().chat.completions.create(
    {
      model,
      messages: input.messages,
      temperature: input.temperature ?? 1,
      response_format: input.responseFormat === "json_object" ? { type: "json_object" } : undefined,
      ...(useCompletionTokensParam
        ? { max_completion_tokens: input.maxTokens ?? 4096 }
        : { max_tokens: input.maxTokens ?? 4096 }),
    },
    input.signal ? { signal: input.signal } : undefined,
  );
  return {
    text: normalizeTextContent(response.choices[0]?.message?.content).trim(),
    model: response.model || model,
  };
}
