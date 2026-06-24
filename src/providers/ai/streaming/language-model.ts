import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { config } from "../../../config/index.js";

export type StreamingPurpose = "builder" | "run_transcript" | "planner";

export function getStreamingLanguageModel(purpose: StreamingPurpose) {
  if (!config.opencodeApiKey) {
    throw new Error("TALLEI_LLM__OPENCODE_API_KEY is required for streaming inference");
  }
  const provider = createOpenAICompatible({
    name: "opencode",
    baseURL: config.opencodeBaseUrl,
    apiKey: config.opencodeApiKey,
  });
  const model = purpose === "builder"
    ? config.loopBuilderModel
    : config.opencodeModel;
  return provider.chatModel(model);
}
