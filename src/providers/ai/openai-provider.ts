import OpenAI from "openai";

import type { Logger } from "../../observability/index.js";
import type { AiProvider } from "./ai-provider.js";
import { mapProviderError } from "./errors.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderCapabilities,
} from "./types.js";

interface OpenAiProviderOptions {
  readonly client: OpenAI;
  readonly defaultChatModel: string;
  readonly defaultEmbeddingModel: string;
  readonly defaultEmbeddingDimensions: number;
  readonly payloadLoggingEnabled: boolean;
  readonly payloadLoggingMaxChars: number;
  readonly logger: Logger;
}

function normalizeChatText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const text = part && typeof part === "object" ? (part as { text?: unknown }).text : null;
        return typeof text === "string" ? text : "";
      })
      .join("")
      .trim();
  }
  return "";
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai" as const;

  private static readonly REDACTED = "[REDACTED]";
  private static readonly JSON_OBJECT_HINT =
    "Return a valid JSON object response only.";

  private readonly client: OpenAI;
  private readonly defaultChatModel: string;
  private readonly defaultEmbeddingModel: string;
  private readonly defaultEmbeddingDimensions: number;
  private readonly payloadLoggingEnabled: boolean;
  private readonly payloadLoggingMaxChars: number;
  private readonly logger: Logger;

  constructor(options: OpenAiProviderOptions) {
    this.client = options.client;
    this.defaultChatModel = options.defaultChatModel;
    this.defaultEmbeddingModel = options.defaultEmbeddingModel;
    this.defaultEmbeddingDimensions = options.defaultEmbeddingDimensions;
    this.payloadLoggingEnabled = options.payloadLoggingEnabled;
    this.payloadLoggingMaxChars = options.payloadLoggingMaxChars;
    this.logger = options.logger;
  }

  capabilities(): ProviderCapabilities {
    return { chat: true, embed: true };
  }

  private clip(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    if (value.length <= this.payloadLoggingMaxChars) return value;
    return value.slice(0, this.payloadLoggingMaxChars);
  }

  private readErrorDetails(error: unknown): {
    readonly status: number | null;
    readonly code: string | null;
    readonly message: string;
    readonly name: string;
  } {
    const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    const statusRaw = record["status"];
    const codeRaw = record["code"];
    const message = error instanceof Error ? error.message : String(error ?? "Unknown provider error");
    const name = error instanceof Error ? error.name : "UnknownError";
    return {
      status: typeof statusRaw === "number" ? statusRaw : null,
      code: typeof codeRaw === "string" ? this.clip(codeRaw) : null,
      message: this.clip(message) ?? "Unknown provider error",
      name: this.clip(name) ?? "UnknownError",
    };
  }

  private logChatCall(input: {
    readonly req: ChatCompletionRequest;
    readonly model: string;
    readonly latencyMs: number;
    readonly success: boolean;
    readonly response?: {
      readonly model: string;
      readonly finishReason: string | null;
      readonly textLength: number;
      readonly usage?: {
        readonly promptTokens?: number;
        readonly completionTokens?: number;
        readonly totalTokens?: number;
      };
    };
    readonly error?: unknown;
  }): void {
    if (!this.payloadLoggingEnabled) return;
    const requestMessages = input.req.messages.map((message) => ({
      role: message.role,
      content: OpenAiProvider.REDACTED,
      content_length: message.content.length,
    }));

    const responsePayload = input.response
      ? {
          model: this.clip(input.response.model),
          finish_reason: this.clip(input.response.finishReason),
          text: OpenAiProvider.REDACTED,
          text_length: input.response.textLength,
        }
      : null;

    const usage = input.response?.usage ?? {};
    const errorDetails = input.error ? this.readErrorDetails(input.error) : null;

    this.logger.info("OpenAI provider call", {
      event: "openai_provider_call",
      provider: "openai",
      capability: "chat",
      model: this.clip(input.model),
      latency_ms: Number(input.latencyMs.toFixed(2)),
      success: input.success,
      request: {
        model: this.clip(input.model),
        temperature: input.req.temperature ?? null,
        max_tokens: input.req.maxTokens ?? null,
        response_format: input.req.responseFormat ?? "text",
        messages: requestMessages,
      },
      response: responsePayload,
      token_usage: {
        prompt_tokens: usage.promptTokens ?? null,
        completion_tokens: usage.completionTokens ?? null,
        total_tokens: usage.totalTokens ?? null,
      },
      error: errorDetails,
    });
  }

  private logEmbedCall(input: {
    readonly req: EmbeddingRequest;
    readonly model: string;
    readonly latencyMs: number;
    readonly success: boolean;
    readonly response?: {
      readonly model: string;
      readonly vectorCount: number;
      readonly vectorDimensions: number;
      readonly usage?: {
        readonly promptTokens?: number;
        readonly totalTokens?: number;
      };
    };
    readonly error?: unknown;
  }): void {
    if (!this.payloadLoggingEnabled) return;
    const items = (typeof input.req.input === "string" ? [input.req.input] : [...input.req.input]).map((value) => ({
      content: OpenAiProvider.REDACTED,
      content_length: value.length,
    }));
    const usage = input.response?.usage ?? {};
    const errorDetails = input.error ? this.readErrorDetails(input.error) : null;

    this.logger.info("OpenAI provider call", {
      event: "openai_provider_call",
      provider: "openai",
      capability: "embed",
      model: this.clip(input.model),
      latency_ms: Number(input.latencyMs.toFixed(2)),
      success: input.success,
      request: {
        model: this.clip(input.model),
        dimensions: input.req.dimensions ?? this.defaultEmbeddingDimensions,
        input_count: items.length,
        inputs: items,
      },
      response: input.response
        ? {
            model: this.clip(input.response.model),
            vector_count: input.response.vectorCount,
            vector_dimensions: input.response.vectorDimensions,
          }
        : null,
      token_usage: {
        prompt_tokens: usage.promptTokens ?? null,
        completion_tokens: null,
        total_tokens: usage.totalTokens ?? null,
      },
      error: errorDetails,
    });
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const model = req.model ?? this.defaultChatModel;
    const effectiveReq = this.withJsonObjectHint(req);
    const startedAt = process.hrtime.bigint();
    try {
      const response = await this.client.chat.completions.create(
        {
          model,
          messages: [...effectiveReq.messages],
          temperature: effectiveReq.temperature,
          max_tokens: effectiveReq.maxTokens,
          response_format: effectiveReq.responseFormat === "json_object" ? { type: "json_object" } : undefined,
        },
        effectiveReq.signal ? { signal: effectiveReq.signal } : undefined
      );

      const text = normalizeChatText(response.choices[0]?.message?.content);
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      this.logChatCall({
        req: effectiveReq,
        model,
        latencyMs,
        success: true,
        response: {
          model: response.model,
          finishReason: response.choices[0]?.finish_reason ?? null,
          textLength: text.length,
          usage: {
            promptTokens: response.usage?.prompt_tokens,
            completionTokens: response.usage?.completion_tokens,
            totalTokens: response.usage?.total_tokens,
          },
        },
      });
      return {
        text,
        model: response.model,
        finishReason: response.choices[0]?.finish_reason ?? null,
      };
    } catch (error) {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      this.logChatCall({
        req: effectiveReq,
        model,
        latencyMs,
        success: false,
        error,
      });
      throw mapProviderError(this.name, error);
    }
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = req.model ?? this.defaultEmbeddingModel;
    const startedAt = process.hrtime.bigint();
    try {
      const input = typeof req.input === "string" ? req.input : [...req.input];
      const response = await this.client.embeddings.create(
        {
          model,
          input,
          dimensions: req.dimensions ?? this.defaultEmbeddingDimensions,
        },
        req.signal ? { signal: req.signal } : undefined
      );

      const vectorCount = response.data.length;
      const vectorDimensions = response.data[0]?.embedding?.length ?? 0;
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      this.logEmbedCall({
        req,
        model,
        latencyMs,
        success: true,
        response: {
          model: response.model,
          vectorCount,
          vectorDimensions,
          usage: {
            promptTokens: response.usage?.prompt_tokens,
            totalTokens: response.usage?.total_tokens,
          },
        },
      });
      return {
        vectors: response.data.map((entry) => entry.embedding),
        model: response.model,
      };
    } catch (error) {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      this.logEmbedCall({
        req,
        model,
        latencyMs,
        success: false,
        error,
      });
      throw mapProviderError(this.name, error);
    }
  }

  private withJsonObjectHint(req: ChatCompletionRequest): ChatCompletionRequest {
    if (req.responseFormat !== "json_object") {
      return req;
    }

    const hasJsonWord = req.messages.some((message) => /\bjson\b/i.test(message.content));
    if (hasJsonWord) {
      return req;
    }

    const messages: readonly ChatMessage[] = [
      { role: "system", content: OpenAiProvider.JSON_OBJECT_HINT },
      ...req.messages,
    ];
    return { ...req, messages };
  }
}
