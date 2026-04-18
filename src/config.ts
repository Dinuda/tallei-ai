import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid integer env var: ${name}`);
  }
  return value;
}

function readOptionalIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid integer env var: ${name}`);
  }
  return value;
}

function readFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid float env var: ${name}`);
  }
  return value;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "true";
}

function readStringEnv(name: string, fallback = ""): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw;
}

function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;

  try {
    const parsed = new URL(value);
    if (parsed.pathname === "/mcp" || parsed.pathname.endsWith("/mcp/")) {
      parsed.pathname = "/";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  }
}

const port = readIntEnv("PORT", 3000);
const nodeEnv = process.env.NODE_ENV || "development";
const localModelModeDefault = nodeEnv !== "production";
const localModelMode = readBooleanEnv("LOCAL_MODEL_MODE", localModelModeDefault);
const defaultLlmProvider = localModelMode ? "ollama" : "openai";
const defaultEmbeddingProvider = localModelMode ? "ollama" : "openai";
const defaultEmbeddingModel = localModelMode ? "nomic-embed-text" : "text-embedding-3-small";
const defaultEmbeddingDims = localModelMode ? 768 : 1536;
const defaultQdrantCollectionName = localModelMode ? "memories_local_v1" : "memories_v1";
const localBaseUrl = `http://localhost:${port}`;
const configuredPublicBaseUrl = process.env.PUBLIC_BASE_URL || localBaseUrl;
const publicBaseUrl = normalizeBaseUrl(configuredPublicBaseUrl);
const qdrantTimeoutMsOverride = readOptionalIntEnv("QDRANT_TIMEOUT_MS");
const qdrantTimeoutSecondsLegacy = readOptionalIntEnv("QDRANT_TIMEOUT_SECONDS");

