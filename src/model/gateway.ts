import { config } from "../config/index.js";
import { ProviderRegistry, providerRegistry } from "../providers/ai/registry.js";
import type { AiProviderName } from "../providers/ai/types.js";
import { toLegacyChatMessages } from "./normalize/messages.js";
import {
  runStructuredWithAdapter,
  type ModelProviderAdapter,
} from "./providers/adapter.js";
import { OpenAiResponsesAdapter, runOpenAiResponsesStructured } from "./providers/openai-responses.js";
import { RegistryBackedProviderAdapter } from "./providers/registry-adapter.js";
import {
  gatewayStreamingResolver,
  type GatewayStreamingResolver,
  type ResolvedStreamingModel,
} from "./providers/streaming-resolver.js";
import { modelRegistry } from "./registry.js";
import type {
  AppEmbeddingRequest,
  AppEmbeddingResponse,
  AppJsonSchemaSpec,
  AppModelPurpose,
  AppModelRequest,
  AppModelResponse,
  GatewayProviderId,
  ResolvedModelRoute,
  StructuredOutputResult,
} from "./types.js";
import type { z } from "zod";

export class ModelGateway {
  private readonly chatAdapter: ModelProviderAdapter;
  private readonly responsesAdapter: OpenAiResponsesAdapter;

  constructor(
    private readonly streaming: GatewayStreamingResolver = gatewayStreamingResolver,
    registry: ProviderRegistry = providerRegistry,
    chatAdapter?: ModelProviderAdapter,
    responsesAdapter?: OpenAiResponsesAdapter,
  ) {
    this.chatAdapter = chatAdapter ?? new RegistryBackedProviderAdapter(registry);
    this.responsesAdapter = responsesAdapter ?? new OpenAiResponsesAdapter();
  }

  resolveRoute(purpose: AppModelPurpose, modelId?: string): ResolvedModelRoute {
    return modelRegistry.resolveModelRoute({ purpose, modelId });
  }

  chatModelName(): string {
    return this.resolveRoute("chat").modelId;
  }

  embeddingModelName(): string {
    return this.resolveRoute("embed").modelId;
  }

  chatProviderName(): AiProviderName {
    return this.resolveRoute("chat").provider as AiProviderName;
  }

  embeddingProviderName(): GatewayProviderId {
    return this.resolveRoute("embed").provider;
  }

  async chat(request: AppModelRequest): Promise<AppModelResponse> {
    return this.chatAdapter.chat(request);
  }

  async embed(request: AppEmbeddingRequest): Promise<AppEmbeddingResponse> {
    if (!this.chatAdapter.embed) {
      throw new Error("Active provider does not support embeddings");
    }
    return this.chatAdapter.embed(request);
  }

  async structured<T>(
    request: AppModelRequest,
    schema: z.ZodType<T>,
    jsonSchema: AppJsonSchemaSpec,
  ): Promise<StructuredOutputResult<T>> {
    const route = this.resolveRoute(request.purpose ?? "chat", request.model);
    if (route.capabilities.supportsJsonSchema && config.llmProvider === "openai") {
      return runOpenAiResponsesStructured(request, schema, jsonSchema);
    }
    return runStructuredWithAdapter(this.chatAdapter, request, schema, jsonSchema);
  }

  async structuredJsonSchema(request: AppModelRequest, jsonSchema: AppJsonSchemaSpec): Promise<AppModelResponse> {
    if (config.llmProvider !== "openai") {
      throw new Error("Native JSON schema responses require TALLEI_LLM__PROVIDER=openai");
    }
    return this.responsesAdapter.structuredJsonSchema(request, jsonSchema);
  }

  resolveStreaming(purpose: AppModelPurpose, options?: { userId?: string }): ResolvedStreamingModel {
    return this.streaming.resolve(purpose, options);
  }

  resolveToolChoice(activeToolCount: number): "auto" | "none" | "required" {
    return this.streaming.resolveToolChoice(activeToolCount);
  }

  shouldSendReasoning(surface: ResolvedStreamingModel["surface"]): boolean {
    return this.streaming.shouldSendReasoning(surface);
  }

  toLegacyChatMessages(messages: AppModelRequest["messages"]) {
    return toLegacyChatMessages(messages);
  }
}

export const modelGateway = new ModelGateway();
