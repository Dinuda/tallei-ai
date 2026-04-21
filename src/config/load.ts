import "dotenv/config";

import {
  normalizeBaseUrl,
  readBooleanEnv,
  readFloatEnv,
  readIntEnv,
  readOptionalIntEnv,
  readStringEnv,
  requireEnv,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Dual-read alias map
//
// Maps new canonical TALLEI_* names to their legacy equivalents.
// When a new name is absent but the old name is present, the old value is
// copied under the new name so the rest of loadConfig only has to read
// TALLEI_* names.  A single boot-time warning lists which old names are
// still in use so operators can migrate at their own pace.
//
// Remove a pair from this table one release after the deprecation warning
// has shipped (i.e. after announcing the new name in CHANGELOG / deploy docs).
// ---------------------------------------------------------------------------
const ALIAS_MAP: ReadonlyArray<{ newKey: string; oldKey: string }> = [
  // HTTP / server
  { newKey: "TALLEI_HTTP__PORT",               oldKey: "PORT" },
  { newKey: "TALLEI_HTTP__HOST",               oldKey: "HOST" },
  { newKey: "TALLEI_HTTP__PUBLIC_BASE_URL",     oldKey: "PUBLIC_BASE_URL" },
  { newKey: "TALLEI_HTTP__DASHBOARD_BASE_URL",  oldKey: "DASHBOARD_BASE_URL" },
  { newKey: "TALLEI_HTTP__FRONTEND_URL",        oldKey: "FRONTEND_URL" },
  { newKey: "TALLEI_HTTP__INTERNAL_API_SECRET", oldKey: "INTERNAL_API_SECRET" },
  { newKey: "TALLEI_HTTP__MCP_URL",             oldKey: "MCP_URL" },
  // Database
  { newKey: "TALLEI_DB__URL",                  oldKey: "DATABASE_URL" },
  { newKey: "TALLEI_DB__URL_FALLBACK",          oldKey: "DATABASE_URL_FALLBACK" },
  // LLM / generation
  { newKey: "TALLEI_LLM__OPENAI_API_KEY",       oldKey: "OPENAI_API_KEY" },
  { newKey: "TALLEI_LLM__PROVIDER",             oldKey: "LLM_PROVIDER" },
  { newKey: "TALLEI_LLM__CHAT_MODEL",           oldKey: "OPENAI_MODEL" },
  { newKey: "TALLEI_LLM__OLLAMA_BASE_URL",      oldKey: "OLLAMA_BASE_URL" },
  { newKey: "TALLEI_LLM__OLLAMA_MODEL",         oldKey: "OLLAMA_MODEL" },
  { newKey: "TALLEI_LLM__LOCAL_MODEL_MODE",     oldKey: "LOCAL_MODEL_MODE" },
  // Embedding
  { newKey: "TALLEI_EMBED__PROVIDER",           oldKey: "EMBEDDING_PROVIDER" },
  { newKey: "TALLEI_EMBED__MODEL",              oldKey: "EMBEDDING_MODEL" },
  { newKey: "TALLEI_EMBED__DIMS",               oldKey: "EMBEDDING_DIMS" },
  // Qdrant
  { newKey: "TALLEI_QDRANT__URL",              oldKey: "QDRANT_URL" },
  { newKey: "TALLEI_QDRANT__API_KEY",           oldKey: "QDRANT_API_KEY" },
  { newKey: "TALLEI_QDRANT__COLLECTION",        oldKey: "QDRANT_COLLECTION_NAME" },
  { newKey: "TALLEI_QDRANT__TIMEOUT_MS",        oldKey: "QDRANT_TIMEOUT_MS" },
  // Redis
  { newKey: "TALLEI_REDIS__URL",               oldKey: "REDIS_URL" },
  { newKey: "TALLEI_REDIS__CONNECT_TIMEOUT_MS", oldKey: "REDIS_CONNECT_TIMEOUT_MS" },
  { newKey: "TALLEI_REDIS__COMMAND_TIMEOUT_MS", oldKey: "REDIS_COMMAND_TIMEOUT_MS" },
  { newKey: "TALLEI_REDIS__FAILURE_COOLDOWN_MS",oldKey: "REDIS_FAILURE_COOLDOWN_MS" },
  // Auth / crypto
  { newKey: "TALLEI_AUTH__JWT_SECRET",          oldKey: "JWT_SECRET" },
  { newKey: "TALLEI_AUTH__API_KEY_PEPPER",      oldKey: "API_KEY_PEPPER" },
  { newKey: "TALLEI_AUTH__SUPABASE_URL",        oldKey: "SUPABASE_URL" },
  { newKey: "TALLEI_AUTH__SUPABASE_SERVICE_ROLE_KEY", oldKey: "SUPABASE_SERVICE_ROLE_KEY" },
  { newKey: "TALLEI_AUTH__MEMORY_MASTER_KEY",   oldKey: "MEMORY_MASTER_KEY" },
  { newKey: "TALLEI_AUTH__KMS_KEY_ID",          oldKey: "KMS_KEY_ID" },
  // Billing
  { newKey: "TALLEI_BILLING__LEMONSQUEEZY_API_KEY",        oldKey: "LEMONSQUEEZY_API_KEY" },
  { newKey: "TALLEI_BILLING__LEMONSQUEEZY_WEBHOOK_SECRET", oldKey: "LEMONSQUEEZY_WEBHOOK_SECRET" },
  { newKey: "TALLEI_BILLING__LEMONSQUEEZY_PRO_VARIANT_ID", oldKey: "LEMONSQUEEZY_PRO_VARIANT_ID" },
  { newKey: "TALLEI_BILLING__LEMONSQUEEZY_POWER_VARIANT_ID", oldKey: "LEMONSQUEEZY_POWER_VARIANT_ID" },
  { newKey: "TALLEI_BILLING__TRIAL_DAYS",                  oldKey: "LEMONSQUEEZY_TRIAL_DAYS" },
  // Browser automation
  { newKey: "TALLEI_BROWSER__WORKER_BASE_URL",  oldKey: "BROWSER_WORKER_BASE_URL" },
  { newKey: "TALLEI_BROWSER__WORKER_API_KEY",   oldKey: "BROWSER_WORKER_API_KEY" },
  { newKey: "TALLEI_BROWSER__WORKER_WS_ENDPOINT",oldKey: "BROWSER_WORKER_WS_ENDPOINT" },
  { newKey: "TALLEI_BROWSER__SESSION_TTL_MS",   oldKey: "BROWSER_SESSION_TTL_MS" },
  { newKey: "TALLEI_BROWSER__HEADLESS",         oldKey: "BROWSER_HEADLESS" },
  { newKey: "TALLEI_BROWSER__MAX_RETRIES",      oldKey: "BROWSER_MAX_STUDENT_RETRIES" },
  { newKey: "TALLEI_BROWSER__LLM_FALLBACK",     oldKey: "BROWSER_LLM_FALLBACK_ENABLED" },
  // Feature flags
  { newKey: "TALLEI_FEATURE__RERANK",           oldKey: "RERANK_ENABLED" },
  { newKey: "TALLEI_FEATURE__USE_NEW_SAVE",     oldKey: "USE_NEW_SAVE_USECASE" },
  { newKey: "TALLEI_FEATURE__USE_NEW_RECALL",   oldKey: "USE_NEW_RECALL_USECASE" },
  { newKey: "TALLEI_FEATURE__USE_NEW_LIST",     oldKey: "USE_NEW_LIST_USECASE" },
  { newKey: "TALLEI_FEATURE__USE_NEW_DELETE",   oldKey: "USE_NEW_DELETE_USECASE" },
  // Resilience tunables
  { newKey: "TALLEI_RESILIENCE__VECTOR_UPSERT_TIMEOUT_MS", oldKey: "MEMORY_VECTOR_UPSERT_TIMEOUT_MS" },
  { newKey: "TALLEI_RESILIENCE__RECALL_EMBED_TIMEOUT_MS",  oldKey: "MEMORY_RECALL_EMBED_TIMEOUT_MS" },
  { newKey: "TALLEI_RESILIENCE__RECALL_VECTOR_TIMEOUT_MS", oldKey: "MEMORY_RECALL_VECTOR_TIMEOUT_MS" },
  { newKey: "TALLEI_RESILIENCE__RECALL_TOTAL_TIMEOUT_MS",  oldKey: "MEMORY_RECALL_TOTAL_TIMEOUT_MS" },
  // Rate limits
  { newKey: "TALLEI_RATE__MEMORY_API_PER_MINUTE", oldKey: "MEMORY_API_RATE_LIMIT_PER_MINUTE" },
  { newKey: "TALLEI_RATE__MCP_PER_MINUTE",         oldKey: "MCP_RATE_LIMIT_PER_MINUTE" },
  // Misc
  { newKey: "TALLEI_MISC__RECALL_MIN_VECTOR_SCORE",  oldKey: "RECALL_MIN_VECTOR_SCORE" },
  { newKey: "TALLEI_MISC__RECALL_MIN_FALLBACK_SCORE",oldKey: "RECALL_MIN_FALLBACK_SCORE" },
  { newKey: "TALLEI_MISC__RECALL_HYBRID_SIMILARITY_FLOOR", oldKey: "RECALL_HYBRID_SIMILARITY_FLOOR" },
  { newKey: "TALLEI_MISC__RERANK_MIN_SCORE",         oldKey: "RERANK_MIN_SCORE" },
  { newKey: "TALLEI_MISC__MEMORY_FALLBACK_MIN_RELEVANCE", oldKey: "MEMORY_FALLBACK_MIN_RELEVANCE" },
  { newKey: "TALLEI_MISC__AUTH_USAGE_UPDATE_DEBOUNCE_MS",   oldKey: "AUTH_USAGE_UPDATE_DEBOUNCE_MS" },
  { newKey: "TALLEI_MISC__AUTH_USAGE_UPDATE_RETRY_MS",      oldKey: "AUTH_USAGE_UPDATE_RETRY_MS" },
  { newKey: "TALLEI_MISC__AUTH_USAGE_UPDATE_MAX_CONCURRENCY", oldKey: "AUTH_USAGE_UPDATE_MAX_CONCURRENCY" },
];

/**
 * Copies legacy env var values under their new TALLEI_* canonical names when
 * the new name is absent. Emits a single deprecation warning listing every
 * old name still in use (suppressed in test mode to keep output clean).
 */
function resolveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...env };
  const deprecated: string[] = [];

  for (const { newKey, oldKey } of ALIAS_MAP) {
    if (!resolved[newKey] && resolved[oldKey]) {
      resolved[newKey] = resolved[oldKey];
      deprecated.push(oldKey);
    }
  }

  if (deprecated.length > 0 && env.NODE_ENV !== "test") {
    // Use console.warn here deliberately — this fires before the logger is
    // initialised, so we cannot use the structured logger.
    console.warn(
      `[tallei/config] DEPRECATED env vars in use (rename before next major version): ` +
        deprecated.join(", ") +
        `. See docs/adr/005-config-schema-zod.md for canonical TALLEI_* names.`
    );
  }

  return resolved;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = resolveEnv(env);

  const port = readIntEnv(e, "TALLEI_HTTP__PORT", 3000);
  const nodeEnv = e.NODE_ENV || "development";
  const localModelModeDefault = nodeEnv !== "production";
  const localModelMode = readBooleanEnv(e, "TALLEI_LLM__LOCAL_MODEL_MODE", localModelModeDefault);
  const defaultLlmProvider = localModelMode ? "ollama" : "openai";
  const defaultEmbeddingProvider = localModelMode ? "ollama" : "openai";
  const defaultEmbeddingModel = localModelMode ? "nomic-embed-text" : "text-embedding-3-small";
  const defaultEmbeddingDims = localModelMode ? 768 : 1536;
  const defaultQdrantCollectionName = localModelMode ? "memories_local_v1" : "memories_v1";
  const localBaseUrl = `http://localhost:${port}`;
  const configuredPublicBaseUrl = e.TALLEI_HTTP__PUBLIC_BASE_URL || localBaseUrl;
  const publicBaseUrl = normalizeBaseUrl(configuredPublicBaseUrl);
  const qdrantTimeoutMsOverride = readOptionalIntEnv(e, "TALLEI_QDRANT__TIMEOUT_MS");
  const qdrantTimeoutSecondsLegacy = readOptionalIntEnv(e, "QDRANT_TIMEOUT_SECONDS"); // legacy only; no TALLEI_ form

  return {
    port,
    nodeEnv,
    localModelMode,
    host: readStringEnv(
      e,
      "TALLEI_HTTP__HOST",
      nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1"
    ),
    publicBaseUrl,
    dashboardBaseUrl: normalizeBaseUrl(
      e.TALLEI_HTTP__DASHBOARD_BASE_URL || e.TALLEI_HTTP__PUBLIC_BASE_URL || localBaseUrl
    ),
    frontendUrl: normalizeBaseUrl(
      e.TALLEI_HTTP__FRONTEND_URL || e.TALLEI_HTTP__PUBLIC_BASE_URL || "http://localhost:3001"
    ),
    internalApiSecret: requireEnv(e, "TALLEI_HTTP__INTERNAL_API_SECRET"),
    mcpPublicUrl: e.TALLEI_HTTP__MCP_URL || "",
    databaseUrl: requireEnv(e, "TALLEI_DB__URL"),
    databaseUrlFallback: readStringEnv(e, "TALLEI_DB__URL_FALLBACK", "postgresql://tallei:tallei@localhost:5432/tallei"),
    openaiApiKey: readStringEnv(e, "TALLEI_LLM__OPENAI_API_KEY"),
    jwtSecret: requireEnv(e, "TALLEI_AUTH__JWT_SECRET"),
    apiKeyPepper: readStringEnv(e, "TALLEI_AUTH__API_KEY_PEPPER"),
    supabaseUrl: readStringEnv(e, "TALLEI_AUTH__SUPABASE_URL"),
    supabaseServiceRoleKey: readStringEnv(e, "TALLEI_AUTH__SUPABASE_SERVICE_ROLE_KEY"),
    redisUrl: readStringEnv(e, "TALLEI_REDIS__URL"),
    redisConnectTimeoutMs: readIntEnv(
      e,
      "TALLEI_REDIS__CONNECT_TIMEOUT_MS",
      nodeEnv === "production" ? 1500 : 1000
    ),
    redisCommandTimeoutMs: readIntEnv(
      e,
      "TALLEI_REDIS__COMMAND_TIMEOUT_MS",
      nodeEnv === "production" ? 800 : 500
    ),
    redisFailureCooldownMs: readIntEnv(
      e,
      "TALLEI_REDIS__FAILURE_COOLDOWN_MS",
      nodeEnv === "production" ? 300_000 : 60_000
    ),
    authUsageUpdateDebounceMs: readIntEnv(
      e,
      "TALLEI_MISC__AUTH_USAGE_UPDATE_DEBOUNCE_MS",
      60_000
    ),
    authUsageUpdateRetryMs: readIntEnv(
      e,
      "TALLEI_MISC__AUTH_USAGE_UPDATE_RETRY_MS",
      5_000
    ),
    authUsageUpdateMaxConcurrency: readIntEnv(
      e,
      "TALLEI_MISC__AUTH_USAGE_UPDATE_MAX_CONCURRENCY",
      nodeEnv === "production" ? 4 : 2
    ),
    memoryFallbackMinRelevance: readFloatEnv(e, "TALLEI_MISC__MEMORY_FALLBACK_MIN_RELEVANCE", 0.2),
    qdrantUrl: readStringEnv(e, "TALLEI_QDRANT__URL"),
    qdrantApiKey: readStringEnv(e, "TALLEI_QDRANT__API_KEY"),
    qdrantCollectionName: readStringEnv(e, "TALLEI_QDRANT__COLLECTION", defaultQdrantCollectionName),
    memoryVectorUpsertTimeoutMs: readIntEnv(
      e,
      "TALLEI_RESILIENCE__VECTOR_UPSERT_TIMEOUT_MS",
      nodeEnv === "production" ? 10_000 : 12_000
    ),
    memoryRecallEmbedTimeoutMs: readIntEnv(
      e,
      "TALLEI_RESILIENCE__RECALL_EMBED_TIMEOUT_MS",
      nodeEnv === "production" ? 5_000 : 6_000
    ),
    memoryRecallVectorTimeoutMs: readIntEnv(
      e,
      "TALLEI_RESILIENCE__RECALL_VECTOR_TIMEOUT_MS",
      nodeEnv === "production" ? 8_000 : 12_000
    ),
    memoryRecallTotalTimeoutMs: readIntEnv(
      e,
      "TALLEI_RESILIENCE__RECALL_TOTAL_TIMEOUT_MS",
      nodeEnv === "production" ? 12_000 : 20_000
    ),
    // Qdrant JS client expects timeout in milliseconds.
    qdrantTimeoutMs:
      qdrantTimeoutMsOverride ??
      (qdrantTimeoutSecondsLegacy !== null
        ? qdrantTimeoutSecondsLegacy * 1000
        : nodeEnv === "production"
          ? 30_000
          : 10_000),
    embeddingProvider: readStringEnv(e, "TALLEI_EMBED__PROVIDER", defaultEmbeddingProvider) as "openai" | "ollama",
    embeddingModel: readStringEnv(e, "TALLEI_EMBED__MODEL", defaultEmbeddingModel),
    embeddingDims: readIntEnv(e, "TALLEI_EMBED__DIMS", defaultEmbeddingDims),
    llmProvider: readStringEnv(e, "TALLEI_LLM__PROVIDER", defaultLlmProvider) as "openai" | "ollama",
    openaiModel: readStringEnv(e, "TALLEI_LLM__CHAT_MODEL", "gpt-4o-mini"),
    ollamaBaseUrl: readStringEnv(e, "TALLEI_LLM__OLLAMA_BASE_URL", "http://localhost:11434/v1"),
    ollamaModel: readStringEnv(e, "TALLEI_LLM__OLLAMA_MODEL", "qwen2.5:7b"),
    memoryMasterKey: readStringEnv(e, "TALLEI_AUTH__MEMORY_MASTER_KEY"),
    kmsKeyId: readStringEnv(e, "TALLEI_AUTH__KMS_KEY_ID", "local-dev"),
    enableSupabaseRlsPolicies: readBooleanEnv(e, "ENABLE_SUPABASE_RLS_POLICIES", true),
    // Phase 3 feature flags — shadow cutover for memory.ts extraction (ADR-007)
    memoryDualWriteEnabled: readBooleanEnv(e, "MEMORY_DUAL_WRITE_ENABLED", false),
    memoryShadowReadEnabled: readBooleanEnv(e, "MEMORY_SHADOW_READ_ENABLED", false),
    useNewSaveUseCase: readBooleanEnv(e, "TALLEI_FEATURE__USE_NEW_SAVE", false),
    useNewRecallUseCase: readBooleanEnv(e, "TALLEI_FEATURE__USE_NEW_RECALL", false),
    useNewListUseCase: readBooleanEnv(e, "TALLEI_FEATURE__USE_NEW_LIST", false),
    useNewDeleteUseCase: readBooleanEnv(e, "TALLEI_FEATURE__USE_NEW_DELETE", false),
    memoryApiRateLimitPerMinute: readIntEnv(e, "TALLEI_RATE__MEMORY_API_PER_MINUTE", 180),
    mcpRateLimitPerMinute: readIntEnv(e, "TALLEI_RATE__MCP_PER_MINUTE", 240),
    recallMinVectorScore: readFloatEnv(e, "TALLEI_MISC__RECALL_MIN_VECTOR_SCORE", 0.30),
    recallMinFallbackScore: readFloatEnv(e, "TALLEI_MISC__RECALL_MIN_FALLBACK_SCORE", 0.05),
    recallHybridSimilarityFloor: readFloatEnv(e, "TALLEI_MISC__RECALL_HYBRID_SIMILARITY_FLOOR", 0.35),
    rerankEnabled: readBooleanEnv(e, "TALLEI_FEATURE__RERANK", true),
    rerankMinScore: readFloatEnv(e, "TALLEI_MISC__RERANK_MIN_SCORE", 0.4),
    browserWorkerBaseUrl: e.TALLEI_BROWSER__WORKER_BASE_URL || "",
    browserWorkerApiKey: e.TALLEI_BROWSER__WORKER_API_KEY || "",
    browserMaxStudentRetries: readIntEnv(e, "TALLEI_BROWSER__MAX_RETRIES", 2),
    browserLlmFallbackEnabled: readBooleanEnv(e, "TALLEI_BROWSER__LLM_FALLBACK", true),
    browserWorkerWsEndpoint: e.TALLEI_BROWSER__WORKER_WS_ENDPOINT || "",
    browserSessionTtlMs: readIntEnv(e, "TALLEI_BROWSER__SESSION_TTL_MS", 900000),
    browserHeadless: readBooleanEnv(e, "TALLEI_BROWSER__HEADLESS", true),
    claudeConnectorMcpUrl:
      e.CLAUDE_CONNECTOR_MCP_URL || `${e.TALLEI_HTTP__PUBLIC_BASE_URL || localBaseUrl}/mcp`,
    lemonSqueezyApiKey: readStringEnv(e, "TALLEI_BILLING__LEMONSQUEEZY_API_KEY"),
    lemonSqueezyWebhookSecret: readStringEnv(e, "TALLEI_BILLING__LEMONSQUEEZY_WEBHOOK_SECRET"),
    lemonSqueezyProVariantId: readStringEnv(e, "TALLEI_BILLING__LEMONSQUEEZY_PRO_VARIANT_ID"),
    lemonSqueezyPowerVariantId: readStringEnv(e, "TALLEI_BILLING__LEMONSQUEEZY_POWER_VARIANT_ID"),
    lemonSqueezyTrialDays: readIntEnv(e, "TALLEI_BILLING__TRIAL_DAYS", 7),
    claudeProjectInstructionsTemplate:
      e.CLAUDE_PROJECT_INSTRUCTIONS_TEMPLATE ||
      "You have Tallei memory + document tools. Use them silently. Rules: (1) Do not call recall_memories unless prior-session context is needed; use the Pinned Preferences resource for stable preferences. (2) recall_memories defaults to fact+preference context and returns docs-lite briefs only. (3) include_doc_refs returns brief metadata only (no full document text). (4) Treat the latest 5 recent docs brief as first pass; if user names an older doc, call search_documents, then include matching refs. (5) Use remember as the unified save tool. (6) For new structured content in the current turn (file upload, pasted document/spec/transcript, list/table/data, extracted PDF text), auto-save with remember(kind='document-note', title, key_points, summary, source_hint) without waiting for permission. (7) In those auto-save turns, append exactly: 📎 Auto-saved as @doc:<ref> · reply **undo** to delete. (8) If the user replies 'undo'/'del'/'delete', call undo_save with that @doc ref immediately. (9) Use remember(kind='document-blob') only when the user asks for full archive/full stash of complete text. (10) Never mention tool internals besides the required auto-save footer.",
  } as const;
}

export const config = loadConfig();
export type Config = typeof config;
