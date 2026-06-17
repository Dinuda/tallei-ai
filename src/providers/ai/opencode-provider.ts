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

interface OpenCodeProviderOptions {
  readonly client: OpenAI;
  readonly defaultChatModel: string;
}

function normalizeChatText(value: unknown): string {
  if (typeof value === "string") return value;
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

/** OpenCode Go — OpenAI-compatible chat completions at opencode.ai/zen/go/v1 */
export class OpenCodeProvider implements AiProvider {
  readonly name = "opencode" as const;

  private readonly client: OpenAI;
  private readonly defaultChatModel: string;

  constructor(options: OpenCodeProviderOptions) {
    this.client = options.client;
    this.defaultChatModel = options.defaultChatModel;
  }

  capabilities(): ProviderCapabilities {
    return { chat: true, embed: false };
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
        req.signal ? { signal: req.signal } : undefined,
      );

      return {
        text: normalizeChatText(response.choices[0]?.message?.content),
        model: response.model,
        finishReason: response.choices[0]?.finish_reason ?? null,
        usage: {
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
          totalTokens: response.usage?.total_tokens,
        },
      };
    } catch (error) {
      throw mapProviderError(this.name, error);
    }
  }

  async embed(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error("OpenCode Go does not provide embeddings. Set TALLEI_EMBED__PROVIDER to ollama or openai.");
  }
}
