import type { ImportExtractMode, ReasoningEffort } from "../types.js";
import {
  readBooleanEnv,
  readFloatEnv,
  readIntEnv,
  readStringEnv,
} from "../schema.js";
import {
  coerceChatModelForLocalMode,
  coerceChatModelForOpenAiProvider,
  resolveChatModelForCompatibleProvider,
} from "../../model/routing.js";

export type LlmProviderName = "openai" | "ollama" | "google" | "opencode" | "nvidia" | "anthropic";
export type EmbedProviderName = "openai" | "ollama" | "google";

const REASONING_EFFORT_VALUES = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function readReasoningEffort(env: NodeJS.ProcessEnv, key: string): ReasoningEffort | undefined {
  const raw = readStringEnv(env, key, "").trim().toLowerCase();
  if (!raw) return undefined;
  return REASONING_EFFORT_VALUES.has(raw as ReasoningEffort)
    ? (raw as ReasoningEffort)
    : undefined;
}

function readImportExtractMode(env: NodeJS.ProcessEnv): ImportExtractMode {
  const raw = readStringEnv(env, "TALLEI_IMPORT__EXTRACT_MODE", "heuristic").trim().toLowerCase();
  if (raw === "llm" || raw === "openai" || raw === "model") return "llm";
  return "heuristic";
}

/** Up to 8 numbered slots + comma-separated list + single key. */
export function readLlmApiKeyList(
  env: NodeJS.ProcessEnv,
  options: { prefix: string; legacyFallbackEnv?: string },
): string[] {
  const keys = new Set<string>();
  const csv = readStringEnv(env, `${options.prefix}_API_KEYS`, "");
  for (const part of csv.split(/[,;\n]/)) {
    const trimmed = part.trim();
    if (trimmed) keys.add(trimmed);
  }
  for (let slot = 1; slot <= 8; slot += 1) {
    const value = readStringEnv(env, `${options.prefix}_API_KEY_${slot}`, "").trim();
    if (value) keys.add(value);
  }
  const single = readStringEnv(env, `${options.prefix}_API_KEY`, "").trim();
  if (single) keys.add(single);
  if (keys.size === 0 && options.legacyFallbackEnv) {
    const fallback = readStringEnv(env, options.legacyFallbackEnv, "").trim();
    if (fallback) keys.add(fallback);
  }
  return [...keys];
}

/** OpenCode Go (/zen/go/v1) is Anthropic-format; Conductor uses OpenAI chat completions on /zen/v1. */
function normalizeOpenCodeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/zen/go/v1") || trimmed.endsWith("/zen/go")) {
    return trimmed.replace(/\/zen\/go(?:\/v1)?$/, "/zen/v1");
  }
  return trimmed || "https://opencode.ai/zen/v1";
}

export type LlmConfigContext = {
  nodeEnv: string;
  localModelMode: boolean;
};

