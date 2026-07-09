import { config } from "../config/index.js";
import type { ReasoningEffort } from "../config/load.js";
import {
  isLowConductorReasoningEffort,
  looksLikeHostedOpenAiModel,
  resolveConductorModelForOpenAi,
} from "./routing.js";
import type {
  AppModelPurpose,
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
  switch (purpose) {
    case "embed":
      return activeEmbedProvider() === "google" ? config.googleEmbeddingModel : config.embeddingModel;
    case "conductor":
      if (config.llmProvider === "openai") {
        return resolveConductorModelForOpenAi(config.conductorReasoningEffort, {
          lowModel: config.conductorLowReasoningModel,
          highModel: config.conductorModel,
        });
      }
      return config.conductorModel;
    case "planner":
      if (config.llmProvider === "opencode") return config.opencodeModel;
      if (config.llmProvider === "nvidia") return config.nvidiaModel;
      return config.plannerModel;
    case "collab-planner":
      return config.plannerModel;
    case "chat":
    default:
      if (config.llmProvider === "ollama") return config.ollamaModel;
      if (config.llmProvider === "opencode") return config.opencodeModel;
      if (config.llmProvider === "nvidia") return config.nvidiaModel;
      if (config.llmProvider === "google") return config.googleModel;
      return config.openaiModel;
  }
}

function providerForPurpose(purpose: AppModelPurpose): GatewayProviderId {
  if (purpose === "embed") return activeEmbedProvider();
  return activeChatProvider();
}

function resolveConductorReasoningEffort(): ReasoningEffort | undefined {
  if (config.conductorReasoningEffort === "none") return undefined;
  return config.conductorReasoningEffort ?? "medium";
}

function buildReasoningOptions(
  purpose: AppModelPurpose,
  capabilities: ModelCapabilities,
): ResolvedModelRoute["reasoning"] {
  const effort: ReasoningEffort | undefined = purpose === "conductor"
    ? resolveConductorReasoningEffort()
    : purpose === "planner"
      ? config.plannerReasoningEffort
      : undefined;
  if (!effort) return undefined;
  return {
    effort,
    ...(capabilities.supportsReasoningSummaries && purpose === "conductor"
      ? { summary: "auto" as const, includeEncryptedContent: true }
      : {}),
  };
}

function buildProviderOptions(
  capabilities: ModelCapabilities,
  reasoning?: ResolvedModelRoute["reasoning"],
): Record<string, unknown> | undefined {
  if (!reasoning?.effort) return undefined;
  if (capabilities.provider === "openai" && capabilities.surface === "responses") {
    return {
      openai: {
        reasoningEffort: reasoning.effort,
        ...(reasoning.summary ? { reasoningSummary: reasoning.summary } : {}),
        ...(reasoning.includeEncryptedContent ? { include: ["reasoning.encrypted_content"] } : {}),
      },
    };
  }
  if (capabilities.provider === "openai") {
    return { openai: { reasoningEffort: reasoning.effort } };
  }
  return undefined;
}

export function resolveModelRoute(input: {
  purpose: AppModelPurpose;
  modelId?: string;
}): ResolvedModelRoute {
  const provider = providerForPurpose(input.purpose);
  const modelId = input.modelId?.trim() || defaultModelForPurpose(input.purpose);
  const capabilities = resolveModelCapabilities(modelId, provider);
  const reasoning = buildReasoningOptions(input.purpose, capabilities);
  return {
    modelId,
    provider,
    capabilities,
    reasoning,
    providerOptions: buildProviderOptions(capabilities, reasoning),
  };
}

export function resolveConductorToolChoice(activeToolCount: number): "auto" | "none" | "required" {
  if (activeToolCount === 0) return "none";
  const provider = activeChatProvider();
  if (provider === "opencode" || provider === "nvidia") return "auto";
  return "required";
}

export function shouldSendReasoning(surface: ModelSurface): boolean {
  return surface === "responses" || surface === "opencode" || surface === "chat";
}

export function shouldApplyReasoningTagExtraction(
  provider: GatewayProviderId,
  surface: ModelSurface,
  purpose: AppModelPurpose,
): boolean {
  if (purpose !== "conductor") return false;
  if (provider === "opencode" || surface === "opencode") return true;
  if (provider === "nvidia") return true;
  return surface === "chat";
}

export function isLowReasoningEffort(effort: ReasoningEffort | undefined): boolean {
  return isLowConductorReasoningEffort(effort);
}

export const modelRegistry = {
  resolveModelRoute,
  resolveModelCapabilities,
  resolveConductorToolChoice,
  shouldSendReasoning,
  shouldApplyReasoningTagExtraction,
};
