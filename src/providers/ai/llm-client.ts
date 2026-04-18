import { aiProviderRegistry } from "./registry.js";

interface ChatCompletionsCreateParams {
  readonly model?: string;
  readonly messages: ReadonlyArray<{
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
  }>;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly response_format?: {
    readonly type: "text" | "json_object";
  };
}

interface RequestOptions {
  readonly signal?: AbortSignal;
}

interface ChatCompletionLikeResponse {
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly finish_reason: string | null;
    readonly message: {
      readonly content: string;
    };
  }>;
}

export const llm = {
  chat: {
    completions: {
      create: async (
        params: ChatCompletionsCreateParams,
        options: RequestOptions = {}
      ): Promise<ChatCompletionLikeResponse> => {
        const response = await aiProviderRegistry.chat({
          model: params.model,
          messages: params.messages,
          temperature: params.temperature,
          maxTokens: params.max_tokens,
          responseFormat: params.response_format?.type,
          signal: options.signal,
        });

        return {
          model: response.model,
          choices: [
            {
              finish_reason: response.finishReason,
              message: {
                content: response.text,
              },
            },
          ],
        };
      },
    },
  },
} as const;

export const llmModel = aiProviderRegistry.chatModelName();
