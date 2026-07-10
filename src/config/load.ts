import "dotenv/config";

import { DEFAULT_CLAUDE_CONNECTOR_INSTRUCTIONS } from "./claude-connector-instructions.js";
import { applyEnvAliases } from "./env-aliases.js";
import { loadLlmConfig } from "./sections/llm.js";
import {
  normalizeBaseUrl,
  readBooleanEnv,
  readFloatEnv,
  readIntEnv,
  readOptionalIntEnv,
  readStringEnv,
  requireEnv,
} from "./schema.js";
export type { ImportExtractMode, ReasoningEffort } from "./types.js";

function resolveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return applyEnvAliases(env);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = resolveEnv(env);

  const port = readIntEnv(e, "TALLEI_HTTP__PORT", 3000);
  const nodeEnv = e.NODE_ENV || "development";
  const localModelModeDefault = nodeEnv !== "production";
  const localModelMode = readBooleanEnv(e, "TALLEI_LLM__LOCAL_MODEL_MODE", localModelModeDefault);
  const defaultQdrantCollectionName = localModelMode ? "memories_local_v1" : "memories_v1";
  const localBaseUrl = `http://localhost:${port}`;
  const configuredPublicBaseUrl = e.TALLEI_HTTP__PUBLIC_BASE_URL || localBaseUrl;
  const publicBaseUrl = normalizeBaseUrl(configuredPublicBaseUrl);
  const qdrantTimeoutMsOverride = readOptionalIntEnv(e, "TALLEI_QDRANT__TIMEOUT_MS");
  const llm = loadLlmConfig(e, { nodeEnv, localModelMode });

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
      (nodeEnv === "production" ? 30_000 : 10_000),
    ...llm,
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
    logLevel: readStringEnv(e, "TALLEI_OBS__LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
    prettyLogsEnabled: readBooleanEnv(e, "TALLEI_OBS__PRETTY_LOGS", nodeEnv === "development"),
    vertexSearchVerboseLoggingEnabled: readBooleanEnv(e, "TALLEI_OBS__VERTEX_SEARCH_VERBOSE", false),
    memoryMasterKey: readStringEnv(e, "TALLEI_AUTH__MEMORY_MASTER_KEY"),
    kmsKeyId: readStringEnv(e, "TALLEI_AUTH__KMS_KEY_ID", "local-dev"),
    uploadthingToken: readStringEnv(e, "TALLEI_STORAGE__UPLOADTHING_TOKEN"),
    enableSupabaseRlsPolicies: readBooleanEnv(e, "ENABLE_SUPABASE_RLS_POLICIES", true),
    // Phase 3 feature flags — shadow cutover for memory.ts extraction (ADR-007)
    memoryDualWriteEnabled: readBooleanEnv(e, "TALLEI_FEATURE__MEMORY_DUAL_WRITE", false),
    memoryShadowReadEnabled: readBooleanEnv(e, "TALLEI_FEATURE__MEMORY_SHADOW_READ", false),
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
    claudeProjectInstructionsTemplate: DEFAULT_CLAUDE_CONNECTOR_INSTRUCTIONS,
  } as const;
}

export const config = loadConfig();
export type Config = typeof config;
