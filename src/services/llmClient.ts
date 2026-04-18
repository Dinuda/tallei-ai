/**
 * Shared LLM client factory.
 *
 * In local mode, defaults to Ollama. Set LLM_PROVIDER=openai to force OpenAI.
 * Ollama exposes an OpenAI-compatible API so no extra SDK is needed.
 */

import OpenAI from "openai";
import { config } from "../config.js";

function buildClient(): OpenAI {
  if (config.llmProvider === "ollama") {
    return new OpenAI({
      baseURL: config.ollamaBaseUrl,
      apiKey: "ollama", // required by the SDK but ignored by Ollama
    });
  }
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
  }
  return new OpenAI({ apiKey: config.openaiApiKey });
}

/** Pre-built client — reuse across requests (stateless). */
export const llm = buildClient();

/** Model name for the active provider. */
export const llmModel =
  config.llmProvider === "ollama" ? config.ollamaModel : config.openaiModel;
