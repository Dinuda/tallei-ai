import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import OpenAI from "openai";

import { config } from "../../config/index.js";
import {
  coerceChatModelForLocalMode,
  isOpenCodeZenChatCompletionsModel,
  resolveChatModelForCompatibleProvider,
} from "./chat-model-routing.js";
import { isLoopBuilderReasoningModel } from "../conductor/llm/openai-chat.js";

export function isLocalLoopChatMode(): boolean {
  return config.localModelMode;
}

export function resolveLocalLoopChatModel(builderOverride?: string): string {
  const ollamaEnv = process.env.TALLEI_LLM__OLLAMA_MODEL?.trim();
  const localDefault = ollamaEnv || config.ollamaModel;
  const override = builderOverride?.trim();
  if (override) {
    return coerceChatModelForLocalMode(override, true, localDefault);
  }
  return localDefault;
}

export function resolveConfiguredChatModel(overrideEnv?: string): string {
  const override = overrideEnv?.trim();
  if (override) {
    if (config.localModelMode) {
      return coerceChatModelForLocalMode(override, true, config.ollamaModel);
    }
    if (config.llmProvider === "opencode") {
      return resolveChatModelForCompatibleProvider(override, config.opencodeModel);
    }
    return override;
  }
  if (config.llmProvider === "opencode") return config.opencodeModel;
  return config.openaiModel;
}

export function isOpenCodeLoopChatMode(): boolean {
  return config.llmProvider === "opencode" && !config.localModelMode;
}

export function createLoopChatOpenAiSdk(): OpenAI {
  if (config.localModelMode) {
    return new OpenAI({ baseURL: config.ollamaBaseUrl, apiKey: "ollama" });
  }
  if (isOpenCodeLoopChatMode()) {
    if (!config.opencodeApiKey) {
      throw new Error("TALLEI_LLM__OPENCODE_API_KEY is required when TALLEI_LLM__PROVIDER=opencode");
    }
    return new OpenAI({ baseURL: config.opencodeBaseUrl, apiKey: config.opencodeApiKey });
  }
  const apiKey = process.env.TALLEI_LLM__OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("Loop chat requires OPENAI_API_KEY (or TALLEI_LLM__OPENAI_API_KEY) when not in local model mode.");
  }
  return new OpenAI({ apiKey });
}

function requireOpenCodeApiKey(): string {
  if (!config.opencodeApiKey) {
    throw new Error("TALLEI_LLM__OPENCODE_API_KEY is required when TALLEI_LLM__PROVIDER=opencode");
  }
  return config.opencodeApiKey;
}

function createOpenCodeZenChatCompletionsProvider() {
  return createOpenAICompatible({
    name: "opencode",
    baseURL: config.opencodeBaseUrl,
    apiKey: requireOpenCodeApiKey(),
    includeUsage: true,
  });
}

function createOpenCodeZenResponsesProvider() {
  return createOpenAI({
    baseURL: config.opencodeBaseUrl,
    apiKey: requireOpenCodeApiKey(),
  });
}

export function createLoopChatAiSdkProvider() {
  if (config.localModelMode) {
    return createOpenAI({ baseURL: config.ollamaBaseUrl, apiKey: "ollama" });
  }
  if (isOpenCodeLoopChatMode()) {
    return createOpenCodeZenResponsesProvider();
  }
  const apiKey = process.env.TALLEI_LLM__OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("Loop chat requires OPENAI_API_KEY (or TALLEI_LLM__OPENAI_API_KEY) when not in local model mode.");
  }
  return createOpenAI({ apiKey });
}

/** Loop builder + spec-run streaming: chat completions for Ollama/OpenCode Zen; Responses API for hosted reasoning models. */
export function resolveLoopChatLanguageModel(modelId: string): LanguageModel {
  if (isOpenCodeLoopChatMode()) {
    if (isOpenCodeZenChatCompletionsModel(modelId)) {
      return createOpenCodeZenChatCompletionsProvider().chatModel(modelId);
    }
    return createOpenCodeZenResponsesProvider()(modelId);
  }
  const provider = createLoopChatAiSdkProvider();
  if (config.localModelMode || !isLoopBuilderReasoningModel(modelId)) {
    return provider.chat(modelId);
  }
  return provider(modelId);
}
