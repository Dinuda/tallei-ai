/**
 * Memory service — public API for all memory CRUD operations.
 *
 * This module owns the module-level caches, helper functions, use-case
 * instantiation (with full DI wiring), and the four exported async functions
 * that the transport layer calls.  No feature-flag routing remains — all paths
 * go through the new use-case layer unconditionally.
 *
 * See docs/adr/007-feature-flagged-shadow-cutover.md for the migration history.
 */

import { createHash } from "crypto";

import { config } from "../config/index.js";
import { pool } from "../infrastructure/db/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { decryptMemoryContent } from "../infrastructure/crypto/memory-crypto.js";
import { MemoryRepository } from "../infrastructure/repositories/memory.repository.js";
import { VectorRepository } from "../infrastructure/repositories/vector.repository.js";
import {
  enqueueGraphExtractionJob,
  invalidateRecallV2Cache,
  recallMemoriesV2,
} from "../orchestration/graph/recall-v2.usecase.js";
import { hybridRecall, invalidateBm25Cache } from "../infrastructure/recall/hybrid-retrieval.js";
import { extractFacts } from "../orchestration/ai/fact-extract.usecase.js";
import {
  buildRecentFallback,
  bumpRecallStamp,
  readExactRecallPayload,
  readWarmRecallPayload,
  runBackgroundRecallEnrichment,
  writeRecallPayload,
} from "../infrastructure/recall/fast-recall.js";
import {
  lookupPrecomputedRecallV1,
  markSnapshotStale,
  queueSnapshotRefresh,
} from "../orchestration/graph/precomputed-recall.usecase.js";
import { incrementWithTtl } from "../infrastructure/cache/redis-cache.js";
import { setRequestTimingFields } from "../observability/request-timing.js";
import { SaveMemoryUseCase } from "../orchestration/memory/save.usecase.js";
import type { SaveMemoryResult } from "../orchestration/memory/save.usecase.js";
import { RecallMemoryUseCase } from "../orchestration/memory/recall.usecase.js";
import type { RecallResult } from "../orchestration/memory/recall.usecase.js";
import { ListMemoriesUseCase } from "../orchestration/memory/list.usecase.js";
import { DeleteMemoryUseCase } from "../orchestration/memory/delete.usecase.js";
import type { RecallSource } from "../orchestration/memory/fallback-policy.js";
import { QuotaExceededError } from "../shared/errors/index.js";

export type { RecallResult, SaveMemoryResult };
export { QuotaExceededError };

// ── Constants ─────────────────────────────────────────────────────────────────

const FREE_SAVE_LIMIT = 50;
const FREE_RECALL_LIMIT = 200;
const SAVE_QUOTA_TTL_SECONDS = 35 * 24 * 60 * 60;
const IS_EVAL_MODE = config.nodeEnv !== "production" && process.env["EVAL_MODE"] === "true";

const RECALL_TTL_MS = 10 * 60_000;
const VECTOR_BYPASS_TTL_MS = config.nodeEnv === "production" ? 0 : 60_000;
const VECTOR_WARN_INTERVAL_MS = 30_000;
const FAST_RECALL_TOTAL_TIMEOUT_MS = config.memoryRecallTotalTimeoutMs;

// ── Module-level state ────────────────────────────────────────────────────────

interface CachedRecall {
  result: RecallResult;
  exp: number;
}

const RECALL_CACHE_MAX_SIZE = 500;
const recallCache = new Map<string, CachedRecall>();
const prewarmedUsers = new Set<string>();
let vectorBypassUntil = 0;
let lastVectorWarnAt = 0;
let lastMemoryDbWarnAt = 0;

// ── Repository instances ──────────────────────────────────────────────────────

const memoryRepository = new MemoryRepository();
const vectorRepository = new VectorRepository();

// ── Helpers ───────────────────────────────────────────────────────────────────

function cacheScopeKey(auth: AuthContext): string {
  return `${auth.tenantId}:${auth.userId}`;
}

export function normalizeRecallQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function recallCacheKey(auth: AuthContext, query: string, limit: number): string {
  return `${cacheScopeKey(auth)}:${limit}:${normalizeRecallQuery(query)}`;
}

function recallEnrichmentKey(auth: AuthContext, query: string, limit: number): string {
  return `${cacheScopeKey(auth)}:${limit}:${normalizeRecallQuery(query)}:v1`;
}

function getCachedRecall(cacheKey: string): RecallResult | null {
  const cached = recallCache.get(cacheKey);
  if (!cached) return null;
  if (cached.exp <= Date.now()) {
    recallCache.delete(cacheKey);
    return null;
  }
  return cached.result;
}

function setCachedRecall(cacheKey: string, result: RecallResult): void {
  if (recallCache.size >= RECALL_CACHE_MAX_SIZE) {
    const firstKey = recallCache.keys().next().value;
    if (firstKey !== undefined) recallCache.delete(firstKey);
  }
  recallCache.set(cacheKey, { result, exp: Date.now() + RECALL_TTL_MS });
}

