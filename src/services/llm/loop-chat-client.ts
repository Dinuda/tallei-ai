import OpenAI from "openai";

import { config } from "../../config/index.js";
import {
  createPooledLlmFetch,
  getOpenAiApiKeyPool,
  getOpenCodeApiKeyPool,
} from "./api-key-pool.js";

export type LoopChatClientOptions = {
  userId?: string;
};

export function createLoopChatOpenAiSdk(options?: LoopChatClientOptions): OpenAI {
  if (config.llmProvider === "opencode") {
    const pool = getOpenCodeApiKeyPool();
    if (pool.size === 0) {
      throw new Error("TALLEI_LLM__OPENCODE_API_KEY (or TALLEI_LLM__OPENCODE_API_KEYS) is required");
    }
    return new OpenAI({
      apiKey: pool.pickKey(options?.userId),
      baseURL: config.opencodeBaseUrl,
      fetch: createPooledLlmFetch(pool, "opencode", options?.userId),
    });
  }

  const pool = getOpenAiApiKeyPool();
  if (pool.size === 0) {
    throw new Error("TALLEI_LLM__OPENAI_API_KEY (or TALLEI_LLM__OPENAI_API_KEYS) is required");
  }
  return new OpenAI({
    apiKey: pool.pickKey(options?.userId),
    fetch: createPooledLlmFetch(pool, "openai", options?.userId),
  });
}
