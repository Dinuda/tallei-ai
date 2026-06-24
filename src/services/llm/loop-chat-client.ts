import OpenAI from "openai";

import { config } from "../../config/index.js";

export function createLoopChatOpenAiSdk(): OpenAI {
  if (config.llmProvider === "opencode" && config.opencodeApiKey) {
    return new OpenAI({
      apiKey: config.opencodeApiKey,
      baseURL: config.opencodeBaseUrl,
    });
  }
  if (!config.openaiApiKey) {
    throw new Error("OpenAI API key is not configured");
  }
  return new OpenAI({ apiKey: config.openaiApiKey });
}
