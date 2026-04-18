import OpenAI from "openai";

import type { AiProvider } from "./ai-provider.js";
import { mapProviderError } from "./errors.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderCapabilities,
} from "./types.js";

interface OllamaProviderOptions {
  readonly client: OpenAI;
  readonly defaultChatModel: string;
  readonly defaultEmbeddingModel: string;
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

export class OllamaProvider implements AiProvider {
  readonly name = "ollama" as const;

  private readonly client: OpenAI;
  private readonly defaultChatModel: string;
  private readonly defaultEmbeddingModel: string;

  constructor(options: OllamaProviderOptions) {
    this.client = options.client;
    this.defaultChatModel = options.defaultChatModel;
    this.defaultEmbeddingModel = options.defaultEmbeddingModel;
  }

  capabilities(): ProviderCapabilities {
    return { chat: true, embed: true };
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: req.model ?? this.defaultChatModel,
          messages: [...req.messages],
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          response_format: req.responseFormat === "json_object" ? { type: "json_object" } : undefined,
        },
        req.signal ? { signal: req.signal } : undefined
      );

      const text = normalizeChatText(response.choices[0]?.message?.content);
      return {
        text,
        model: response.model,
        finishReason: response.choices[0]?.finish_reason ?? null,
      };
    } catch (error) {
      throw mapProviderError(this.name, error);
    }
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    try {
      const input = typeof req.input === "string" ? req.input : [...req.input];
      const response = await this.client.embeddings.create(
        {
          model: req.model ?? this.defaultEmbeddingModel,
          input,
        },
        req.signal ? { signal: req.signal } : undefined
      );

      return {
        vectors: response.data.map((entry) => entry.embedding),
        model: response.model,
      };
    } catch (error) {
      throw mapProviderError(this.name, error);
    }
  }
}
