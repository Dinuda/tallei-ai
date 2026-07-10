import { config } from "../config/index.js";
import type {
  AppModelPurpose,
  AppToolChoice,
  GatewayProviderId,
  ModelCapabilities,
  ModelSurface,
  ResolvedModelRoute,
} from "./types.js";

type RegistryEntry = ModelCapabilities & {
  aliases?: string[];
};

const OPENAI_RESPONSES_DEFAULTS: Omit<ModelCapabilities, "provider" | "modelId" | "surface"> = {
  supportsTools: true,
  supportsForcedToolChoice: true,
  supportsStreaming: true,
  supportsReasoningSummaries: true,
  supportsReasoningTags: false,
  supportsJsonMode: true,
  supportsJsonSchema: true,
  supportsWebSearch: true,
  supportsEmbeddings: false,
  supportsVision: true,
  contextWindow: 128_000,
};

const OPENAI_CHAT_DEFAULTS: Omit<ModelCapabilities, "provider" | "modelId" | "surface"> = {
  supportsTools: true,
  supportsForcedToolChoice: true,
  supportsStreaming: true,
  supportsReasoningSummaries: false,
  supportsReasoningTags: true,
  supportsJsonMode: true,
  supportsJsonSchema: false,
  supportsWebSearch: false,
  supportsEmbeddings: false,
  supportsVision: true,
  contextWindow: 128_000,
};

const OPENCODE_DEFAULTS: Omit<ModelCapabilities, "provider" | "modelId" | "surface"> = {
  supportsTools: true,
  supportsForcedToolChoice: false,
  supportsStreaming: true,
  supportsReasoningSummaries: false,
  supportsReasoningTags: true,
  supportsJsonMode: true,
  supportsJsonSchema: false,
  supportsWebSearch: false,
  supportsEmbeddings: false,
  supportsVision: false,
  contextWindow: 128_000,
};

const GOOGLE_DEFAULTS: Omit<ModelCapabilities, "provider" | "modelId" | "surface"> = {
  supportsTools: false,
  supportsForcedToolChoice: false,
  supportsStreaming: false,
  supportsReasoningSummaries: false,
  supportsReasoningTags: false,
  supportsJsonMode: true,
  supportsJsonSchema: false,
  supportsWebSearch: false,
  supportsEmbeddings: true,
  supportsVision: true,
  contextWindow: 1_000_000,
};

const OLLAMA_DEFAULTS: Omit<ModelCapabilities, "provider" | "modelId" | "surface"> = {
  supportsTools: false,
  supportsForcedToolChoice: false,
  supportsStreaming: true,
  supportsReasoningSummaries: false,
  supportsReasoningTags: true,
  supportsJsonMode: true,
  supportsJsonSchema: false,
  supportsWebSearch: false,
  supportsEmbeddings: true,
  supportsVision: false,
  contextWindow: 32_000,
};

const NVIDIA_DEFAULTS: Omit<ModelCapabilities, "provider" | "modelId" | "surface"> = {
  supportsTools: true,
  supportsForcedToolChoice: false,
  supportsStreaming: true,
  supportsReasoningSummaries: false,
  supportsReasoningTags: true,
  supportsJsonMode: true,
  supportsJsonSchema: false,
  supportsWebSearch: false,
  supportsEmbeddings: false,
  supportsVision: false,
  contextWindow: 128_000,
};

const STATIC_ENTRIES: RegistryEntry[] = [
  {
    provider: "openai",
    modelId: "gpt-5-mini",
    surface: "responses",
    ...OPENAI_RESPONSES_DEFAULTS,
    aliases: ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5"],
  },
  {
    provider: "openai",
    modelId: "gpt-5-nano",
    surface: "responses",
    ...OPENAI_RESPONSES_DEFAULTS,
    contextWindow: 64_000,
  },
  {
    provider: "openai",
    modelId: "gpt-4.1-mini",
    surface: "responses",
    ...OPENAI_RESPONSES_DEFAULTS,
  },
  {
    provider: "openai",
    modelId: "text-embedding-3-small",
    surface: "chat",
    ...OPENAI_CHAT_DEFAULTS,
    supportsTools: false,
    supportsStreaming: false,
    supportsEmbeddings: true,
    supportsVision: false,
  },
  {
    provider: "nvidia",
    modelId: "meta/llama-3.3-70b-instruct",
    surface: "chat",
    ...NVIDIA_DEFAULTS,
  },
  {
    provider: "nvidia",
    modelId: "deepseek-ai/deepseek-r1",
    surface: "chat",
    ...NVIDIA_DEFAULTS,
  },
  {
    provider: "opencode",
    modelId: "big-pickle",
    surface: "opencode",
    ...OPENCODE_DEFAULTS,
  },
  {
    provider: "google",
    modelId: "gemini-2.0-flash",
    surface: "google",
    ...GOOGLE_DEFAULTS,
  },
  {
    provider: "ollama",
    modelId: "qwen3:14b",
    surface: "chat",
    ...OLLAMA_DEFAULTS,
  },
];

