import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

import { config } from "../../config/index.js";
import {
  createPooledLlmFetch,
  getNvidiaApiKeyPool,
  getOpenAiApiKeyPool,
  getOpenCodeApiKeyPool,
} from "../../services/llm/api-key-pool.js";
import { looksLikeHostedOpenAiModel } from "../routing.js";
import { modelRegistry } from "../registry.js";
import type { AppModelPurpose, ModelSurface, ResolvedModelRoute } from "../types.js";

export type StreamingProviderOptions = {
  openai?: {
    reasoningEffort?: string;
    reasoningSummary?: "auto" | "detailed";
    include?: Array<"reasoning.encrypted_content">;
  };
};

export type ResolvedStreamingModel = {
  model: LanguageModel;
  modelId: string;
  surface: ModelSurface;
  provider: ResolvedModelRoute["provider"];
  providerOptions?: StreamingProviderOptions;
};

function withReasoningExtraction(model: LanguageModel): LanguageModel {
  let wrapped: LanguageModel = model;
  for (const tagName of ["think", "thinking"] as const) {
    wrapped = wrapLanguageModel({
      model: wrapped as Parameters<typeof wrapLanguageModel>[0]["model"],
      middleware: extractReasoningMiddleware({ tagName }),
    }) as LanguageModel;
  }
  return wrapped;
}

function toStreamingProviderOptions(route: ResolvedModelRoute): StreamingProviderOptions | undefined {
  if (!route.providerOptions) return undefined;
  return route.providerOptions as StreamingProviderOptions;
}

export class GatewayStreamingResolver {
  resolveModelName(purpose: AppModelPurpose): string {
    return modelRegistry.resolveModelRoute({ purpose }).modelId;
  }

  resolveToolChoice(activeToolCount: number): "auto" | "none" | "required" {
    return modelRegistry.resolveConductorToolChoice(activeToolCount);
  }

  shouldApplyReasoningTagExtraction(provider: ResolvedModelRoute["provider"], surface: ModelSurface, purpose: AppModelPurpose): boolean {
    return modelRegistry.shouldApplyReasoningTagExtraction(provider, surface, purpose);
  }

  shouldSendReasoning(surface: ModelSurface): boolean {
    return modelRegistry.shouldSendReasoning(surface);
  }

  resolve(purpose: AppModelPurpose, options?: { userId?: string }): ResolvedStreamingModel {
    const route = modelRegistry.resolveModelRoute({ purpose });
    const userId = options?.userId;

    if (route.provider === "opencode") {
      const model = this.createOpenCodeStreamingModel(route.modelId, userId);
      const wrapped = this.shouldApplyReasoningTagExtraction(route.provider, route.capabilities.surface, purpose)
        ? withReasoningExtraction(model)
        : model;
      return {
        model: wrapped,
        modelId: route.modelId,
        surface: "opencode",
        provider: route.provider,
      };
    }

    if (route.provider === "nvidia") {
      const model = this.createNvidiaStreamingModel(route.modelId, userId);
      const wrapped = this.shouldApplyReasoningTagExtraction(route.provider, route.capabilities.surface, purpose)
        ? withReasoningExtraction(model)
        : model;
      return {
        model: wrapped,
        modelId: route.modelId,
        surface: "chat",
        provider: route.provider,
      };
    }

    if (route.provider !== "openai") {
      throw new Error(`Streaming is not configured for provider ${route.provider}`);
    }

    const { model: baseModel, surface } = this.createOpenAiStreamingModel(route.modelId, userId);
    const applyTagExtraction = this.shouldApplyReasoningTagExtraction(route.provider, surface, purpose);
    const model = applyTagExtraction ? withReasoningExtraction(baseModel) : baseModel;
    const providerOptions = toStreamingProviderOptions(route);
    return providerOptions
      ? { model, modelId: route.modelId, surface, provider: route.provider, providerOptions }
      : { model, modelId: route.modelId, surface, provider: route.provider };
  }

  private createOpenAiStreamingModel(
    modelName: string,
    userId?: string,
  ): { model: LanguageModel; surface: "responses" | "chat" } {
    const pool = getOpenAiApiKeyPool();
    if (pool.size === 0) {
      throw new Error("TALLEI_LLM__OPENAI_API_KEY (or TALLEI_LLM__OPENAI_API_KEYS) is required for streaming inference");
    }
    const provider = createOpenAI({
      apiKey: pool.pickKey(userId),
      fetch: createPooledLlmFetch(pool, "openai", userId),
    });
    if (looksLikeHostedOpenAiModel(modelName)) {
      return { model: provider.responses(modelName), surface: "responses" };
    }
    return { model: provider.chat(modelName), surface: "chat" };
  }

  private createOpenCodeStreamingModel(modelName: string, userId?: string): LanguageModel {
    const pool = getOpenCodeApiKeyPool();
    if (pool.size === 0) {
      throw new Error("TALLEI_LLM__OPENCODE_API_KEY (or TALLEI_LLM__OPENCODE_API_KEYS) is required for streaming inference");
    }
    const provider = createOpenAICompatible({
      name: "opencode",
      baseURL: config.opencodeBaseUrl,
      apiKey: pool.pickKey(userId),
      fetch: createPooledLlmFetch(pool, "opencode", userId),
    });
    return provider.chatModel(modelName);
  }

  private createNvidiaStreamingModel(modelName: string, userId?: string): LanguageModel {
    const pool = getNvidiaApiKeyPool();
    if (pool.size === 0) {
      throw new Error("TALLEI_LLM__NVIDIA_API_KEY (or NIM_API_KEY) is required for streaming inference");
    }
    const provider = createOpenAICompatible({
      name: "nim",
      baseURL: config.nvidiaBaseUrl,
      apiKey: pool.pickKey(userId),
      fetch: createPooledLlmFetch(pool, "nvidia", userId),
    });
    return provider.chatModel(modelName);
  }
}

export const gatewayStreamingResolver = new GatewayStreamingResolver();
