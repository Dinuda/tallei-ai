import OpenAI from "openai";

import { mapProviderError } from "../../providers/ai/errors.js";
import type { ProviderName } from "../../shared/errors/provider-errors.js";
import type {
  AppEmbeddingRequest,
  AppEmbeddingResponse,
  AppModelRequest,
  AppModelResponse,
  GatewayProviderId,
} from "../types.js";
import { toLegacyChatMessages } from "../normalize/messages.js";
import type { ModelProviderAdapter } from "./adapter.js";

export type OpenAiCompatibleAdapterOptions = {
  providerId: GatewayProviderId;
  client: OpenAI;
  defaultChatModel: string;
  defaultEmbeddingModel?: string;
  supportsEmbeddings?: boolean;
  supportsForcedToolChoice?: boolean;
};

/** Shared adapter for OpenRouter, NVIDIA NIM, OpenCode, and other OpenAI-compatible APIs. */
export class OpenAiCompatibleProviderAdapter implements ModelProviderAdapter {
  readonly id: GatewayProviderId;

  constructor(private readonly options: OpenAiCompatibleAdapterOptions) {
    this.id = options.providerId;
  }

  async chat(request: AppModelRequest): Promise<AppModelResponse> {
    try {
      const response = await this.options.client.chat.completions.create(
        {
          model: request.model ?? this.options.defaultChatModel,
          messages: toLegacyChatMessages(request.messages),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined,
        },
        request.signal ? { signal: request.signal } : undefined,
      );
      const text = typeof response.choices[0]?.message?.content === "string"
        ? response.choices[0]?.message?.content
        : "";
      return {
        text,
        finishReason: response.choices[0]?.finish_reason ?? null,
        model: response.model,
        provider: this.id,
        usage: {
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
          totalTokens: response.usage?.total_tokens,
        },
      };
    } catch (error) {
      throw mapProviderError(this.mapProviderName(), error);
    }
  }

  async embed(request: AppEmbeddingRequest): Promise<AppEmbeddingResponse> {
    if (!this.options.supportsEmbeddings || !this.options.defaultEmbeddingModel) {
      throw new Error(`Provider ${this.id} does not support embeddings`);
    }
    const input = typeof request.input === "string" ? request.input : [...request.input];
    const response = await this.options.client.embeddings.create(
      {
        model: request.model ?? this.options.defaultEmbeddingModel,
        input,
        dimensions: request.dimensions,
      },
      request.signal ? { signal: request.signal } : undefined,
    );
    return {
      vectors: response.data.map((entry) => entry.embedding),
      model: response.model,
      provider: this.id,
    };
  }

  private mapProviderName(): ProviderName {
    if (this.id === "openrouter" || this.id === "nvidia" || this.id === "anthropic") return "openai";
    return this.id;
  }
}
