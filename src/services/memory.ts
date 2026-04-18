import { randomUUID, createHash } from "crypto";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import type { AuthContext } from "../types/auth.js";
import type { ConversationSummary } from "./summarizer.js";
import { summarizeConversation } from "./summarizer.js";
import { decryptMemoryContent, encryptMemoryContent, hashMemoryContent } from "./crypto.js";
import { embedText } from "./embeddings.js";
import { MemoryRepository } from "../repositories/memoryRepository.js";
import { VectorRepository } from "../repositories/vectorRepository.js";
import {
  enqueueGraphExtractionJob,
  invalidateRecallV2Cache,
  recallMemoriesV2,
} from "./memoryGraph.js";
import { rerankMemories, ragSearchMemories } from "./reranker.js";
import { hybridRecall, invalidateBm25Cache } from "./hybridRetrieval.js";
import { extractFacts } from "./factExtractor.js";
import {
  buildRecentFallback,
  bumpRecallStamp,
  readExactRecallPayload,
  readWarmRecallPayload,
  runBackgroundRecallEnrichment,
  writeRecallPayload,
} from "./fastRecall.js";
import {
  lookupPrecomputedRecallV1,
  markSnapshotStale,
  queueSnapshotRefresh,
} from "./precomputedGraphRecall.js";
import {
  legacyDeleteMemory,
  legacyListMemories,
  legacyRecallMemories,
  legacySaveMemory,
} from "./legacyMemory.js";
import { incrementWithTtl } from "./cache.js";
import { setRequestTimingFields } from "./requestTiming.js";