function activeChatProvider(): GatewayProviderId {
  return config.llmProvider as GatewayProviderId;
}

function activeEmbedProvider(): GatewayProviderId {
  return config.embeddingProvider as GatewayProviderId;
}

function looksLikeHostedOpenAiModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("openai/")) return true;
  return normalized.startsWith("gpt-")
    || normalized.startsWith("o1")
    || normalized.startsWith("o3")
    || normalized.startsWith("o4");
}

function inferSurface(provider: GatewayProviderId, modelId: string): ModelSurface {
  if (provider === "opencode") return "opencode";
  if (provider === "google") return "google";
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai" && looksLikeHostedOpenAiModel(modelId)) return "responses";
  return "chat";
}

function defaultsFor(provider: GatewayProviderId, surface: ModelSurface): Omit<ModelCapabilities, "provider" | "modelId" | "surface"> {
  if (provider === "nvidia") return NVIDIA_DEFAULTS;
  if (provider === "opencode" || surface === "opencode") return OPENCODE_DEFAULTS;
  if (provider === "google" || surface === "google") return GOOGLE_DEFAULTS;
  if (provider === "ollama") return OLLAMA_DEFAULTS;
  if (surface === "responses") return OPENAI_RESPONSES_DEFAULTS;
  return OPENAI_CHAT_DEFAULTS;
}

export function resolveModelCapabilities(modelId: string, provider?: GatewayProviderId): ModelCapabilities {
  const normalized = modelId.trim().toLowerCase();
  const staticMatch = STATIC_ENTRIES.find((entry) =>
    entry.modelId.toLowerCase() === normalized
    || entry.aliases?.some((alias) => alias.toLowerCase() === normalized));
  if (staticMatch) {
    const { aliases: _aliases, ...capabilities } = staticMatch;
    return capabilities;
  }

  const resolvedProvider = provider ?? activeChatProvider();
  const surface = inferSurface(resolvedProvider, modelId);
  return {
    provider: resolvedProvider,
    modelId,
    surface,
    ...defaultsFor(resolvedProvider, surface),
  };
}

function defaultModelForPurpose(purpose: AppModelPurpose): string {
  if (purpose === "embed") {
    return activeEmbedProvider() === "google" ? config.googleEmbeddingModel : config.embeddingModel;
  }
  if (config.llmProvider === "ollama") return config.ollamaModel;
  if (config.llmProvider === "opencode") return config.opencodeModel;
  if (config.llmProvider === "nvidia") return config.nvidiaModel;
  if (config.llmProvider === "google") return config.googleModel;
  return config.openaiModel;
}

function providerForPurpose(purpose: AppModelPurpose): GatewayProviderId {
  if (purpose === "embed") return activeEmbedProvider();
  return activeChatProvider();
}

export function resolveModelRoute(input: {
  purpose: AppModelPurpose;
  modelId?: string;
}): ResolvedModelRoute {
  const provider = providerForPurpose(input.purpose);
  const modelId = input.modelId?.trim() || defaultModelForPurpose(input.purpose);
  const capabilities = resolveModelCapabilities(modelId, provider);
  return {
    modelId,
    provider,
    capabilities,
  };
}

export function resolveRequiredToolChoice(
  activeToolCount: number,
  options?: { nextTool?: string | null; allowedTools?: readonly string[] },
): AppToolChoice {
  if (activeToolCount === 0) return "none";
  const nextTool = options?.nextTool?.trim();
  const canPinNextTool = Boolean(
    nextTool && (!options?.allowedTools || options.allowedTools.includes(nextTool)),
  );
  const provider = activeChatProvider();
  if (provider === "opencode" || provider === "nvidia") {
    return "required";
  }
  if (canPinNextTool) {
    return { type: "tool", toolName: nextTool! };
  }
  return "required";
}

export function shouldSendReasoning(surface: ModelSurface): boolean {
  return surface === "responses" || surface === "opencode" || surface === "chat";
}

export function shouldApplyReasoningTagExtraction(
  provider: GatewayProviderId,
  surface: ModelSurface,
): boolean {
  if (provider === "opencode" || surface === "opencode") return true;
  if (provider === "nvidia") return true;
  return surface === "chat";
}

export const modelRegistry = {
  resolveModelRoute,
  resolveModelCapabilities,
  resolveRequiredToolChoice,
  resolveConductorToolChoice: resolveRequiredToolChoice,
  shouldSendReasoning,
  shouldApplyReasoningTagExtraction,
};
