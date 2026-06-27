import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

import { config } from "../../../config/index.js";
import {
  createPooledLlmFetch,
  getOpenCodeApiKeyPool,
} from "../../../services/llm/api-key-pool.js";

export type StreamingPurpose = "conductor" | "run_transcript" | "planner";

export type StreamingLanguageModelOptions = {
  userId?: string;
};

function withReasoningExtraction(model: Parameters<typeof wrapLanguageModel>[0]["model"]) {
  return ["think", "thinking"].reduce(
    (wrapped, tagName) => wrapLanguageModel({
      model: wrapped,
      middleware: extractReasoningMiddleware({ tagName }),
    }),
    model,
  );
}

export function getStreamingLanguageModel(
  purpose: StreamingPurpose,
  options?: StreamingLanguageModelOptions,
) {
  const pool = getOpenCodeApiKeyPool();
  if (pool.size === 0) {
    throw new Error("TALLEI_LLM__OPENCODE_API_KEY (or TALLEI_LLM__OPENCODE_API_KEYS) is required for streaming inference");
  }
  const userId = options?.userId;
  const provider = createOpenAICompatible({
    name: "opencode",
    baseURL: config.opencodeBaseUrl,
    apiKey: pool.pickKey(userId),
    fetch: createPooledLlmFetch(pool, "opencode", userId),
  });
  const modelName = purpose === "conductor"
    ? config.conductorModel
    : config.opencodeModel;
  const model = provider.chatModel(modelName);
  return purpose === "conductor" ? withReasoningExtraction(model) : model;
}
