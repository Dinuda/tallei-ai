import Anthropic from "@anthropic-ai/sdk";

import type { AiProvider } from "./ai-provider.js";
import { mapProviderError } from "./errors.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderCapabilities,
} from "./types.js";

interface AnthropicProviderOptions {
  readonly client: Anthropic;
  readonly defaultChatModel: string;
}

function extractText(content: Anthropic.Messages.Message["content"]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;

  private readonly client: Anthropic;
  private readonly defaultChatModel: string;

  constructor(options: AnthropicProviderOptions) {
    this.client = options.client;
    this.defaultChatModel = options.defaultChatModel;
  }

  capabilities(): ProviderCapabilities {
    return { chat: true, embed: false };
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    try {
      const system = req.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n")
        .trim();
      const messages = req.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" as const : "user" as const,
          content: message.content,
        }));

      const response = await this.client.messages.create(
        {
          model: req.model ?? this.defaultChatModel,
          max_tokens: req.maxTokens ?? 4096,
          ...(system ? { system } : {}),
          messages,
          temperature: req.temperature,
        },
        req.signal ? { signal: req.signal } : undefined,
      );

      return {
        text: extractText(response.content),
        model: response.model,
        finishReason: response.stop_reason,
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        },
      };
    } catch (error) {
      throw mapProviderError(this.name, error);
    }
  }

  async embed(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error("Anthropic does not provide embeddings in Tallei. Set TALLEI_EMBED__PROVIDER to openai, ollama, or google.");
  }
}
