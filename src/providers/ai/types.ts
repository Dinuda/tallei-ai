export type AiProviderName = "openai" | "ollama";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatCompletionRequest {
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: "text" | "json_object";
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ChatCompletionResponse {
  readonly text: string;
  readonly model: string;
  readonly finishReason: string | null;
}

export interface EmbeddingRequest {
  readonly model?: string;
  readonly input: string | readonly string[];
  readonly dimensions?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface EmbeddingResponse {
  readonly vectors: readonly (readonly number[])[];
  readonly model: string;
}

export interface ProviderCapabilities {
  readonly chat: boolean;
  readonly embed: boolean;
}
