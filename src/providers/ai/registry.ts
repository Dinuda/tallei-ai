import OpenAI from "openai";

import { config } from "../../config/index.js";
import {
  createPooledLlmFetch,
  getNvidiaApiKeyPool,
  getOpenAiApiKeyPool,
  getOpenCodeApiKeyPool,
} from "../../services/llm/api-key-pool.js";
import {
  CircuitBreakerRegistry,
  composePolicy,
  resolveResiliencePolicies,
  type Policy,
  type RetryPolicy,
} from "../../resilience/index.js";
import { createLogger } from "../../observability/index.js";
import { CircuitOpenError } from "../../shared/errors/provider-errors.js";

import { modelRegistry } from "../../model/registry.js";
import type { AiProvider } from "./ai-provider.js";
import { isRetriableProviderError } from "./errors.js";
import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "./anthropic-provider.js";
import { GoogleProvider } from "./google-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { NvidiaProvider } from "./nvidia-provider.js";
import { OpenCodeProvider } from "./opencode-provider.js";
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

function requireOpenAiKeyIfNeeded(providerNames: readonly AiProviderName[]): void {
  if (providerNames.includes("openai") && getOpenAiApiKeyPool().size === 0) {
    throw new Error("TALLEI_LLM__OPENAI_API_KEY is required when provider is openai");
  }
}

function requireOpenCodeKeyIfNeeded(providerNames: readonly AiProviderName[]): void {
  if (providerNames.includes("opencode") && getOpenCodeApiKeyPool().size === 0) {
    throw new Error("TALLEI_LLM__OPENCODE_API_KEY (or TALLEI_LLM__OPENCODE_API_KEYS) is required when TALLEI_LLM__PROVIDER=opencode");
  }
}

function requireNvidiaKeyIfNeeded(providerNames: readonly AiProviderName[]): void {
  if (providerNames.includes("nvidia") && getNvidiaApiKeyPool().size === 0) {
    throw new Error("TALLEI_LLM__NVIDIA_API_KEY (or NIM_API_KEY) is required when TALLEI_LLM__PROVIDER=nvidia");
  }
}

function requireAnthropicKeyIfNeeded(providerNames: readonly AiProviderName[]): void {
  if (providerNames.includes("anthropic") && !config.anthropicApiKey.trim()) {
    throw new Error("TALLEI_LLM__ANTHROPIC_API_KEY is required when TALLEI_LLM__PROVIDER=anthropic");
  }
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
    return modelRegistry.resolveModelRoute({ purpose: "chat" }).modelId;
  }

  embeddingModelName(): string {
    return modelRegistry.resolveModelRoute({ purpose: "embed" }).modelId;
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

  async chatDirect(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const provider = this.getProvider(this.chatProviderName);
    return provider.chat(req);
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
    requireOpenAiKeyIfNeeded(requiredNames);
    requireOpenCodeKeyIfNeeded(requiredNames);
    requireNvidiaKeyIfNeeded(requiredNames);
    requireAnthropicKeyIfNeeded(requiredNames);

    if (requiredNames.includes("openai")) {
      const openAiPool = getOpenAiApiKeyPool();
      const openAiProvider = new OpenAiProvider({
        client: new OpenAI({
          apiKey: openAiPool.pickKey(),
          fetch: createPooledLlmFetch(openAiPool, "openai"),
        }),
        defaultChatModel: config.openaiModel,
        defaultEmbeddingModel: config.embeddingModel,
        defaultEmbeddingDimensions: config.embeddingDims,
        payloadLoggingEnabled: config.openaiPayloadLoggingEnabled,
        payloadLoggingMaxChars: config.openaiPayloadLoggingMaxChars,
        logger: createLogger({ baseFields: { component: "openai_provider" } }),
      });
      this.providers.set(openAiProvider.name, openAiProvider);
    }

    if (requiredNames.includes("opencode")) {
      const openCodePool = getOpenCodeApiKeyPool();
      const openCodeProvider = new OpenCodeProvider({
        client: new OpenAI({
          baseURL: config.opencodeBaseUrl,
          apiKey: openCodePool.pickKey(),
          fetch: createPooledLlmFetch(openCodePool, "opencode"),
        }),
        defaultChatModel: config.opencodeModel,
      });
      this.providers.set(openCodeProvider.name, openCodeProvider);
    }

    if (requiredNames.includes("nvidia")) {
      const nvidiaPool = getNvidiaApiKeyPool();
      const nvidiaProvider = new NvidiaProvider({
        client: new OpenAI({
          baseURL: config.nvidiaBaseUrl,
          apiKey: nvidiaPool.pickKey(),
          fetch: createPooledLlmFetch(nvidiaPool, "nvidia"),
        }),
        defaultChatModel: config.nvidiaModel,
      });
      this.providers.set(nvidiaProvider.name, nvidiaProvider);
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

    if (requiredNames.includes("anthropic")) {
      const anthropicProvider = new AnthropicProvider({
        client: new Anthropic({ apiKey: config.anthropicApiKey }),
        defaultChatModel: config.anthropicModel,
      });
      this.providers.set(anthropicProvider.name, anthropicProvider);
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

export const providerRegistry = new ProviderRegistry();
