import { ProviderRegistry } from "../../providers/ai/registry.js";
import { toLegacyChatMessages } from "../normalize/messages.js";
import { modelRegistry } from "../registry.js";
import type {
  AppEmbeddingRequest,
  AppEmbeddingResponse,
  AppModelRequest,
  AppModelResponse,
  GatewayProviderId,
} from "../types.js";
import type { ModelProviderAdapter } from "./adapter.js";

export class RegistryBackedProviderAdapter implements ModelProviderAdapter {
  readonly id: GatewayProviderId;

  constructor(private readonly registry: ProviderRegistry) {
    this.id = modelRegistry.resolveModelRoute({ purpose: "chat" }).provider;
  }

  async chat(request: AppModelRequest): Promise<AppModelResponse> {
    const route = modelRegistry.resolveModelRoute({
      purpose: request.purpose ?? "chat",
      modelId: request.model,
    });
    const response = await this.registry.chat({
      model: route.modelId,
      messages: toLegacyChatMessages(request.messages),
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      responseFormat: request.responseFormat === "json" ? "json_object" : "text",
      signal: request.signal,
    });
    return {
      text: response.text,
      finishReason: response.finishReason,
      model: response.model,
      provider: route.provider,
      usage: response.usage,
    };
  }

  async embed(request: AppEmbeddingRequest): Promise<AppEmbeddingResponse> {
    const route = modelRegistry.resolveModelRoute({
      purpose: "embed",
      modelId: request.model,
    });
    const response = await this.registry.embed({
      model: route.modelId,
      input: request.input,
      dimensions: request.dimensions,
      signal: request.signal,
    });
    return {
      vectors: response.vectors.map((vector) => [...vector]),
      model: response.model,
      provider: route.provider,
    };
  }
}
