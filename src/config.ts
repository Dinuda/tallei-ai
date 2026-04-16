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
const localBaseUrl = `http://localhost:${port}`;
const configuredPublicBaseUrl = process.env.PUBLIC_BASE_URL || localBaseUrl;
const publicBaseUrl = normalizeBaseUrl(configuredPublicBaseUrl);
const qdrantTimeoutMsOverride = readOptionalIntEnv("QDRANT_TIMEOUT_MS");
const qdrantTimeoutSecondsLegacy = readOptionalIntEnv("QDRANT_TIMEOUT_SECONDS");

export const config = {
  port,
  nodeEnv: process.env.NODE_ENV || "development",
  host: readStringEnv(
    "HOST",
    (process.env.NODE_ENV || "development") === "production" ? "0.0.0.0" : "127.0.0.1"
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
  openaiApiKey: requireEnv("OPENAI_API_KEY"),
  jwtSecret: requireEnv("JWT_SECRET"),
  supabaseUrl: readStringEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: readStringEnv("SUPABASE_SERVICE_ROLE_KEY"),
  redisUrl: readStringEnv("REDIS_URL"),
  qdrantUrl: readStringEnv("QDRANT_URL"),
  qdrantApiKey: readStringEnv("QDRANT_API_KEY"),
  qdrantCollectionName: readStringEnv("QDRANT_COLLECTION_NAME", "memories_v1"),
  // Qdrant JS client expects timeout in milliseconds.
  qdrantTimeoutMs:
    qdrantTimeoutMsOverride ??
    (qdrantTimeoutSecondsLegacy !== null
      ? qdrantTimeoutSecondsLegacy * 1000
      : process.env.NODE_ENV === "production"
        ? 30_000
        : 10_000),
  embeddingModel: readStringEnv("EMBEDDING_MODEL", "text-embedding-3-small"),
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
  claudeProjectInstructionsTemplate:
    process.env.CLAUDE_PROJECT_INSTRUCTIONS_TEMPLATE ||
    "Project: chatgpt memory. Mandatory tool use: (1) On the first user message of each new conversation, call recall_memories with a broad query before replying. (2) Before answering any personal/contextual question, call recall_memories first. (3) If recall_memories returns 'No relevant memories found', ALWAYS call list_memories next to scan all stored memories before concluding nothing is saved — the user may have saved it under a different phrasing. (4) Whenever the user states a durable fact or preference (name, favorite/favourite color, food, music, habits, goals, project stack, decisions), call remember_user_preference (or save_memory) in the same turn with concise factual content and platform=claude. (5) If user gives a direct answer after you asked for missing preference (example: user says 'blue' to 'what is your favorite color?'), immediately call remember_user_preference/save_memory before replying. (6) If the user corrects a prior fact, call save_memory with the corrected fact. Do not mention tool calls in the final user-facing response.",
} as const;
