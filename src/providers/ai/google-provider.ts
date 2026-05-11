import { GoogleGenAI, type ContentListUnion } from "@google/genai";

import type { AiProvider } from "./ai-provider.js";
import { mapProviderError } from "./errors.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderCapabilities,
} from "./types.js";

interface GoogleProviderOptions {
  readonly client: GoogleGenAI;
  readonly defaultChatModel: string;
  readonly defaultEmbeddingModel: string;
  readonly defaultEmbeddingDimensions: number;
}

function messagesToContents(messages: ChatCompletionRequest["messages"]): ContentListUnion {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.role === "system" ? `System: ${message.content}` : message.content }],
  }));
}

function finishReasonFromResponse(response: unknown): string | null {
  const candidates = response && typeof response === "object"
    ? (response as { candidates?: Array<{ finishReason?: string }> }).candidates
    : null;
  return candidates?.[0]?.finishReason ?? null;
}

export class GoogleProvider implements AiProvider {
  readonly name = "google" as const;

  private readonly client: GoogleGenAI;
  private readonly defaultChatModel: string;
  private readonly defaultEmbeddingModel: string;
  private readonly defaultEmbeddingDimensions: number;

  constructor(options: GoogleProviderOptions) {
    this.client = options.client;
    this.defaultChatModel = options.defaultChatModel;
    this.defaultEmbeddingModel = options.defaultEmbeddingModel;
    this.defaultEmbeddingDimensions = options.defaultEmbeddingDimensions;
  }

  capabilities(): ProviderCapabilities {
    return { chat: true, embed: true };
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const model = req.model ?? this.defaultChatModel;
    try {
      const response = await this.client.models.generateContent({
        model,
        contents: messagesToContents(req.messages),
        config: {
          temperature: req.temperature,
          maxOutputTokens: req.maxTokens,
          responseMimeType: req.responseFormat === "json_object" ? "application/json" : undefined,
        },
      });

      return {
        text: response.text ?? "",
        model,
        finishReason: finishReasonFromResponse(response),
      };
    } catch (error) {
      throw mapProviderError(this.name, error);
    }
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = req.model ?? this.defaultEmbeddingModel;
    try {
      const input = typeof req.input === "string" ? req.input : [...req.input];
      const response = await this.client.models.embedContent({
        model,
        contents: input,
        config: {
          outputDimensionality: req.dimensions ?? this.defaultEmbeddingDimensions,
        },
      });

      const vectors = (response.embeddings ?? []).map((embedding) => embedding.values ?? []);
      return {
        vectors,
        model,
      };
    } catch (error) {
      throw mapProviderError(this.name, error);
    }
  }
}