export const config = {
  port,
  nodeEnv,
  localModelMode,
  host: readStringEnv(
    "HOST",
    nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1"
  ),
  publicBaseUrl,
  dashboardBaseUrl: normalizeBaseUrl(
    process.env.DASHBOARD_BASE_URL || process.env.PUBLIC_BASE_URL || localBaseUrl
  ),
  frontendUrl: normalizeBaseUrl(
    process.env.FRONTEND_URL || process.env.PUBLIC_BASE_URL || "http://localhost:3001"
  ),
  internalApiSecret: requireEnv("INTERNAL_API_SECRET"),
  // Public URL for the MCP endpoint used in OAuth metadata.
  mcpPublicUrl: process.env.MCP_URL || "",
  databaseUrl: requireEnv("DATABASE_URL"),
  databaseUrlFallback: readStringEnv("DATABASE_URL_FALLBACK", "postgresql://tallei:tallei@localhost:5432/tallei"),
  openaiApiKey: readStringEnv("OPENAI_API_KEY"),
  jwtSecret: requireEnv("JWT_SECRET"),
  supabaseUrl: readStringEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: readStringEnv("SUPABASE_SERVICE_ROLE_KEY"),
  redisUrl: readStringEnv("REDIS_URL"),
  redisConnectTimeoutMs: readIntEnv(
    "REDIS_CONNECT_TIMEOUT_MS",
    process.env.NODE_ENV === "production" ? 1500 : 1000
  ),
  redisCommandTimeoutMs: readIntEnv(
    "REDIS_COMMAND_TIMEOUT_MS",
    process.env.NODE_ENV === "production" ? 800 : 500
  ),
  redisFailureCooldownMs: readIntEnv(
    "REDIS_FAILURE_COOLDOWN_MS",
    process.env.NODE_ENV === "production" ? 300_000 : 60_000
  ),
  authUsageUpdateDebounceMs: readIntEnv(
    "AUTH_USAGE_UPDATE_DEBOUNCE_MS",
    process.env.NODE_ENV === "production" ? 60_000 : 60_000
  ),
  authUsageUpdateRetryMs: readIntEnv(
    "AUTH_USAGE_UPDATE_RETRY_MS",
    process.env.NODE_ENV === "production" ? 5_000 : 5_000
  ),
  authUsageUpdateMaxConcurrency: readIntEnv(
    "AUTH_USAGE_UPDATE_MAX_CONCURRENCY",
    process.env.NODE_ENV === "production" ? 4 : 2
  ),
  memoryFallbackMinRelevance: readFloatEnv("MEMORY_FALLBACK_MIN_RELEVANCE", 0.2),
  qdrantUrl: readStringEnv("QDRANT_URL"),
  qdrantApiKey: readStringEnv("QDRANT_API_KEY"),
  qdrantCollectionName: readStringEnv("QDRANT_COLLECTION_NAME", defaultQdrantCollectionName),
  memoryVectorUpsertTimeoutMs: readIntEnv(
    "MEMORY_VECTOR_UPSERT_TIMEOUT_MS",
    process.env.NODE_ENV === "production" ? 10_000 : 12_000
  ),
  memoryRecallEmbedTimeoutMs: readIntEnv(
    "MEMORY_RECALL_EMBED_TIMEOUT_MS",
    process.env.NODE_ENV === "production" ? 5_000 : 6_000
  ),
  memoryRecallVectorTimeoutMs: readIntEnv(
    "MEMORY_RECALL_VECTOR_TIMEOUT_MS",
    process.env.NODE_ENV === "production" ? 8_000 : 12_000
  ),
  memoryRecallTotalTimeoutMs: readIntEnv(
    "MEMORY_RECALL_TOTAL_TIMEOUT_MS",
    process.env.NODE_ENV === "production" ? 12_000 : 20_000
  ),
  // Qdrant JS client expects timeout in milliseconds.
  qdrantTimeoutMs:
    qdrantTimeoutMsOverride ??
    (qdrantTimeoutSecondsLegacy !== null
      ? qdrantTimeoutSecondsLegacy * 1000
      : process.env.NODE_ENV === "production"
        ? 30_000
        : 10_000),
  embeddingProvider: readStringEnv("EMBEDDING_PROVIDER", defaultEmbeddingProvider) as "openai" | "ollama",
  embeddingModel: readStringEnv("EMBEDDING_MODEL", defaultEmbeddingModel),
  embeddingDims: readIntEnv("EMBEDDING_DIMS", defaultEmbeddingDims),
  // LLM provider for generation (summarization, reranking, fact extraction).
  // In local mode, provider defaults to Ollama.
  llmProvider: readStringEnv("LLM_PROVIDER", defaultLlmProvider) as "openai" | "ollama",
  openaiModel: readStringEnv("OPENAI_MODEL", "gpt-4o-mini"),
  ollamaBaseUrl: readStringEnv("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
  ollamaModel: readStringEnv("OLLAMA_MODEL", "qwen2.5:7b"),
  memoryMasterKey: readStringEnv("MEMORY_MASTER_KEY"),
  kmsKeyId: readStringEnv("KMS_KEY_ID", "local-dev"),
  enableSupabaseRlsPolicies: readBooleanEnv("ENABLE_SUPABASE_RLS_POLICIES", true),
  memoryDualWriteEnabled: readBooleanEnv("MEMORY_DUAL_WRITE_ENABLED", false),
  memoryShadowReadEnabled: readBooleanEnv("MEMORY_SHADOW_READ_ENABLED", false),
  graphExtractionEnabled: readBooleanEnv("GRAPH_EXTRACTION_ENABLED", false),
  recallV2Enabled: readBooleanEnv("RECALL_V2_ENABLED", false),
  recallV2ShadowMode: readBooleanEnv("RECALL_V2_SHADOW_MODE", false),
  dashboardGraphV2Enabled: readBooleanEnv("DASHBOARD_GRAPH_V2_ENABLED", false),
  memoryGraphWorkerPollMs: readIntEnv("MEMORY_GRAPH_WORKER_POLL_MS", 1500),
  memoryGraphWorkerBatchSize: readIntEnv("MEMORY_GRAPH_WORKER_BATCH_SIZE", 16),
  memoryApiRateLimitPerMinute: readIntEnv("MEMORY_API_RATE_LIMIT_PER_MINUTE", 180),
  mcpRateLimitPerMinute: readIntEnv("MCP_RATE_LIMIT_PER_MINUTE", 240),
  // Minimum cosine-similarity score for a vector hit to be included in recall results.
  // Hits below this are discarded; if all are discarded the fallback lexical path runs.
  recallMinVectorScore: readFloatEnv("RECALL_MIN_VECTOR_SCORE", 0.30),
  // Minimum lexical score for the fallback path. Results below this are excluded so that
  // completely unrelated memories are never injected as context.
  recallMinFallbackScore: readFloatEnv("RECALL_MIN_FALLBACK_SCORE", 0.05),
  // LLM reranker: pass vector search candidates through gpt-4o-mini to filter truly
  // irrelevant results before returning context.  Adds ~200-400ms but eliminates
  // false positives like "favorite language" matching "favorite ice cream".
  rerankEnabled: readBooleanEnv("RERANK_ENABLED", true),
  // Minimum rerank score (0–1) to include a memory in the final result.
  rerankMinScore: readFloatEnv("RERANK_MIN_SCORE", 0.4),
  browserWorkerBaseUrl: process.env.BROWSER_WORKER_BASE_URL || "",
  browserWorkerApiKey: process.env.BROWSER_WORKER_API_KEY || "",
  browserMaxStudentRetries: readIntEnv("BROWSER_MAX_STUDENT_RETRIES", 2),
  browserLlmFallbackEnabled: readBooleanEnv("BROWSER_LLM_FALLBACK_ENABLED", true),
  browserWorkerWsEndpoint: process.env.BROWSER_WORKER_WS_ENDPOINT || "",
  browserSessionTtlMs: readIntEnv("BROWSER_SESSION_TTL_MS", 900000),
  browserHeadless: readBooleanEnv("BROWSER_HEADLESS", true),
  claudeConnectorMcpUrl:
    process.env.CLAUDE_CONNECTOR_MCP_URL || `${process.env.PUBLIC_BASE_URL || localBaseUrl}/mcp`,
  lemonSqueezyApiKey: readStringEnv("LEMONSQUEEZY_API_KEY"),
  lemonSqueezyWebhookSecret: readStringEnv("LEMONSQUEEZY_WEBHOOK_SECRET"),
  lemonSqueezyProVariantId: readStringEnv("LEMONSQUEEZY_PRO_VARIANT_ID"),
  lemonSqueezyPowerVariantId: readStringEnv("LEMONSQUEEZY_POWER_VARIANT_ID"),
  claudeProjectInstructionsTemplate:
    process.env.CLAUDE_PROJECT_INSTRUCTIONS_TEMPLATE ||
    "Project: chatgpt memory. Mandatory tool use and preload policy: (1) On the first user message of every new conversation, immediately call recall_memories with query='find tallei' before replying, even if context is not strictly needed, to warm tool/context loading. (2) On each user turn, preload by calling recall_memories once before replying; do not run repeated recall searches in the same turn unless the user explicitly asks for deeper memory search. (3) If you do not know something, are uncertain, or detect missing personal/contextual information, call recall_memories before answering. (4) Before answering personal/contextual questions, ensure the preload recall_memories call has already happened in that turn. (5) Only call remember_user_preference/save_memory when the user explicitly asks to remember something, or when they explicitly asks to remember a correction. (6) If the user corrects a prior fact and asks to remember it, call save_memory with the corrected fact. (7) Do not mention tool calls in the final user-facing response.",
} as const;
