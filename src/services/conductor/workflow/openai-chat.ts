// @ts-nocheck
import OpenAI from "openai";

import { createLoopChatOpenAiSdk, resolveConfiguredChatModel } from "../../llm/loop-chat-client.js";
import { openAiTemperatureParam } from "../../llm/openai-chat-params.js";

let cachedClient = null;

function isGpt5Model(model) {
    return model.toLowerCase().startsWith("gpt-5");
}

function readGpt5MinCompletionTokens() {
    const raw = process.env.TALLEI_LOOP_EXECUTOR__GPT5_MIN_COMPLETION_TOKENS;
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 1024) return parsed;
    return 4096;
}

function completionTokenBudget(model, requested) {
    const fallback = requested ?? 4096;
    return isGpt5Model(model) ? Math.max(fallback, readGpt5MinCompletionTokens()) : fallback;
}

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
function loopExecutorOpenAiModel() {
    return resolveConfiguredChatModel(process.env.TALLEI_LOOP_EXECUTOR__OPENAI_MODEL);
}
function openAiClient() {
    if (cachedClient)
        return cachedClient;
    cachedClient = createLoopChatOpenAiSdk();
    return cachedClient;
}
export async function loopExecutorOpenAiChat(input) {
    const model = loopExecutorOpenAiModel();
    const useCompletionTokensParam = isGpt5Model(model);
    const maxCompletionTokens = completionTokenBudget(model, input.maxTokens);
    const requestBody = {
        model,
        messages: input.messages,
        ...openAiTemperatureParam(model, input.temperature),
        response_format: input.responseFormat === "json_object" ? { type: "json_object" } : undefined,
        ...(useCompletionTokensParam
            ? { max_completion_tokens: maxCompletionTokens }
            : { max_tokens: maxCompletionTokens }),
    };
    const response = await openAiClient().chat.completions.create(requestBody, input.signal ? { signal: input.signal } : undefined);
    return {
        text: normalizeTextContent(response.choices[0]?.message?.content).trim(),
        model: response.model || model,
        finishReason: response.choices[0]?.finish_reason ?? null,
        usage: {
            promptTokens: response.usage?.prompt_tokens ?? null,
            completionTokens: response.usage?.completion_tokens ?? null,
            totalTokens: response.usage?.total_tokens ?? null,
        },
    };
}
//# sourceMappingURL=openai-chat.js.map