export function loadLlmConfig(env: NodeJS.ProcessEnv, ctx: LlmConfigContext) {
  const defaultLlmProvider: LlmProviderName = ctx.localModelMode ? "ollama" : "openai";
  const defaultEmbeddingProvider: EmbedProviderName = ctx.localModelMode ? "ollama" : "openai";
  const defaultEmbeddingModel = ctx.localModelMode ? "nomic-embed-text" : "text-embedding-3-small";
  const defaultEmbeddingDims = ctx.localModelMode ? 768 : 1536;
  const defaultOllamaModel = readStringEnv(env, "TALLEI_LLM__OLLAMA_MODEL", "qwen3:14b");
  const defaultOpenCodeModel = readStringEnv(env, "TALLEI_LLM__OPENCODE_MODEL", "big-pickle");
  const defaultNvidiaModel = readStringEnv(env, "TALLEI_LLM__NVIDIA_MODEL", "meta/llama-3.3-70b-instruct");
  const defaultAnthropicModel = readStringEnv(env, "TALLEI_LLM__ANTHROPIC_MODEL", "claude-sonnet-4-20250514");

  const openaiApiKeys = readLlmApiKeyList(env, { prefix: "TALLEI_LLM__OPENAI" });
  const opencodeApiKeys = readLlmApiKeyList(env, {
    prefix: "TALLEI_LLM__OPENCODE",
    ...(openaiApiKeys.length === 0 ? { legacyFallbackEnv: "TALLEI_LLM__OPENAI_API_KEY" } : {}),
  });
  const nvidiaApiKeys = readLlmApiKeyList(env, {
    prefix: "TALLEI_LLM__NVIDIA",
    legacyFallbackEnv: "NIM_API_KEY",
  });

  const llmProvider = readStringEnv(env, "TALLEI_LLM__PROVIDER", defaultLlmProvider) as LlmProviderName;

  function compatibleDefaultModel(): string {
    if (llmProvider === "opencode") return defaultOpenCodeModel;
    if (llmProvider === "nvidia") return defaultNvidiaModel;
    if (llmProvider === "anthropic") return defaultAnthropicModel;
    return "gpt-5-nano";
  }

  function readResolvedChatModel(key: string, productionDefault: string): string {
    const cloudDefault = llmProvider === "opencode" || llmProvider === "nvidia" || llmProvider === "anthropic"
      ? compatibleDefaultModel()
      : productionDefault;
    const fallback = ctx.localModelMode ? defaultOllamaModel : cloudDefault;
    const raw = readStringEnv(env, key, fallback);
    if (ctx.localModelMode) {
      return coerceChatModelForLocalMode(raw, ctx.localModelMode, defaultOllamaModel);
    }
    if (llmProvider === "opencode" || llmProvider === "nvidia" || llmProvider === "anthropic") {
      return resolveChatModelForCompatibleProvider(raw, compatibleDefaultModel());
    }
    if (llmProvider === "openai") {
      return coerceChatModelForOpenAiProvider(raw, cloudDefault);
    }
    return raw;
  }

  function readResolvedOptionalChatModel(key: string): string {
    const raw = readStringEnv(env, key, "").trim();
    if (!raw) return "";
    if (ctx.localModelMode) {
      return coerceChatModelForLocalMode(raw, ctx.localModelMode, defaultOllamaModel);
    }
    if (llmProvider === "opencode" || llmProvider === "nvidia" || llmProvider === "anthropic") {
      return resolveChatModelForCompatibleProvider(raw, compatibleDefaultModel());
    }
    if (llmProvider === "openai") {
      return coerceChatModelForOpenAiProvider(raw, "gpt-5-mini");
    }
    return raw;
  }

  return {
    llmProvider,
    embeddingProvider: readStringEnv(env, "TALLEI_EMBED__PROVIDER", defaultEmbeddingProvider) as EmbedProviderName,
    embeddingModel: readStringEnv(env, "TALLEI_EMBED__MODEL", defaultEmbeddingModel),
    googleEmbeddingModel: readStringEnv(env, "TALLEI_EMBED__GOOGLE_MODEL", "gemini-embedding-001"),
    embeddingDims: readIntEnv(env, "TALLEI_EMBED__DIMS", defaultEmbeddingDims),
    openaiApiKey: openaiApiKeys[0] ?? "",
    openaiApiKeys,
    anthropicApiKey: readStringEnv(env, "TALLEI_LLM__ANTHROPIC_API_KEY"),
    anthropicModel: defaultAnthropicModel,
    openaiModel: readResolvedChatModel("TALLEI_LLM__CHAT_MODEL", "gpt-5-nano"),
    googleModel: readStringEnv(env, "TALLEI_LLM__GOOGLE_MODEL", "gemini-2.0-flash"),
    intentClassifierModel: readResolvedChatModel("TALLEI_LLM__INTENT_CLASSIFIER_MODEL", "gpt-5-nano"),
    openaiPayloadLoggingEnabled: readBooleanEnv(env, "TALLEI_OBS__OPENAI_PAYLOAD_LOGGING_ENABLED", false),
    openaiPayloadLoggingMaxChars: Math.max(
      64,
      Math.min(readIntEnv(env, "TALLEI_OBS__OPENAI_PAYLOAD_LOGGING_MAX_CHARS", 2000), 20_000),
    ),
    ollamaBaseUrl: readStringEnv(env, "TALLEI_LLM__OLLAMA_BASE_URL", "http://localhost:11434/v1"),
    ollamaModel: defaultOllamaModel,
    opencodeBaseUrl: normalizeOpenCodeBaseUrl(
      readStringEnv(env, "TALLEI_LLM__OPENCODE_BASE_URL", "https://opencode.ai/zen/v1"),
    ),
    opencodeModel: defaultOpenCodeModel,
    opencodeApiKey: opencodeApiKeys[0] ?? "",
    opencodeApiKeys,
    nvidiaBaseUrl: readStringEnv(env, "TALLEI_LLM__NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
    nvidiaModel: defaultNvidiaModel,
    nvidiaApiKey: nvidiaApiKeys[0] ?? "",
    nvidiaApiKeys,
    importMemoryExtractModel: readResolvedChatModel("TALLEI_IMPORT__MEMORY_EXTRACT_MODEL", "gpt-5-nano"),
    importKeepHighThreshold: readFloatEnv(env, "TALLEI_IMPORT__KEEP_HIGH_THRESHOLD", 0.45),
    importKeepWeakThreshold: readFloatEnv(env, "TALLEI_IMPORT__KEEP_WEAK_THRESHOLD", 0.35),
    importMaxExtractConversations: readIntEnv(env, "TALLEI_IMPORT__MAX_EXTRACT_CONVERSATIONS", 120),
    importExtractConcurrency: readIntEnv(env, "TALLEI_IMPORT__EXTRACT_CONCURRENCY", 6),
    importExtractMode: readImportExtractMode(env),
    importStorageDir: readStringEnv(env, "TALLEI_IMPORT__STORAGE_DIR", ""),
    importMaxUploadBytes: readIntEnv(env, "TALLEI_IMPORT__MAX_UPLOAD_BYTES", 1_610_612_736),
    importBatchSize: readIntEnv(env, "TALLEI_IMPORT__BATCH_SIZE", 500),
    importMaxAgeDays: readIntEnv(env, "TALLEI_IMPORT__MAX_AGE_DAYS", 365),
    importInclusiveKeepHighThreshold: readFloatEnv(env, "TALLEI_IMPORT__INCLUSIVE_KEEP_HIGH_THRESHOLD", 0.30),
    importInclusiveKeepWeakThreshold: readFloatEnv(env, "TALLEI_IMPORT__INCLUSIVE_KEEP_WEAK_THRESHOLD", 0.20),
    importInclusiveMaxExtractConversations: readIntEnv(env, "TALLEI_IMPORT__INCLUSIVE_MAX_EXTRACT_CONVERSATIONS", 500),
  } as const;
}

export type LlmConfig = ReturnType<typeof loadLlmConfig>;
