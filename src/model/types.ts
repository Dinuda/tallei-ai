import type { ReasoningEffort } from "../config/load.js";

/** Gateway-facing provider identifiers. */
export type GatewayProviderId =
  | "openai"
  | "opencode"
  | "ollama"
  | "google"
  | "anthropic"
  | "openrouter"
  | "nvidia";

export type AppMessageRole = "system" | "user" | "assistant" | "tool";

export type AppContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; mimeType?: string; data?: string };

export type AppModelMessage = {
  role: AppMessageRole;
  content: string | AppContentPart[];
  toolCallId?: string;
  toolCalls?: AppToolCall[];
};

export type AppTool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

export type AppToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type AppSpecificToolChoice = { type: "tool"; toolName: string };

export type AppToolChoice = "auto" | "none" | "required" | AppSpecificToolChoice;

export type AppResponseFormat = "text" | "json" | "json_schema";

export type AppReasoningOptions = {
  effort?: ReasoningEffort;
  summary?: "auto" | "detailed";
  includeEncryptedContent?: boolean;
};

export type AppModelPurpose = "chat" | "embed";

export type AppJsonSchemaSpec = {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
};

export type AppModelRequest = {
  purpose?: AppModelPurpose;
  model?: string;
  messages: AppModelMessage[];
  tools?: AppTool[];
  toolChoice?: AppToolChoice;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: AppResponseFormat;
  jsonSchema?: AppJsonSchemaSpec;
  reasoning?: AppReasoningOptions;
  webSearchBudget?: number;
  signal?: AbortSignal;
  metadata?: Readonly<Record<string, string>>;
  userId?: string;
};

export type AppModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type AppModelResponse = {
  text?: string;
  toolCalls?: AppToolCall[];
  finishReason: string | null;
  model: string;
  provider: GatewayProviderId;
  usage?: AppModelUsage;
  raw?: unknown;
};

export type AppModelChunk =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; id: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; usage: AppModelUsage }
  | { type: "done"; finishReason?: string | null }
  | { type: "error"; error: string };

export type AppEmbeddingRequest = {
  purpose?: "embed";
  model?: string;
  input: string | string[];
  dimensions?: number;
  signal?: AbortSignal;
  metadata?: Readonly<Record<string, string>>;
};

export type AppEmbeddingResponse = {
  vectors: number[][];
  model: string;
  provider: GatewayProviderId;
};

export type ModelSurface = "responses" | "chat" | "opencode" | "google" | "anthropic";

export type ModelCapabilities = {
  provider: GatewayProviderId;
  modelId: string;
  surface: ModelSurface;
  supportsTools: boolean;
  supportsForcedToolChoice: boolean;
  supportsStreaming: boolean;
  supportsReasoningSummaries: boolean;
  supportsReasoningTags: boolean;
  supportsJsonMode: boolean;
  supportsJsonSchema: boolean;
  supportsWebSearch: boolean;
  supportsEmbeddings: boolean;
  supportsVision: boolean;
  contextWindow?: number;
};

export type ResolvedModelRoute = {
  modelId: string;
  provider: GatewayProviderId;
  capabilities: ModelCapabilities;
  reasoning?: AppReasoningOptions;
  providerOptions?: Record<string, unknown>;
};

export type StructuredOutputStrategy = "native_schema" | "json_mode" | "tool_call" | "prompt_repair";

export type StructuredOutputResult<T> = {
  data: T;
  strategy: StructuredOutputStrategy;
  rawText: string;
};
