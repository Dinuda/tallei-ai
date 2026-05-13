import OpenAI from "openai";

import { config } from "../../config/index.js";
import {
  CircuitBreakerRegistry,
  composePolicy,
  resolveResiliencePolicies,
  type Policy,
  type RetryPolicy,
} from "../../resilience/index.js";
import { createLogger } from "../../observability/index.js";
import { CircuitOpenError } from "../../shared/errors/provider-errors.js";

import type { AiProvider } from "./ai-provider.js";
import { isRetriableProviderError } from "./errors.js";
import { GoogleGenAI } from "@google/genai";
import { GoogleProvider } from "./google-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAiProvider } from "./openai-provider.js";
import type {
  AiProviderName,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from "./types.js";

interface RegistryOptions {
  readonly chatProviderName: AiProviderName;
  readonly embeddingProviderName: AiProviderName;
}

function combineSignals(left: AbortSignal | undefined, right: AbortSignal | undefined): AbortSignal | undefined {
  if (!left) return right;
  if (!right) return left;

  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  if (left.aborted || right.aborted) {
    abort();
    return controller.signal;
  }

  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });

  return controller.signal;
}

function buildRetryPolicy(base: RetryPolicy | undefined): RetryPolicy | undefined {
  if (!base) return undefined;

  return {
    ...base,
    shouldRetry: (error: unknown) => {
      if (error instanceof CircuitOpenError) {
        return false;
      }
      return isRetriableProviderError(error);
    },
  };
}

function requireOpenAiKeyIfNeeded(providerNames: readonly AiProviderName[]): string {
  if (!providerNames.includes("openai")) {
    return config.openaiApiKey;
  }
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required when provider is openai");
  }
  return config.openaiApiKey;
}

export class ProviderRegistry {
  private readonly providers = new Map<AiProviderName, AiProvider>();
  private readonly chatPolicies = new Map<AiProviderName, Policy<ChatCompletionResponse>>();
  private readonly embedPolicies = new Map<AiProviderName, Policy<EmbeddingResponse>>();
  private readonly chatProviderName: AiProviderName;
  private readonly embeddingProviderName: AiProviderName;

  constructor(options: RegistryOptions = {
    chatProviderName: config.llmProvider,
    embeddingProviderName: config.embeddingProvider,
  }) {
    this.chatProviderName = options.chatProviderName;
    this.embeddingProviderName = options.embeddingProviderName;

    this.initializeProviders(options);
    this.initializePolicies();
  }

  chatModelName(): string {
    if (this.chatProviderName === "ollama") return config.ollamaModel;
    if (this.chatProviderName === "google") return config.googleModel;
    return config.openaiModel;
  }

  embeddingModelName(): string {
    if (this.embeddingProviderName === "google") return config.googleEmbeddingModel;
    return config.embeddingModel;
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const provider = this.getProvider(this.chatProviderName);
    const policy = this.chatPolicies.get(provider.name);
    if (!policy) {
      throw new Error(`Missing chat policy for provider ${provider.name}`);
    }

    return policy.execute((policySignal) => provider.chat({
      ...req,
      signal: combineSignals(req.signal, policySignal),
    }));
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const provider = this.getProvider(this.embeddingProviderName);
    const policy = this.embedPolicies.get(provider.name);
    if (!policy) {
      throw new Error(`Missing embedding policy for provider ${provider.name}`);
    }

    return policy.execute((policySignal) => provider.embed({
      ...req,
      signal: combineSignals(req.signal, policySignal),
    }));
  }

  private getProvider(name: AiProviderName): AiProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`AI provider not registered: ${name}`);
    }
    return provider;
  }

  private initializeProviders(options: RegistryOptions): void {
    const requiredNames: AiProviderName[] = [options.chatProviderName, options.embeddingProviderName];
    const openAiKey = requireOpenAiKeyIfNeeded(requiredNames);

    if (requiredNames.includes("openai")) {
      const openAiProvider = new OpenAiProvider({
        client: new OpenAI({ apiKey: openAiKey }),
        defaultChatModel: config.openaiModel,
        defaultEmbeddingModel: config.embeddingModel,
        defaultEmbeddingDimensions: config.embeddingDims,
        payloadLoggingEnabled: config.openaiPayloadLoggingEnabled,
        payloadLoggingMaxChars: config.openaiPayloadLoggingMaxChars,
        logger: createLogger({ baseFields: { component: "openai_provider" } }),
      });
      this.providers.set(openAiProvider.name, openAiProvider);
    }

    if (requiredNames.includes("ollama")) {
      const ollamaProvider = new OllamaProvider({
        client: new OpenAI({ baseURL: config.ollamaBaseUrl, apiKey: "ollama" }),
        defaultChatModel: config.ollamaModel,
        defaultEmbeddingModel: config.embeddingModel,
      });
      this.providers.set(ollamaProvider.name, ollamaProvider);
    }

    if (requiredNames.includes("google")) {
      const googleProvider = new GoogleProvider({
        client: new GoogleGenAI(config.googleApiKey
          ? { apiKey: config.googleApiKey }
          : { vertexai: true, project: config.googleProjectId, location: config.googleLocation }),
        defaultChatModel: config.googleModel,
        defaultEmbeddingModel: config.googleEmbeddingModel,
        defaultEmbeddingDimensions: config.embeddingDims,
      });
      this.providers.set(googleProvider.name, googleProvider);
    }
  }

  private initializePolicies(): void {
    const resolved = resolveResiliencePolicies(config.nodeEnv);
    const breakerRegistry = new CircuitBreakerRegistry();

    for (const provider of this.providers.values()) {
      this.chatPolicies.set(
        provider.name,
        composePolicy<ChatCompletionResponse>({
          timeoutMs: resolved.chatPolicy.timeoutMs,
          retryPolicy: buildRetryPolicy(resolved.chatPolicy.retry),
          circuitBreaker: breakerRegistry.getOrCreate(`${provider.name}:chat`, {
            failureThreshold: resolved.chatPolicy.circuit.failureThreshold,
            coolOffMs: resolved.chatPolicy.circuit.coolOffMs,
            halfOpenSuccessThreshold: resolved.chatPolicy.circuit.halfOpenSuccessThreshold,
          }),
        })
      );

      this.embedPolicies.set(
        provider.name,
        composePolicy<EmbeddingResponse>({
          timeoutMs: resolved.embedPolicy.timeoutMs,
          retryPolicy: buildRetryPolicy(resolved.embedPolicy.retry),
          circuitBreaker: breakerRegistry.getOrCreate(`${provider.name}:embed`, {
            failureThreshold: resolved.embedPolicy.circuit.failureThreshold,
            coolOffMs: resolved.embedPolicy.circuit.coolOffMs,
            halfOpenSuccessThreshold: resolved.embedPolicy.circuit.halfOpenSuccessThreshold,
          }),
        })
      );
    }
  }
}

export const aiProviderRegistry = new ProviderRegistry();
