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
import { coerceChatModelForLocalMode, resolveChatModelForCompatibleProvider } from "../services/llm/chat-model-routing.js";

function resolveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env;
}

/** OpenCode Go (/zen/go/v1) is Anthropic-format; Conductor uses OpenAI chat completions on /zen/v1. */
function normalizeOpenCodeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/zen/go/v1") || trimmed.endsWith("/zen/go")) {
    return trimmed.replace(/\/zen\/go(?:\/v1)?$/, "/zen/v1");
  }
  return trimmed || "https://opencode.ai/zen/v1";
}


export type ImportExtractMode = "heuristic" | "llm";

function readImportExtractMode(env: NodeJS.ProcessEnv): ImportExtractMode {
  const raw = readStringEnv(env, "TALLEI_IMPORT__EXTRACT_MODE", "heuristic").trim().toLowerCase();
  if (raw === "llm" || raw === "openai" || raw === "model") return "llm";
  return "heuristic";
}

/** Up to 8 numbered slots + comma-separated list + legacy single key. */
function readLlmApiKeyList(
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
  const legacy = readStringEnv(env, `${options.prefix}_API_KEY`, "").trim();
  if (legacy) keys.add(legacy);
  if (keys.size === 0 && options.legacyFallbackEnv) {
    const fallback = readStringEnv(env, options.legacyFallbackEnv, "").trim();
    if (fallback) keys.add(fallback);
  }
  return [...keys];
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
  const defaultLoopQdrantCollectionName = `${defaultQdrantCollectionName}_loop_episodes`;
  const localBaseUrl = `http://localhost:${port}`;
  const configuredPublicBaseUrl = e.TALLEI_HTTP__PUBLIC_BASE_URL || localBaseUrl;
  const publicBaseUrl = normalizeBaseUrl(configuredPublicBaseUrl);
  const qdrantTimeoutMsOverride = readOptionalIntEnv(e, "TALLEI_QDRANT__TIMEOUT_MS");
  const qdrantTimeoutSecondsLegacy = readOptionalIntEnv(e, "QDRANT_TIMEOUT_SECONDS"); // legacy only; no TALLEI_ form
  const defaultOllamaModel = readStringEnv(e, "TALLEI_LLM__OLLAMA_MODEL", "qwen3:14b");
  const defaultOpenCodeModel = readStringEnv(e, "TALLEI_LLM__OPENCODE_MODEL", "big-pickle");
  const openaiApiKeys = readLlmApiKeyList(e, { prefix: "TALLEI_LLM__OPENAI" });
  const opencodeApiKeys = readLlmApiKeyList(e, {
    prefix: "TALLEI_LLM__OPENCODE",
    ...(openaiApiKeys.length === 0 ? { legacyFallbackEnv: "TALLEI_LLM__OPENAI_API_KEY" } : {}),
  });
  const llmProvider = readStringEnv(e, "TALLEI_LLM__PROVIDER", defaultLlmProvider) as "openai" | "ollama" | "google" | "opencode";

  function readResolvedChatModel(key: string, productionDefault: string): string {
    const cloudDefault = llmProvider === "opencode" ? defaultOpenCodeModel : productionDefault;
    const fallback = localModelMode ? defaultOllamaModel : cloudDefault;
    const raw = readStringEnv(e, key, fallback);
    if (localModelMode) {
      return coerceChatModelForLocalMode(raw, localModelMode, defaultOllamaModel);
    }
    if (llmProvider === "opencode") {
      return resolveChatModelForCompatibleProvider(raw, defaultOpenCodeModel);
    }
    return raw;
  }

  function readResolvedOptionalChatModel(key: string): string {
    const raw = readStringEnv(e, key, "").trim();
    if (!raw) return "";
    if (localModelMode) {
      return coerceChatModelForLocalMode(raw, localModelMode, defaultOllamaModel);
    }
    if (llmProvider === "opencode") {
      return resolveChatModelForCompatibleProvider(raw, defaultOpenCodeModel);
    }
    return raw;
  }

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
      e.TALLEI_HTTP__DASHBOARD_BASE_URL ||
        e.TALLEI_HTTP__FRONTEND_URL ||
        "http://localhost:3001"
    ),
    frontendUrl: normalizeBaseUrl(
      e.TALLEI_HTTP__FRONTEND_URL || "http://localhost:3001"
    ),
    internalApiSecret: requireEnv(e, "TALLEI_HTTP__INTERNAL_API_SECRET"),
    mcpPublicUrl: e.TALLEI_HTTP__MCP_URL || "",
    databaseUrl: requireEnv(e, "TALLEI_DB__URL"),
    databaseUrlFallback: readStringEnv(e, "TALLEI_DB__URL_FALLBACK", "postgresql://tallei:tallei@localhost:5432/tallei"),
    dbAutoMigrateOnBoot: readBooleanEnv(
      e,
      "TALLEI_DB__AUTO_MIGRATE_ON_BOOT",
      nodeEnv !== "production"
    ),
    openaiApiKey: openaiApiKeys[0] ?? "",
    openaiApiKeys,
    anthropicApiKey: readStringEnv(e, "TALLEI_LLM__ANTHROPIC_API_KEY"),
    jwtSecret: requireEnv(e, "TALLEI_AUTH__JWT_SECRET"),
    apiKeyPepper: readStringEnv(e, "TALLEI_AUTH__API_KEY_PEPPER"),
    authContinuationPrivateKey: readStringEnv(e, "TALLEI_AUTH__CONTINUATION_PRIVATE_KEY"),
    authContinuationPublicKey: readStringEnv(e, "TALLEI_AUTH__CONTINUATION_PUBLIC_KEY"),
    authContinuationTtlSeconds: readIntEnv(e, "TALLEI_AUTH__CONTINUATION_TTL_SECONDS", 600),
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
    loopQdrantCollectionName: readStringEnv(e, "TALLEI_QDRANT__LOOP_COLLECTION", defaultLoopQdrantCollectionName),
    memoryVectorUpsertTimeoutMs: readIntEnv(
      e,
      "TALLEI_RESILIENCE__VECTOR_UPSERT_TIMEOUT_MS",
      nodeEnv === "production" ? 10_000 : 12_000
    ),
    memorySaveSummaryTimeoutMs: readIntEnv(
      e,
      "TALLEI_RESILIENCE__SAVE_SUMMARY_TIMEOUT_MS",
      nodeEnv === "production" ? 8_000 : 6_000
    ),
    memoryRecallEmbedTimeoutMs: readIntEnv(
      e,
      "TALLEI_RESILIENCE__RECALL_EMBED_TIMEOUT_MS",
      nodeEnv === "production" ? 15_000 : 15_000
    ),
    memoryRecallVectorTimeoutMs: readIntEnv(
      e,
      "TALLEI_RESILIENCE__RECALL_VECTOR_TIMEOUT_MS",
      nodeEnv === "production" ? 20_000 : 20_000
    ),
    memoryRecallTotalTimeoutMs: readIntEnv(
      e,
      "TALLEI_RESILIENCE__RECALL_TOTAL_TIMEOUT_MS",
      nodeEnv === "production" ? 30_000 : 30_000
    ),
    // Qdrant JS client expects timeout in milliseconds.
    qdrantTimeoutMs:
      qdrantTimeoutMsOverride ??
      (qdrantTimeoutSecondsLegacy !== null
        ? qdrantTimeoutSecondsLegacy * 1000
        : nodeEnv === "production"
          ? 30_000
          : 10_000),
    embeddingProvider: readStringEnv(e, "TALLEI_EMBED__PROVIDER", defaultEmbeddingProvider) as "openai" | "ollama" | "google",
    embeddingModel: readStringEnv(e, "TALLEI_EMBED__MODEL", defaultEmbeddingModel),
    googleEmbeddingModel: readStringEnv(e, "TALLEI_EMBED__GOOGLE_MODEL", "gemini-embedding-001"),
    embeddingDims: readIntEnv(e, "TALLEI_EMBED__DIMS", defaultEmbeddingDims),
    llmProvider,
    openaiModel: readResolvedChatModel("TALLEI_LLM__CHAT_MODEL", "gpt-gpt-5-nano"),
    googleModel: readStringEnv(e, "TALLEI_LLM__GOOGLE_MODEL", "gemini-2.0-flash"),
    importMemoryExtractModel: readResolvedChatModel("TALLEI_IMPORT__MEMORY_EXTRACT_MODEL", "gpt-5-nano"),
    importKeepHighThreshold: readFloatEnv(e, "TALLEI_IMPORT__KEEP_HIGH_THRESHOLD", 0.45),
    importKeepWeakThreshold: readFloatEnv(e, "TALLEI_IMPORT__KEEP_WEAK_THRESHOLD", 0.35),
    importMaxExtractConversations: readIntEnv(e, "TALLEI_IMPORT__MAX_EXTRACT_CONVERSATIONS", 120),
    importExtractConcurrency: readIntEnv(e, "TALLEI_IMPORT__EXTRACT_CONCURRENCY", 6),
    importExtractMode: readImportExtractMode(e),
    importStorageDir: readStringEnv(e, "TALLEI_IMPORT__STORAGE_DIR", ""),
    importMaxUploadBytes: readIntEnv(e, "TALLEI_IMPORT__MAX_UPLOAD_BYTES", 1_610_612_736),
    importBatchSize: readIntEnv(e, "TALLEI_IMPORT__BATCH_SIZE", 500),
    importMaxAgeDays: readIntEnv(e, "TALLEI_IMPORT__MAX_AGE_DAYS", 365),
    importInclusiveKeepHighThreshold: readFloatEnv(e, "TALLEI_IMPORT__INCLUSIVE_KEEP_HIGH_THRESHOLD", 0.30),
    importInclusiveKeepWeakThreshold: readFloatEnv(e, "TALLEI_IMPORT__INCLUSIVE_KEEP_WEAK_THRESHOLD", 0.20),
    importInclusiveMaxExtractConversations: readIntEnv(e, "TALLEI_IMPORT__INCLUSIVE_MAX_EXTRACT_CONVERSATIONS", 500),
    googleApiKey: readStringEnv(e, "TALLEI_GOOGLE__API_KEY"),
    googleProjectId: readStringEnv(e, "TALLEI_GOOGLE__PROJECT_ID"),
    googleLocation: readStringEnv(e, "TALLEI_GOOGLE__LOCATION", "us-central1"),
    vertexDocumentSearchEnabled: readBooleanEnv(e, "TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH", false),
    vertexDocumentSearchShadowEnabled: readBooleanEnv(e, "TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH_SHADOW", false),
    vertexDocumentSearchNewUsersEnabled: readBooleanEnv(e, "TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH_NEW_USERS", true),
    vertexDocumentSearchTenantAllowlist: readStringEnv(e, "TALLEI_VERTEX_SEARCH__TENANT_ALLOWLIST")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    vertexDocumentSearchUserAllowlist: readStringEnv(e, "TALLEI_VERTEX_SEARCH__USER_ALLOWLIST")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    vertexSearchDataStore: readStringEnv(e, "TALLEI_VERTEX_SEARCH__DATA_STORE"),
    vertexSearchServingConfig: readStringEnv(e, "TALLEI_VERTEX_SEARCH__SERVING_CONFIG"),
    agentEngineIssuer: readStringEnv(e, "TALLEI_AGENT_ENGINE__ISSUER", "tallei-agent-engine"),
    intentClassifierModel: readResolvedChatModel("TALLEI_LLM__INTENT_CLASSIFIER_MODEL", "gpt-5-nano"),
    plannerModel: readResolvedChatModel("TALLEI_PLANNER__MODEL", "gpt-gpt-5-nano"),
    plannerMaxQuestions: readIntEnv(e, "TALLEI_PLANNER__MAX_QUESTIONS", 12),
    plannerWebSearchBudget: readIntEnv(e, "TALLEI_PLANNER__WEB_SEARCH_BUDGET", 8),
    plannerRequestTimeoutMs: readIntEnv(e, "TALLEI_PLANNER__REQUEST_TIMEOUT_MS", 20_000),
    loopTestRunMaxSteps: readIntEnv(e, "TALLEI_LOOPS__TEST_RUN_MAX_STEPS", 2),
    loopTestRunTimeoutMs: readIntEnv(
      e,
      "TALLEI_LOOPS__TEST_RUN_TIMEOUT_MS",
      Math.max(60_000, readIntEnv(e, "TALLEI_PLANNER__REQUEST_TIMEOUT_MS", 20_000) * 2 + 10_000),
    ),
    /** Max simultaneous event-triggered runs per workspace; 0 = unlimited. */
    loopMaxConcurrentEventRuns: Math.max(0, readIntEnv(e, "TALLEI_LOOPS__MAX_CONCURRENT_EVENT_RUNS", 0)),
    loopMinerModel: readResolvedChatModel("TALLEI_LOOP_MINER__MODEL", "gpt-gpt-5-nano"),
    loopMinerEpisodeModel: readResolvedOptionalChatModel("TALLEI_LOOP_MINER__EPISODE_MODEL"),
    loopMinerDetectorModel: readResolvedOptionalChatModel("TALLEI_LOOP_MINER__DETECTOR_MODEL"),
    loopMinerEvaluatorModel: readResolvedOptionalChatModel("TALLEI_LOOP_MINER__EVALUATOR_MODEL"),
    loopMinerDnaModel: readResolvedOptionalChatModel("TALLEI_LOOP_MINER__DNA_MODEL"),
    loopMinerPromptBudgetTokens: readIntEnv(e, "TALLEI_LOOP_MINER__PROMPT_BUDGET_TOKENS", 4000),
    loopMinerEventSummaryCharCap: readIntEnv(e, "TALLEI_LOOP_MINER__EVENT_SUMMARY_CHAR_CAP", 900),
    loopMinerTranscriptSnippetsMax: readIntEnv(e, "TALLEI_LOOP_MINER__TRANSCRIPT_SNIPPETS_MAX", 2),
    loopMinerTranscriptSnippetCharCap: readIntEnv(e, "TALLEI_LOOP_MINER__TRANSCRIPT_SNIPPET_CHAR_CAP", 220),
    loopMinerChatTimeoutMs: readIntEnv(e, "TALLEI_LOOP_MINER__CHAT_TIMEOUT_MS", 30_000),
    loopMinerMaxEvidenceDays: readIntEnv(e, "TALLEI_LOOP_MINER__MAX_EVIDENCE_DAYS", 14),
    loopMinerMaxEventsPerRun: readIntEnv(e, "TALLEI_LOOP_MINER__MAX_EVENTS_PER_RUN", 0),
    openaiPayloadLoggingEnabled: readBooleanEnv(e, "TALLEI_OBS__OPENAI_PAYLOAD_LOGGING_ENABLED", false),
    openaiPayloadLoggingMaxChars: Math.max(
      64,
      Math.min(readIntEnv(e, "TALLEI_OBS__OPENAI_PAYLOAD_LOGGING_MAX_CHARS", 2000), 20_000)
    ),
    logLevel: readStringEnv(e, "TALLEI_OBS__LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
    prettyLogsEnabled: readBooleanEnv(e, "TALLEI_OBS__PRETTY_LOGS", nodeEnv === "development"),
    vertexSearchVerboseLoggingEnabled: readBooleanEnv(e, "TALLEI_OBS__VERTEX_SEARCH_VERBOSE", false),
    ollamaBaseUrl: readStringEnv(e, "TALLEI_LLM__OLLAMA_BASE_URL", "http://localhost:11434/v1"),
    ollamaModel: defaultOllamaModel,
    opencodeBaseUrl: normalizeOpenCodeBaseUrl(
      readStringEnv(e, "TALLEI_LLM__OPENCODE_BASE_URL", "https://opencode.ai/zen/v1"),
    ),
    opencodeModel: defaultOpenCodeModel,
    opencodeApiKey: opencodeApiKeys[0] ?? "",
    opencodeApiKeys,
    conductorModel: readResolvedChatModel(
      "TALLEI_CONDUCTOR__MODEL",
      readResolvedChatModel("TALLEI_LOOP_BUILDER__OPENAI_MODEL", defaultOpenCodeModel),
    ),
    memoryMasterKey: readStringEnv(e, "TALLEI_AUTH__MEMORY_MASTER_KEY"),
    kmsKeyId: readStringEnv(e, "TALLEI_AUTH__KMS_KEY_ID", "local-dev"),
    uploadthingToken: readStringEnv(e, "TALLEI_STORAGE__UPLOADTHING_TOKEN"),
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
    browserWorkerRequestTimeoutMs: readIntEnv(e, "TALLEI_BROWSER__REQUEST_TIMEOUT_MS", 45_000),
    browserMaxStudentRetries: readIntEnv(e, "TALLEI_BROWSER__MAX_RETRIES", 2),
    browserLlmFallbackEnabled: readBooleanEnv(e, "TALLEI_BROWSER__LLM_FALLBACK", true),
    browserWorkerWsEndpoint: e.TALLEI_BROWSER__WORKER_WS_ENDPOINT || "",
    browserSessionTtlMs: readIntEnv(e, "TALLEI_BROWSER__SESSION_TTL_MS", 900000),
    browserHeadless: readBooleanEnv(e, "TALLEI_BROWSER__HEADLESS", true),
    hyperbrowserApiKey: readStringEnv(e, "TALLEI_BROWSER__HYPERBROWSER_API_KEY", ""),
    browserTeacherThreshold: readIntEnv(e, "TALLEI_BROWSER__TEACHER_THRESHOLD", 3),
    uploadIngestWorkerEnabled: readBooleanEnv(e, "TALLEI_WORKERS__UPLOAD_INGEST_ENABLED", true),
    uploadIngestWorkerPollMs: readIntEnv(e, "TALLEI_WORKERS__UPLOAD_INGEST_POLL_MS", 150),
    uploadIngestWorkerBatchSize: readIntEnv(e, "TALLEI_WORKERS__UPLOAD_INGEST_BATCH_SIZE", 4),
    uploadIngestWorkerConcurrency: readIntEnv(e, "TALLEI_WORKERS__UPLOAD_INGEST_CONCURRENCY", 2),
    uploadIngestWorkerMaxAttempts: readIntEnv(e, "TALLEI_WORKERS__UPLOAD_INGEST_MAX_ATTEMPTS", 4),
    uploadIngestWorkerRetryBaseMs: readIntEnv(e, "TALLEI_WORKERS__UPLOAD_INGEST_RETRY_BASE_MS", 5_000),
    uploadIngestWorkerRetryMaxMs: readIntEnv(e, "TALLEI_WORKERS__UPLOAD_INGEST_RETRY_MAX_MS", 300_000),
    chatGptImportWorkerEnabled: readBooleanEnv(e, "TALLEI_WORKERS__CHATGPT_IMPORT_ENABLED", true),
    chatGptImportWorkerPollMs: readIntEnv(e, "TALLEI_WORKERS__CHATGPT_IMPORT_POLL_MS", 200),
    chatGptImportWorkerBatchSize: readIntEnv(e, "TALLEI_WORKERS__CHATGPT_IMPORT_BATCH_SIZE", 2),
    chatGptImportWorkerConcurrency: readIntEnv(e, "TALLEI_WORKERS__CHATGPT_IMPORT_CONCURRENCY", 1),
    chatGptImportWorkerMaxAttempts: readIntEnv(e, "TALLEI_WORKERS__CHATGPT_IMPORT_MAX_ATTEMPTS", 4),
    chatGptImportWorkerRetryBaseMs: readIntEnv(e, "TALLEI_WORKERS__CHATGPT_IMPORT_RETRY_BASE_MS", 3_000),
    chatGptImportWorkerRetryMaxMs: readIntEnv(e, "TALLEI_WORKERS__CHATGPT_IMPORT_RETRY_MAX_MS", 120_000),
    vertexDocumentBackfillWorkerEnabled: readBooleanEnv(e, "TALLEI_WORKERS__VERTEX_BACKFILL_ENABLED", false),
    vertexDocumentBackfillWorkerPollMs: readIntEnv(e, "TALLEI_WORKERS__VERTEX_BACKFILL_POLL_MS", 60_000),
    vertexDocumentBackfillWorkerBatchSize: readIntEnv(e, "TALLEI_WORKERS__VERTEX_BACKFILL_BATCH_SIZE", 10),
    vertexDocumentBackfillMaxAttempts: readIntEnv(e, "TALLEI_WORKERS__VERTEX_BACKFILL_MAX_ATTEMPTS", 8),
    dailyIntelligenceWorkerEnabled: readBooleanEnv(e, "TALLEI_WORKERS__DAILY_INTELLIGENCE_ENABLED", false),
    dailyIntelligenceWorkerPollMs: readIntEnv(e, "TALLEI_WORKERS__DAILY_INTELLIGENCE_POLL_MS", 24 * 60 * 60 * 1000),
    dailyIntelligenceWorkerBatchSize: readIntEnv(e, "TALLEI_WORKERS__DAILY_INTELLIGENCE_BATCH_SIZE", 100),
    notificationsEmailAdapter: readStringEnv(e, "TALLEI_NOTIFICATIONS__EMAIL_ADAPTER", "resend"),
    notificationsOutboundEmailEnabled: readBooleanEnv(e, "TALLEI_NOTIFICATIONS__OUTBOUND_EMAIL_ENABLED", nodeEnv === "production"),
    notificationsWhatsAppAdapter: readStringEnv(e, "TALLEI_NOTIFICATIONS__WHATSAPP_ADAPTER", "disabled"),
    notificationsWhatsAppWebhookUrl: readStringEnv(e, "TALLEI_NOTIFICATIONS__WHATSAPP_WEBHOOK_URL"),
    notificationsWhatsAppWebhookToken: readStringEnv(e, "TALLEI_NOTIFICATIONS__WHATSAPP_WEBHOOK_TOKEN"),
    notificationsDeliveryMaxAttempts: readIntEnv(e, "TALLEI_NOTIFICATIONS__DELIVERY_MAX_ATTEMPTS", 3),
    notificationsDeliveryRetryBaseMs: readIntEnv(e, "TALLEI_NOTIFICATIONS__DELIVERY_RETRY_BASE_MS", 2_000),
    channelsTelegramBotToken: readStringEnv(e, "TALLEI_CHANNELS__TELEGRAM_BOT_TOKEN"),
    channelsTelegramBotUsername: readStringEnv(e, "TALLEI_CHANNELS__TELEGRAM_BOT_USERNAME"),
    channelsTelegramWebhookSecret: readStringEnv(e, "TALLEI_CHANNELS__TELEGRAM_WEBHOOK_SECRET"),
    channelsWhatsAppOpenWaUrl: normalizeBaseUrl(readStringEnv(e, "TALLEI_CHANNELS__WHATSAPP_OPENWA_URL")),
    channelsWhatsAppOpenWaToken: readStringEnv(e, "TALLEI_CHANNELS__WHATSAPP_OPENWA_TOKEN"),
    channelsWhatsAppSharedNumber: readStringEnv(e, "TALLEI_CHANNELS__WHATSAPP_SHARED_NUMBER"),
    channelsWhatsAppWebhookToken: readStringEnv(e, "TALLEI_CHANNELS__WHATSAPP_WEBHOOK_TOKEN"),
    channelsResendInboundDomain: readStringEnv(e, "TALLEI_CHANNELS__RESEND_INBOUND_DOMAIN"),
    adminEmail: readStringEnv(e, "TALLEI_ADMIN__EMAIL"),
    adminSlackWebhookUrl: readStringEnv(e, "TALLEI_ADMIN__SLACK_WEBHOOK_URL"),
    composioApiKey: readStringEnv(e, "TALLEI_CONNECTORS__COMPOSIO_API_KEY"),
    composioBaseUrl: normalizeBaseUrl(readStringEnv(e, "TALLEI_CONNECTORS__COMPOSIO_BASE_URL", "https://backend.composio.dev")),
    composioAuthConfigId: readStringEnv(e, "TALLEI_CONNECTORS__COMPOSIO_AUTH_CONFIG_ID"),
    composioWebhookSecret: readStringEnv(e, "TALLEI_CONNECTORS__COMPOSIO_WEBHOOK_SECRET"),
    composioEntityPrefix: readStringEnv(e, "TALLEI_CONNECTORS__COMPOSIO_ENTITY_PREFIX", "tallei"),
    composioStrictMode: readBooleanEnv(e, "TALLEI_CONNECTORS__COMPOSIO_STRICT_MODE", false),
    resendPortalUrl: normalizeBaseUrl(readStringEnv(e, "TALLEI_CONNECTORS__RESEND_PORTAL_URL", "https://resend.com/overview")),
    resendApiKeysUrl: normalizeBaseUrl(readStringEnv(e, "TALLEI_CONNECTORS__RESEND_API_KEYS_URL", "https://resend.com/api-keys")),
    resendDocsUrl: normalizeBaseUrl(readStringEnv(e, "TALLEI_CONNECTORS__RESEND_DOCS_URL", "https://resend.com/docs/dashboard/api-keys/introduction")),
    workflowTargetWorld: readStringEnv(e, "TALLEI_WORKFLOW__TARGET_WORLD", ""),
    workflowPostgresJobPrefix: readStringEnv(e, "TALLEI_WORKFLOW__POSTGRES_JOB_PREFIX", "tallei"),
    workflowPostgresQueueConcurrency: readIntEnv(e, "TALLEI_WORKFLOW__POSTGRES_QUEUE_CONCURRENCY", 10),
    loopExecutorScheduler: readStringEnv(e, "TALLEI_LOOP_EXECUTOR__SCHEDULER", "internal") === "cloudflare"
      ? "cloudflare" as const
      : "internal" as const,
    loopExecutorPollMs: readIntEnv(e, "TALLEI_LOOP_EXECUTOR__POLL_MS", 30_000),
    loopExecutorSchedulerBatchSize: readIntEnv(e, "TALLEI_LOOP_EXECUTOR__BATCH_SIZE", 4),
    loopExecutorHeartbeatDispatch: readStringEnv(e, "TALLEI_LOOP_EXECUTOR__HEARTBEAT_DISPATCH", "internal") === "cloudflare"
      ? "cloudflare" as const
      : "internal" as const,
    loopExecutorHeartbeatPollMs: readIntEnv(e, "TALLEI_LOOP_EXECUTOR__HEARTBEAT_POLL_MS", 2_000),
    loopExecutorHeartbeatBatchSize: readIntEnv(e, "TALLEI_LOOP_EXECUTOR__HEARTBEAT_BATCH_SIZE", 4),
    temporalEnabled: readBooleanEnv(e, "TALLEI_TEMPORAL__ENABLED", false),
    temporalAddress: readStringEnv(e, "TALLEI_TEMPORAL__ADDRESS", "localhost:7233"),
    temporalNamespace: readStringEnv(e, "TALLEI_TEMPORAL__NAMESPACE", "default"),
    temporalTaskQueue: readStringEnv(e, "TALLEI_TEMPORAL__TASK_QUEUE", "tallei-loops"),
    loopExecutorNewsletterLiveWebSearchEnabled: readBooleanEnv(e, "TALLEI_LOOP_EXECUTOR__NEWSLETTER_LIVE_WEB_SEARCH_ENABLED", nodeEnv === "production"),
    claudeConnectorMcpUrl:
      e.CLAUDE_CONNECTOR_MCP_URL || `${e.TALLEI_HTTP__PUBLIC_BASE_URL || localBaseUrl}/mcp`,
    lemonSqueezyApiKey: readStringEnv(e, "TALLEI_BILLING__LEMONSQUEEZY_API_KEY"),
    lemonSqueezyWebhookSecret: readStringEnv(e, "TALLEI_BILLING__LEMONSQUEEZY_WEBHOOK_SECRET"),
    lemonSqueezyProVariantId: readStringEnv(e, "TALLEI_BILLING__LEMONSQUEEZY_PRO_VARIANT_ID"),
    lemonSqueezyPowerVariantId: readStringEnv(e, "TALLEI_BILLING__LEMONSQUEEZY_POWER_VARIANT_ID"),
    lemonSqueezyTrialDays: readIntEnv(e, "TALLEI_BILLING__TRIAL_DAYS", 7),
    signupResendApiKey: readStringEnv(e, "TALLEI_SIGNUP__RESEND_API_KEY"),
    signupSlackWebhookUrl: readStringEnv(e, "TALLEI_SIGNUP__SLACK_WEBHOOK_URL"),
    signupFailurePingWebhookUrl: readStringEnv(e, "TALLEI_SIGNUP__FAILURE_PING_WEBHOOK_URL"),
    signupFailurePingWebhookToken: readStringEnv(e, "TALLEI_SIGNUP__FAILURE_PING_WEBHOOK_TOKEN"),
    signupEmailFromName: readStringEnv(e, "TALLEI_SIGNUP__EMAIL_FROM_NAME", "Dinuda Yaggahavita"),
    signupEmailFromEmail: readStringEnv(e, "TALLEI_SIGNUP__EMAIL_FROM_EMAIL"),
    signupEmailReplyTo: readStringEnv(e, "TALLEI_SIGNUP__EMAIL_REPLY_TO"),
    // Keep connector instructions versioned in code to avoid stale env copies causing behavior drift.
    claudeProjectInstructionsTemplate:
      `You are a Tallei-connected Claude. You have Tallei memory + document tools. Use them silently.

=== TURN PROTOCOL ===

STEP 0 — COLLAB TASKS FIRST:
- If the user asks to continue/resume/proceed a collab task, or includes a task UUID, call collab_check_turn first.
- Do NOT call recall_memories to resolve collab task state.
- Build your turn from collab_check_turn.fallback_context and recent_transcript.
- If is_my_turn=false, tell the user which actor is currently expected and stop.
- If is_my_turn=true, produce the task output and submit it with collab_take_turn.
- If the user asks to start/create/begin collab and no task exists yet, call collab_create_task immediately in the same turn. Do not ask planning questions first.
- If the user provides explicit collab task arguments (title/brief/first_actor), call collab_create_task with those exact values before any explanatory text. Do not set max_iterations.
- Do NOT output copy/paste workflows, manual setup steps, or "you can do this" alternatives when collab tools are available.
- Use first_actor="chatgpt" by default unless the user explicitly asks for Claude first.
- For collab_create_task, pass recall_query (use user goal/brief/title) and include_doc_refs when user references specific @doc handles to preload.
- If files are attached this turn, pass them to collab_create_task via openaiFileIdRefs (and conversation_id when available) so recall preflight runs first and docs are ingested/bundled at creation time.
- If collab_create_task returns upload failures, show concise file errors and continue with task execution unless creation itself failed.
- If the user says "@tallei decide" and no task exists yet, call collab_create_task first, then continue with collab_check_turn/collab_take_turn.
- If the user says "@tallei ship", return structured execution output (PRD/tickets/checklist/owner/due date) and submit that exact output to collab_take_turn.
- For every collab_take_turn call, submit the full user-facing deliverable content. Do not submit summary-only text.
- After collab_take_turn succeeds, show the actual submitted output content in your reply (not just "task completed").

STEP A — RECALL WHEN NEEDED:
- Do NOT call recall_memories reflexively.
- Call recall_memories only when prior-session context is required.
- recall_memories defaults to facts + preferences and returns docs-lite context only.
- include_doc_refs returns brief metadata only (no full document text).
- recall_memories also includes a brief list of the latest 5 uploaded docs.
- If the user references an older doc by name, call search_documents first and then include matching refs.
- Use recall_document only when full document text is explicitly needed.

STEP B — ANSWER:
- Answer the user directly.

STEP C — SAVE/ARCHIVE (optional):
- Save/upload to Tallei only when the user explicitly asks to save, archive, or checkpoint.
- If saving, append exactly this footer on its own line:
  📎 Auto-saved as @doc:<ref> · reply **undo** to delete

STEP D — UNDO:
- If the user replies "undo", "del", or "delete" after that footer, call undo_save with that @doc ref immediately.

=== ONGOING ===
- Use remember(kind="preference") for stable preferences and identity facts.
- Use remember(kind="fact") for non-preference facts, decisions, events, notes, and corrections.
- Use remember(kind="document-blob") only when the user explicitly asks for full archive/full stash of complete text.
- Final deliverables must match the user's requested format. If no format is requested, default to plain text.

=== HARD RULE ===
- Never mention tool internals in user-facing text, except the optional auto-save footer when saving is requested.`,
  } as const;
}

export const config = loadConfig();
export type Config = typeof config;
