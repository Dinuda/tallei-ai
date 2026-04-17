/**
 * Shared LLM client factory.
 *
 * Defaults to OpenAI. Set LLM_PROVIDER=ollama to route generation calls
 * through a local Ollama instance instead (recommended: qwen2.5:7b).
 * Ollama exposes an OpenAI-compatible API so no extra SDK is needed.
 *
 * Embeddings are NOT affected — they always go through OpenAI since
 * changing the embedding model would require re-indexing Qdrant.
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
  return new OpenAI({ apiKey: config.openaiApiKey });
}

/** Pre-built client — reuse across requests (stateless). */
export const llm = buildClient();

/** Model name for the active provider. */
export const llmModel =
  config.llmProvider === "ollama" ? config.ollamaModel : "gpt-4o-mini";