export class QuotaExceededError extends Error {
  constructor(public readonly message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

const FREE_SAVE_LIMIT = 50;
const FREE_RECALL_LIMIT = 200;
const SAVE_QUOTA_TTL_SECONDS = 35 * 24 * 60 * 60;
const IS_EVAL_MODE = config.nodeEnv !== "production" && process.env["EVAL_MODE"] === "true";

function currentYearMonthBucket(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function monthlySaveQuotaKey(tenantId: string): string {
  return `quota:${tenantId}:save:${currentYearMonthBucket()}`;
}

async function countMonthlyEvents(tenantId: string, action: string): Promise<number> {
  const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const result = await pool.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM memory_events
     WHERE tenant_id = $1 AND action = $2 AND created_at >= $3`,
    [tenantId, action, periodStart]
  );
  return result.rows[0]?.cnt ?? 0;
}

async function consumeMonthlySaveQuota(auth: AuthContext): Promise<number> {
  if (IS_EVAL_MODE) return 0;
  if (auth.plan !== "free") return 0;
  return incrementWithTtl(monthlySaveQuotaKey(auth.tenantId), SAVE_QUOTA_TTL_SECONDS);
}

const memoryRepository = new MemoryRepository();
const vectorRepository = new VectorRepository();

const RECALL_TTL_MS = 10 * 60_000;
const VECTOR_BYPASS_TTL_MS = config.nodeEnv === "production" ? 0 : 60_000;
const VECTOR_WARN_INTERVAL_MS = 30_000;
const MEMORY_DB_TIMEOUT_MS = config.nodeEnv === "production" ? 10_000 : 2_500;
const MEMORY_EMBED_TIMEOUT_MS = config.nodeEnv === "production" ? 4_000 : 2_500;
const MEMORY_VECTOR_SEARCH_TIMEOUT_MS = config.nodeEnv === "production" ? 2_000 : 1_250;
const MEMORY_VECTOR_UPSERT_TIMEOUT_MS = config.memoryVectorUpsertTimeoutMs;
const FAST_RECALL_EMBED_TIMEOUT_MS = config.memoryRecallEmbedTimeoutMs;
const FAST_RECALL_VECTOR_TIMEOUT_MS = config.memoryRecallVectorTimeoutMs;
const FAST_RECALL_TOTAL_TIMEOUT_MS = config.memoryRecallTotalTimeoutMs;

interface CachedRecall {
  result: RecallResult;
  exp: number;
}

type RecallSource =
  | "exact_cache"
  | "warm_cache"
  | "recent_fallback"
  | "semantic_enriched"
  | "precomputed_graph_hit"
  | "precomputed_graph_miss"
  | "precomputed_graph_stale";

const recallCache = new Map<string, CachedRecall>();
const prewarmedUsers = new Set<string>();
const reindexCooldown = new Map<string, number>();
const REINDEX_COOLDOWN_MS = 5 * 60_000;
let vectorBypassUntil = 0;
let lastVectorWarnAt = 0;
let lastMemoryDbWarnAt = 0;

function cacheScopeKey(auth: AuthContext): string {
  return `${auth.tenantId}:${auth.userId}`;
}

function recallCacheKey(auth: AuthContext, query: string, limit: number): string {
  return `${cacheScopeKey(auth)}:${limit}:${normalizeRecallQuery(query)}`;
}

function recallEnrichmentKey(auth: AuthContext, query: string, limit: number): string {
  return `${cacheScopeKey(auth)}:${limit}:${normalizeRecallQuery(query)}:v1`;
}

function invalidateRecallCache(auth: AuthContext): void {
  const prefix = `${cacheScopeKey(auth)}:`;
  for (const key of recallCache.keys()) {
    if (key.startsWith(prefix)) {
      recallCache.delete(key);
    }
  }
}

function isVectorInfraError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Qdrant|timeout|aborted|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|No route to host/i.test(error.message);
}

function shouldBypassVector(): boolean {
  return VECTOR_BYPASS_TTL_MS > 0 && Date.now() < vectorBypassUntil;
}

function noteVectorFailure(error: unknown, context: string): void {
  if (VECTOR_BYPASS_TTL_MS > 0 && isVectorInfraError(error)) {
    vectorBypassUntil = Date.now() + VECTOR_BYPASS_TTL_MS;
  }

  if (config.nodeEnv !== "production") {
    const now = Date.now();
    if (now - lastVectorWarnAt >= VECTOR_WARN_INTERVAL_MS) {
      lastVectorWarnAt = now;
      console.warn(`[memory] vector pipeline degraded (${context})`, error);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function noteMemoryDbFailure(error: unknown, context: string): void {
  if (config.nodeEnv === "production") return;
  const now = Date.now();
  if (now - lastMemoryDbWarnAt < VECTOR_WARN_INTERVAL_MS) return;
  lastMemoryDbWarnAt = now;
  console.warn(`[memory] db pipeline degraded (${context})`, error);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function normalizeRecallQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function fallbackScore(query: string, text: string, createdAt: string): number {
  const queryTokens = new Set(tokenize(query));
  const textTokens = tokenize(text);
  let overlap = 0;
  for (const token of textTokens) {
    if (queryTokens.has(token)) overlap += 1;
  }

  const recencyDays = Math.max(
    0,
    (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  const recencyScore = Math.max(0, 1 - recencyDays / 30);
  const lexicalScore = queryTokens.size === 0 ? 0 : overlap / queryTokens.size;

  return Number((lexicalScore * 0.75 + recencyScore * 0.25).toFixed(4));
}

function buildFallbackSummary(rawContent: string): ConversationSummary {
  const cleaned = rawContent.trim().replace(/\s+/g, " ");
  const snippet = cleaned.slice(0, 180);
  return {
    title: snippet.length > 0 ? snippet : "Untitled Memory",
    keyPoints: snippet.length > 0 ? [snippet] : [],
    decisions: [],
    summary: snippet.length > 0 ? snippet : "No summary available.",
  };
}

function buildMemoryText(platform: string, summary: ConversationSummary, rawContent: string): string {
  return [
    `[${platform.toUpperCase()}] ${summary.title}`,
    summary.keyPoints.length > 0 ? `Key Points: ${summary.keyPoints.join("; ")}` : "",
    summary.decisions.length > 0 ? `Decisions: ${summary.decisions.join("; ")}` : "",
    `Summary: ${summary.summary}`,
    `Raw: ${rawContent.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildEmbeddingText(platform: string, rawContent: string): string {
  return `[${platform.toUpperCase()}]\n${rawContent.trim()}`;
}

function ipHash(ip?: string): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex");
}

function compareShadowResults(primary: RecallResult, legacy: { memories: Array<{ id: string }> }): boolean {
  if (primary.memories.length !== legacy.memories.length) return false;
  const left = primary.memories.map((m) => m.id).sort();
  const right = legacy.memories.map((m) => m.id).sort();
  if (left.length !== right.length) return false;
  return left.every((value, idx) => value === right[idx]);
}

export interface SaveMemoryResult {
  memoryId: string;
  title: string;
  summary: ConversationSummary;
}

export interface RecallResult {
  contextBlock: string;
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
}

async function reindexUserMemories(auth: AuthContext): Promise<void> {
  const scopeKey = cacheScopeKey(auth);
  if ((reindexCooldown.get(scopeKey) ?? 0) > Date.now()) return;
  // Mark cooldown immediately so concurrent recalls don't stack re-indexes.
  reindexCooldown.set(scopeKey, Date.now() + REINDEX_COOLDOWN_MS);

  let rows: Awaited<ReturnType<typeof memoryRepository.listAll>> = [];
  try {
    rows = await memoryRepository.listAll(auth);
  } catch (error) {
    noteMemoryDbFailure(error, "reindex-list");
    return;
  }
  if (rows.length === 0) return;

  let reindexed = 0;
  for (const row of rows) {
    try {
      const text = decryptMemoryContent(row.content_ciphertext);
      const vector = await embedText(text);
      await vectorRepository.upsertMemoryVector({
        auth,
        memoryId: row.id,
        pointId: row.qdrant_point_id || row.id,
        vector,
        platform: row.platform,
        createdAt: row.created_at,
      });
      reindexed += 1;
    } catch (error) {
      noteVectorFailure(error, `reindex:${row.id}`);
    }
  }

  console.log(`[reindex] completed for user ${auth.userId}: ${reindexed}/${rows.length} memories re-embedded`);
  invalidateRecallCache(auth);
  invalidateRecallV2Cache(auth);
}

export function prewarmRecallCache(auth: AuthContext): void {
  const key = cacheScopeKey(auth);
  if (prewarmedUsers.has(key)) return;
  prewarmedUsers.add(key);
  void recallMemories("user projects preferences and tech stack", auth, 5).catch(() => {});
}

export async function saveMemory(
  content: string,
  auth: AuthContext,
  platform: string,
  requesterIp?: string
): Promise<SaveMemoryResult> {
  const saveStartedAt = process.hrtime.bigint();
  const normalizedContent = content.trim();
  const summary = buildFallbackSummary(normalizedContent);
  const memoryId = randomUUID();
  const createdAt = new Date().toISOString();

  const encryptStartedAt = process.hrtime.bigint();
  const encrypted = encryptMemoryContent(normalizedContent);
  const contentHash = hashMemoryContent(normalizedContent);
  const encryptMs = Number(process.hrtime.bigint() - encryptStartedAt) / 1_000_000;

  const quotaPromise = (async () => {
    const startedAt = process.hrtime.bigint();
    const count = await consumeMonthlySaveQuota(auth);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    return { count, elapsedMs };
  })();
  const insertPromise = (async () => {
    const startedAt = process.hrtime.bigint();
    await memoryRepository.create(auth, {
      id: memoryId,
      contentCiphertext: encrypted,
      contentHash,
      platform,
      summaryJson: summary,
      qdrantPointId: memoryId,
    });
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  })();

  const [quotaOutcome, insertOutcome] = await Promise.allSettled([quotaPromise, insertPromise]);
  if (insertOutcome.status === "rejected") {
    throw insertOutcome.reason;
  }

  const insertMs = insertOutcome.value;
  const quotaMs = quotaOutcome.status === "fulfilled" ? quotaOutcome.value.elapsedMs : 0;
  const quotaCount = quotaOutcome.status === "fulfilled" ? quotaOutcome.value.count : 0;
  const quotaMode = IS_EVAL_MODE
    ? "bypassed_eval"
    : auth.plan === "free"
      ? (quotaOutcome.status === "fulfilled" ? "redis" : "fail_open")
      : "skipped";
  if (auth.plan === "free" && quotaCount > FREE_SAVE_LIMIT) {
    await memoryRepository.softDeleteScoped(auth, memoryId).catch((error) => {
      noteMemoryDbFailure(error, "save-quota-soft-delete");
    });
    throw new QuotaExceededError(
      `Free plan limit reached: ${FREE_SAVE_LIMIT} saves/month. Upgrade to Pro at tallei.app/dashboard/billing.`
    );
  }

  const saveTotalMs = Number(process.hrtime.bigint() - saveStartedAt) / 1_000_000;
  setRequestTimingFields({
    save_summary_ms: 0,
    save_quota_ms: quotaMs,
    save_encrypt_ms: encryptMs,
    save_insert_ms: insertMs,
    save_db_write_ms: insertMs,
    save_service_ms: saveTotalMs,
    save_quota_mode: quotaMode,
    save_vector_mode: shouldBypassVector() ? "bypass" : "background",
  });

  void (async () => {
    const embedAndUpsert = async () => {
      if (shouldBypassVector()) return;
      try {
        const vector = await withTimeout(
          embedText(buildEmbeddingText(platform, normalizedContent)),
          MEMORY_EMBED_TIMEOUT_MS,
          "save.embed"
        );
        await withTimeout(
          vectorRepository.upsertMemoryVector({
            auth,
            memoryId,
            pointId: memoryId,
            vector,
            platform,
            createdAt,
          }),
          MEMORY_VECTOR_UPSERT_TIMEOUT_MS,
          "save.upsert"
        );
      } catch (error) {
        noteVectorFailure(error, "save_bg");
      }
    };

    const extractAndSaveFacts = async () => {
      try {
        const facts = await extractFacts(normalizedContent);
        for (const fact of facts) {
          try {
            const factText = `[FACT] ${fact.text}${fact.temporal_context ? ` (${fact.temporal_context})` : ""}`;
            const factEncrypted = encryptMemoryContent(factText);
            const factHash = hashMemoryContent(factText);
            const factId = randomUUID();
            await memoryRepository.create(auth, {
              id: factId,
              contentCiphertext: factEncrypted,
              contentHash: factHash,
              platform: `fact:${platform}`,
              summaryJson: { source: "extracted_fact", subject: fact.subject, supersedes: fact.supersedes_pattern },
              qdrantPointId: factId,
            });
            const factVector = await embedText(factText).catch(() => null);
            if (factVector) {
              await vectorRepository.upsertMemoryVector({
                auth,
                memoryId: factId,
                pointId: factId,
                vector: factVector,
                platform: `fact:${platform}`,
                createdAt: new Date().toISOString(),
              }).catch(() => {});
            }
          } catch {
            // Best-effort; fact save failures don't block the primary memory.
          }
        }
        invalidateBm25Cache(auth);
      } catch {
        // Best-effort; fact extraction failures don't block the primary memory.
      }
    };

    const summarizeAndUpdate = async () => {
      if (IS_EVAL_MODE) return;
      try {
        const refinedSummary = await summarizeConversation(normalizedContent);
        const refinedContent = buildMemoryText(platform, refinedSummary, normalizedContent);
        await memoryRepository.updateContentAndSummaryScoped(auth, memoryId, {
          contentCiphertext: encryptMemoryContent(refinedContent),
          contentHash: hashMemoryContent(refinedContent),
          summaryJson: refinedSummary,
        });
      } catch (error) {
        if (config.nodeEnv !== "production") {
          console.warn("[memory] background summary update failed", error);
        }
      }
    };

    await Promise.allSettled([
      embedAndUpsert(),
      extractAndSaveFacts(),
      summarizeAndUpdate(),
    ]);
  })();

  void enqueueGraphExtractionJob(auth, memoryId).catch((error) => {
    if (config.nodeEnv !== "production") {
      console.warn("[graph] failed to enqueue extraction job", error);
    }
  });

  void memoryRepository.logEvent({
    auth,
    action: "save",
    memoryId,
    ipHash: ipHash(requesterIp),
    metadata: { platform },
  }).catch((error) => {
    noteMemoryDbFailure(error, "save-log");
  });

  invalidateRecallCache(auth);
  invalidateRecallV2Cache(auth);
  invalidateBm25Cache(auth);
  void bumpRecallStamp(auth).catch(() => {});
  void markSnapshotStale(auth).catch(() => {});
  void queueSnapshotRefresh(auth, "save_memory", 1_000).catch(() => {});

  if (config.memoryDualWriteEnabled) {
    void legacySaveMemory(content, auth.userId, platform).catch((error) => {
      console.error("[memory] legacy dual-write failed", error);
    });
  }

  return {
    memoryId,
    title: summary.title,
    summary,
  };
}

async function semanticRecallMemories(
  query: string,
  auth: AuthContext,
  limit = 5,
  _requesterIp?: string
): Promise<{ result: RecallResult; timingsMs: Record<string, number> }> {
  const cacheKey = recallCacheKey(auth, query, limit);
  const cached = recallCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) {
    return { result: cached.result, timingsMs: {} };
  }

  if (!IS_EVAL_MODE && auth.plan === "free") {
    const count = await countMonthlyEvents(auth.tenantId, "recall");
    if (count >= FREE_RECALL_LIMIT) {
      throw new QuotaExceededError(
        `Free plan limit reached: ${FREE_RECALL_LIMIT} recalls/month. Upgrade to Pro at tallei.app/dashboard/billing.`
      );
    }
  }

  // Hybrid retrieval: parallel BM25 + vector + entity matching fused with RRF
  const hybrid = await hybridRecall(query, auth, limit);

  return {
    result: { contextBlock: hybrid.contextBlock, memories: hybrid.memories },
    timingsMs: hybrid.timingsMs,
  };
}

function runRecallShadowChecks(
  query: string,
  auth: AuthContext,
  limit: number,
  result: RecallResult
): void {
  if (config.memoryShadowReadEnabled && config.memoryDualWriteEnabled) {
    void legacyRecallMemories(query, auth.userId, limit)
      .then(async (legacyResult) => {
        if (!compareShadowResults(result, legacyResult)) {
          await memoryRepository.logEvent({
            auth,
            action: "shadow_divergence",
            metadata: {
              query,
              limit,
              primaryCount: result.memories.length,
              legacyCount: legacyResult.memories.length,
            },
          });
        }
      })
      .catch((error) => {
        console.error("[memory] shadow-read failed", error);
      });
  }

  if (config.recallV2ShadowMode) {
    void recallMemoriesV2(query, auth, limit, 1)
      .then(async (v2) => {
        const left = result.memories.map((m) => m.id).sort();
        const right = v2.memories.map((m) => m.id).sort();
        const same =
          left.length === right.length && left.every((value, idx) => value === right[idx]);
        if (!same) {
          await memoryRepository.logEvent({
            auth,
            action: "shadow_divergence",
            metadata: {
              operation: "recall_v2_shadow",
              query,
              limit,
              baselineCount: left.length,
              v2Count: right.length,
              baselineTop: left.slice(0, 5),
              v2Top: right.slice(0, 5),
            },
          });
        }
      })
      .catch((error) => {
        if (config.nodeEnv !== "production") {
          console.warn("[memory] recall_v2 shadow check failed", error);
        }
      });
  }
}

function logRecallEvent(
  query: string,
  limit: number,
  auth: AuthContext,
  requesterIp: string | undefined,
  result: RecallResult,
  source: RecallSource,
  timingsMs: Record<string, number> = {},
  snapshot: { status?: string; lookupMs?: number; ageMs?: number } = {}
): void {
  const cacheHit = source === "exact_cache" || source === "warm_cache";
  setRequestTimingFields({
    recall_source: source,
    recall_cache_hit: cacheHit,
    recall_cache_lookup_ms: timingsMs.cache_lookup_ms ?? 0,
    recall_fallback_ms: source === "recent_fallback" ? timingsMs.fallback_ms ?? 0 : 0,
    recall_relevance_miss: (timingsMs.relevance_miss ?? 0) > 0,
    recall_enrich_ms: timingsMs.enrich_ms ?? 0,
    recall_embed_ms: timingsMs.embed_ms ?? 0,
    recall_vector_ms: timingsMs.vector_ms ?? 0,
    recall_graph_ms: timingsMs.graph_ms ?? 0,
    recall_total_ms: timingsMs.total_ms ?? 0,
    recall_snapshot_status: snapshot.status ?? null,
    recall_snapshot_lookup_ms: snapshot.lookupMs ?? 0,
    recall_snapshot_age_ms: snapshot.ageMs ?? 0,
  });
  void memoryRepository.logEvent({
    auth,
    action: "recall",
    ipHash: ipHash(requesterIp),
    metadata: {
      query,
      limit,
      hits: result.memories.length,
      source,
      cache_hit: cacheHit,
      cache_lookup_ms: timingsMs.cache_lookup_ms ?? 0,
      fallback_ms: source === "recent_fallback" ? timingsMs.fallback_ms ?? 0 : 0,
      relevance_miss: (timingsMs.relevance_miss ?? 0) > 0,
      enrich_ms: timingsMs.enrich_ms ?? 0,
      embed_ms: timingsMs.embed_ms ?? 0,
      vector_ms: timingsMs.vector_ms ?? 0,
      graph_ms: timingsMs.graph_ms ?? 0,
      total_ms: timingsMs.total_ms ?? 0,
      snapshot_status: snapshot.status ?? null,
      snapshot_lookup_ms: snapshot.lookupMs ?? 0,
      snapshot_age_ms: snapshot.ageMs ?? 0,
    },
  }).catch((error) => {
    noteMemoryDbFailure(error, "recall-log");
  });
}

export async function recallMemories(
  query: string,
  auth: AuthContext,
  limit = 5,
  requesterIp?: string
): Promise<RecallResult> {
  const lookupStartedAt = process.hrtime.bigint();
  const cacheLookupMs = () => Number(process.hrtime.bigint() - lookupStartedAt) / 1_000_000;
  const boundedLimit = Math.min(20, Math.max(1, limit));
  const normalizedQuery = normalizeRecallQuery(query);
  const cacheKey = recallCacheKey(auth, normalizedQuery, boundedLimit);
  const cached = recallCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) {
    logRecallEvent(query, boundedLimit, auth, requesterIp, cached.result, "exact_cache", {
      cache_lookup_ms: cacheLookupMs(),
    });
    return cached.result;
  }

  const exactHit = await readExactRecallPayload<RecallResult>(auth, normalizedQuery, "v1");
  if (exactHit) {
    recallCache.set(cacheKey, { result: exactHit, exp: Date.now() + RECALL_TTL_MS });
    logRecallEvent(query, boundedLimit, auth, requesterIp, exactHit, "exact_cache", {
      cache_lookup_ms: cacheLookupMs(),
    });
    runRecallShadowChecks(query, auth, boundedLimit, exactHit);
    return exactHit;
  }

  const warmHit = await readWarmRecallPayload<RecallResult>(auth, normalizedQuery, "v1");
  if (warmHit) {
    recallCache.set(cacheKey, { result: warmHit, exp: Date.now() + RECALL_TTL_MS });
    runBackgroundRecallEnrichment(
      recallEnrichmentKey(auth, normalizedQuery, boundedLimit),
      async () => {
        const enriched = await withTimeout(
          semanticRecallMemories(normalizedQuery, auth, boundedLimit),
          FAST_RECALL_TOTAL_TIMEOUT_MS,
          "recall.enrichTotal"
        );
        recallCache.set(cacheKey, { result: enriched.result, exp: Date.now() + RECALL_TTL_MS });
        await writeRecallPayload(auth, normalizedQuery, "v1", enriched.result);
        await memoryRepository.logEvent({
          auth,
          action: "recall_enrich",
          metadata: {
            query: normalizedQuery,
            limit: boundedLimit,
            source: "semantic_enriched",
            cache_hit: false,
            enrich_ms: enriched.timingsMs.total_ms ?? 0,
            embed_ms: enriched.timingsMs.embed_ms ?? 0,
            vector_ms: enriched.timingsMs.vector_ms ?? 0,
            graph_ms: 0,
          },
        });
      }
    );
    logRecallEvent(query, boundedLimit, auth, requesterIp, warmHit, "warm_cache", {
      cache_lookup_ms: cacheLookupMs(),
    });
    runRecallShadowChecks(query, auth, boundedLimit, warmHit);
    return warmHit;
  }

  const snapshotLookup = await lookupPrecomputedRecallV1(auth, normalizedQuery, boundedLimit);
  if (snapshotLookup.status === "hit" && snapshotLookup.result) {
    recallCache.set(cacheKey, { result: snapshotLookup.result, exp: Date.now() + RECALL_TTL_MS });
    void writeRecallPayload(auth, normalizedQuery, "v1", snapshotLookup.result).catch(() => {});
    logRecallEvent(
      query,
      boundedLimit,
      auth,
      requesterIp,
      snapshotLookup.result,
      "precomputed_graph_hit",
      {
        cache_lookup_ms: cacheLookupMs(),
        total_ms: snapshotLookup.snapshot_lookup_ms,
      },
      {
        status: snapshotLookup.status,
        lookupMs: snapshotLookup.snapshot_lookup_ms,
        ageMs: snapshotLookup.snapshot_age_ms,
      }
    );
    runRecallShadowChecks(query, auth, boundedLimit, snapshotLookup.result);
    return snapshotLookup.result;
  }

  const fallback = await buildRecentFallback(auth, normalizedQuery, boundedLimit);
  if (fallback.relevanceMiss) {
    void queueSnapshotRefresh(auth, "fallback_relevance_miss_v1", 750).catch(() => {});
  }
  const result: RecallResult = {
    contextBlock: fallback.contextBlock,
    memories: fallback.memories,
  };
  recallCache.set(cacheKey, { result, exp: Date.now() + RECALL_TTL_MS });

  runBackgroundRecallEnrichment(
    recallEnrichmentKey(auth, normalizedQuery, boundedLimit),
    async () => {
      const enriched = await withTimeout(
        semanticRecallMemories(normalizedQuery, auth, boundedLimit),
        FAST_RECALL_TOTAL_TIMEOUT_MS,
        "recall.enrichTotal"
      );
      recallCache.set(cacheKey, { result: enriched.result, exp: Date.now() + RECALL_TTL_MS });
      await writeRecallPayload(auth, normalizedQuery, "v1", enriched.result);
      await memoryRepository.logEvent({
        auth,
        action: "recall_enrich",
        metadata: {
          query: normalizedQuery,
          limit: boundedLimit,
          source: "semantic_enriched",
          cache_hit: false,
          enrich_ms: enriched.timingsMs.total_ms ?? 0,
          embed_ms: enriched.timingsMs.embed_ms ?? 0,
          vector_ms: enriched.timingsMs.vector_ms ?? 0,
          graph_ms: 0,
        },
      });
    }
  );
  const fallbackSource: RecallSource =
    snapshotLookup.status === "miss"
      ? "precomputed_graph_miss"
      : snapshotLookup.status === "stale"
        ? "precomputed_graph_stale"
        : "recent_fallback";
  logRecallEvent(query, boundedLimit, auth, requesterIp, result, fallbackSource, {
    cache_lookup_ms: cacheLookupMs(),
    fallback_ms: fallback.elapsedMs,
    total_ms: fallback.elapsedMs,
    relevance_miss: fallback.relevanceMiss ? 1 : 0,
  }, {
    status: snapshotLookup.status,
    lookupMs: snapshotLookup.snapshot_lookup_ms,
    ageMs: snapshotLookup.snapshot_age_ms,
  });
  runRecallShadowChecks(query, auth, boundedLimit, result);

  return result;
}

export async function listMemories(auth: AuthContext) {
  const rows = await memoryRepository.list(auth, 200);

  const memories = rows.map((row) => {
    let text = "";
    try {
      text = decryptMemoryContent(row.content_ciphertext);
    } catch {
      text = "[Encrypted memory unavailable]";
    }

    const metadata = (row.summary_json && typeof row.summary_json === "object"
      ? (row.summary_json as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    return {
      id: row.id,
      text,
      metadata: {
        ...metadata,
        platform: row.platform,
      },
      createdAt: row.created_at,
    };
  });

  void memoryRepository.logEvent({
    auth,
    action: "list",
    metadata: { count: memories.length },
  }).catch((error) => {
    noteMemoryDbFailure(error, "list-log");
  });

  if (config.memoryShadowReadEnabled && config.memoryDualWriteEnabled) {
    void legacyListMemories(auth.userId)
      .then(async (legacy) => {
        if (legacy.length !== memories.length) {
          await memoryRepository.logEvent({
            auth,
            action: "shadow_divergence",
            metadata: {
              operation: "list",
              primaryCount: memories.length,
              legacyCount: legacy.length,
            },
          });
        }
      })
      .catch((error) => {
        console.error("[memory] legacy list shadow-read failed", error);
      });
  }

  return memories;
}

export async function deleteMemory(memoryId: string, auth: AuthContext, requesterIp?: string) {
  const deleted = await memoryRepository.softDeleteScoped(auth, memoryId);
  if (!deleted) {
    throw new Error("Memory not found or not owned by user");
  }

  try {
    await vectorRepository.deleteMemoryVector(auth, memoryId);
  } catch (error) {
    noteVectorFailure(error, "delete");
  }
  void memoryRepository.logEvent({
    auth,
    action: "delete",
    memoryId,
    ipHash: ipHash(requesterIp),
  }).catch((error) => {
    noteMemoryDbFailure(error, "delete-log");
  });

  if (config.memoryDualWriteEnabled) {
    void legacyDeleteMemory(memoryId).catch((error) => {
      console.error("[memory] legacy delete failed", error);
    });
  }

  invalidateRecallCache(auth);
  invalidateRecallV2Cache(auth);
  void bumpRecallStamp(auth).catch(() => {});
  void markSnapshotStale(auth).catch(() => {});
  void queueSnapshotRefresh(auth, "delete_memory", 1_000).catch(() => {});
  return { success: true };
}
