// @ts-nocheck
import OpenAI from "openai";
let cachedClient = null;
function normalizeTextContent(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return "";
    return value
        .map((part) => {
        const text = part && typeof part === "object" ? part.text : null;
        return typeof text === "string" ? text : "";
    })
        .join("")
        .trim();
}
function readLoopExecutorOpenAiApiKey() {
    const key = process.env.TALLEI_LLM__OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
    if (!key)
        throw new Error("Loop executor requires OPENAI_API_KEY (or TALLEI_LLM__OPENAI_API_KEY).");
    return key;
}
export function loopExecutorOpenAiModel() {
    const raw = (process.env.TALLEI_LOOP_EXECUTOR__OPENAI_MODEL
        || process.env.TALLEI_LLM__CHAT_MODEL
        || "gpt-4o-mini").trim();
    const normalized = raw.startsWith("openai/") ? raw.slice("openai/".length) : raw;
    return /^gpt-/i.test(normalized) ? normalized : "gpt-4o-mini";
}
function openAiClient() {
    if (cachedClient)
        return cachedClient;
    cachedClient = new OpenAI({ apiKey: readLoopExecutorOpenAiApiKey() });
    return cachedClient;
}
export async function loopExecutorOpenAiChat(input) {
    const model = loopExecutorOpenAiModel();
    const useCompletionTokensParam = model.toLowerCase().startsWith("gpt-5");
    const requestBody = {
        model,
        messages: input.messages,
        temperature: input.temperature,
        response_format: input.responseFormat === "json_object" ? { type: "json_object" } : undefined,
        ...(useCompletionTokensParam
            ? { max_completion_tokens: input.maxTokens }
            : { max_tokens: input.maxTokens }),
    };
    const response = await openAiClient().chat.completions.create(requestBody, input.signal ? { signal: input.signal } : undefined);
    return {
        text: normalizeTextContent(response.choices[0]?.message?.content).trim(),
        model: response.model || model,
    };
}
//# sourceMappingURL=openai-chat.js.map