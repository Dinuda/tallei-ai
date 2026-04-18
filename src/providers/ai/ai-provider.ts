import type {
  AiProviderName,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderCapabilities,
} from "./types.js";

export interface AiProvider {
  readonly name: AiProviderName;
  capabilities(): ProviderCapabilities;
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}