export function invalidateRecallCache(auth: AuthContext): void {
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

export function shouldBypassVector(): boolean {
  return VECTOR_BYPASS_TTL_MS > 0 && Date.now() < vectorBypassUntil;
}

export function noteVectorFailure(error: unknown, context: string): void {
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

export function noteMemoryDbFailure(error: unknown, context: string): void {
  if (config.nodeEnv === "production") return;
  const now = Date.now();
  if (now - lastMemoryDbWarnAt < VECTOR_WARN_INTERVAL_MS) return;
  lastMemoryDbWarnAt = now;
  console.warn(`[memory] db pipeline degraded (${context})`, error);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

export function ipHash(ip?: string): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex");
}

// ── Quota ─────────────────────────────────────────────────────────────────────

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

// ── Shadow-mode helpers (passed as use-case deps) ─────────────────────────────

function runRecallShadowChecks(
  query: string,
  auth: AuthContext,
  limit: number,
  result: RecallResult
): void {
  if (!config.recallV2ShadowMode) return;
  void recallMemoriesV2(query, auth, limit, 1)
    .then(async (v2) => {
      const left = result.memories.map((m) => m.id).sort();
      const right = v2.memories.map((m) => m.id).sort();
      const same = left.length === right.length && left.every((v, i) => v === right[i]);
      if (!same) {
        await memoryRepository.logEvent({
          auth,
          action: "shadow_divergence",
          metadata: {
            operation: "recall_v2_shadow", query, limit,
            baselineCount: left.length, v2Count: right.length,
            baselineTop: left.slice(0, 5), v2Top: right.slice(0, 5),
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
      query, limit, hits: result.memories.length, source, cache_hit: cacheHit,
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
  }).catch((error) => { noteMemoryDbFailure(error, "recall-log"); });
}

// ── Semantic recall (passed as dep to RecallMemoryUseCase) ────────────────────

async function semanticRecallMemories(
  query: string,
  auth: AuthContext,
  limit = 5,
  _requesterIp?: string
): Promise<{ result: RecallResult; timingsMs: Record<string, number> }> {
  if (!IS_EVAL_MODE && auth.plan === "free") {
    const count = await countMonthlyEvents(auth.tenantId, "recall");
    if (count >= FREE_RECALL_LIMIT) {
      throw new QuotaExceededError(
        `Free plan limit reached: ${FREE_RECALL_LIMIT} recalls/month. Upgrade to Pro at tallei.app/dashboard/billing.`
      );
    }
  }
  const hybrid = await hybridRecall(query, auth, limit);
  return { result: { contextBlock: hybrid.contextBlock, memories: hybrid.memories }, timingsMs: hybrid.timingsMs };
}

// ── Use-case instances ────────────────────────────────────────────────────────

const saveMemoryUseCase = new SaveMemoryUseCase({
  consumeMonthlySaveQuota,
  memoryRepository,
  vectorRepository,
  shouldBypassVector,
  noteVectorFailure,
  noteMemoryDbFailure,
  setRequestTimingFields,
  enqueueGraphExtractionJob,
  invalidateRecallCache,
  invalidateRecallV2Cache,
  invalidateBm25Cache,
  bumpRecallStamp,
  markSnapshotStale,
  queueSnapshotRefresh,
  ipHash,
  createQuotaExceededError: (message) => new QuotaExceededError(message),
  isEvalMode: IS_EVAL_MODE,
  freeSaveLimit: FREE_SAVE_LIMIT,
});

const recallMemoryUseCase = new RecallMemoryUseCase({
  normalizeRecallQuery,
  recallCacheKey,
  recallEnrichmentKey,
  getCachedRecall,
  setCachedRecall,
  readExactRecallPayload,
  readWarmRecallPayload,
  writeRecallPayload,
  runBackgroundRecallEnrichment,
  withTimeout,
  fastRecallTotalTimeoutMs: FAST_RECALL_TOTAL_TIMEOUT_MS,
  hybridRecall,
  memoryRepository,
  lookupPrecomputedRecallV1,
  buildRecentFallback,
  queueSnapshotRefresh,
  logRecallEvent,
  runRecallShadowChecks,
});

const listMemoriesUseCase = new ListMemoriesUseCase({
  memoryRepository,
  decryptMemoryContent,
  noteMemoryDbFailure,
});

const deleteMemoryUseCase = new DeleteMemoryUseCase({
  memoryRepository,
  vectorRepository,
  noteVectorFailure,
  noteMemoryDbFailure,
  invalidateRecallCache,
  invalidateRecallV2Cache,
  bumpRecallStamp,
  markSnapshotStale,
  queueSnapshotRefresh,
  ipHash,
});

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveMemory(
  content: string,
  auth: AuthContext,
  platform: string,
  requesterIp?: string
): Promise<SaveMemoryResult> {
  return saveMemoryUseCase.execute({ content, auth, platform, requesterIp });
}

export async function recallMemories(
  query: string,
  auth: AuthContext,
  limit = 5,
  requesterIp?: string
): Promise<RecallResult> {
  return recallMemoryUseCase.execute({ query, auth, limit, requesterIp });
}

export async function listMemories(auth: AuthContext) {
  return listMemoriesUseCase.execute(auth);
}

export async function deleteMemory(
  memoryId: string,
  auth: AuthContext,
  requesterIp?: string
): Promise<{ success: true }> {
  await deleteMemoryUseCase.execute({ memoryId, auth, requesterIp });
  return { success: true };
}

// ── Prewarm ───────────────────────────────────────────────────────────────────

export function prewarmRecallCache(auth: AuthContext): void {
  const key = cacheScopeKey(auth);
  if (prewarmedUsers.has(key)) return;
  prewarmedUsers.add(key);
  void recallMemories("user projects preferences and tech stack", auth, 5).catch(() => {});
}
