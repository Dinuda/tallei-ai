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
import { invalidateBm25Cache } from "../infrastructure/recall/hybrid-retrieval.js";
import {
  bumpRecallStamp,
  readExactRecallPayload,
  writeRecallPayload,
} from "../infrastructure/recall/fast-recall.js";
import { bucketRecall } from "../infrastructure/recall/bucket-recall.js";
import { incrementWithTtl } from "../infrastructure/cache/redis-cache.js";
import { setRequestTimingFields } from "../observability/request-timing.js";
import { extractFacts } from "../orchestration/ai/fact-extract.usecase.js";
import { SaveMemoryUseCase } from "../orchestration/memory/save.usecase.js";
import type { SaveMemoryResult } from "../orchestration/memory/save.usecase.js";
import { RecallMemoryUseCase } from "../orchestration/memory/recall.usecase.js";
import type { RecallResult } from "../orchestration/memory/recall.usecase.js";
import { ListMemoriesUseCase } from "../orchestration/memory/list.usecase.js";
import type { ListedMemoriesPage } from "../orchestration/memory/list.usecase.js";
import { DeleteMemoryUseCase } from "../orchestration/memory/delete.usecase.js";
import type { RecallSource } from "../orchestration/memory/fallback-policy.js";
import type { MemoryType } from "../orchestration/memory/memory-types.js";
import { PlanRequiredError, QuotaExceededError } from "../shared/errors/index.js";

export type { RecallResult, SaveMemoryResult };
export { QuotaExceededError, PlanRequiredError };

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

function normalizeRecallTypes(types?: MemoryType[]): string {
  if (!types || types.length === 0) return "all";
  return [...new Set(types.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort().join(",");
}

function recallCacheKey(auth: AuthContext, query: string, limit: number, types?: MemoryType[]): string {
  return `${cacheScopeKey(auth)}:${limit}:${normalizeRecallQuery(query)}:${normalizeRecallTypes(types)}`;
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
  return /Qdrant|timeout|aborted|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|No route to host|connection error|fetch failed|APIConnectionError|EHOSTUNREACH|EAI_AGAIN/i.test(error.message);
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

function logRecallEvent(
  query: string,
  limit: number,
  auth: AuthContext,
  requesterIp: string | undefined,
  result: RecallResult,
  source: RecallSource,
  timingsMs: Record<string, number> = {}
): void {
  const cacheHit = source === "exact_cache" || source === "warm_cache";
  const recallLocalMs = timingsMs.recall_local_ms ?? 0;
  const recallStampMs = timingsMs.recall_stamp_ms ?? 0;
  const recallRedisMs = timingsMs.recall_redis_ms ?? 0;
  const recallBucketMs = timingsMs.recall_bucket_ms ?? 0;
  const recallLookupMs = timingsMs.cache_lookup_ms
    ?? (recallLocalMs + recallStampMs + recallRedisMs + recallBucketMs);
  setRequestTimingFields({
    recall_source: source,
    recall_cache_hit: cacheHit,
    recall_local_ms: recallLocalMs,
    recall_stamp_ms: recallStampMs,
    recall_redis_ms: recallRedisMs,
    recall_bucket_ms: recallBucketMs,
    recall_cache_lookup_ms: recallLookupMs,
    recall_embed_ms: timingsMs.embed_ms ?? 0,
    recall_vector_ms: timingsMs.vector_ms ?? 0,
    recall_total_ms: timingsMs.total_ms ?? 0,
  });
  void memoryRepository.logEvent({
    auth,
    action: "recall",
    ipHash: ipHash(requesterIp),
    metadata: {
      query, limit, hits: result.memories.length, source, cache_hit: cacheHit,
      recall_local_ms: recallLocalMs,
      recall_stamp_ms: recallStampMs,
      recall_redis_ms: recallRedisMs,
      recall_bucket_ms: recallBucketMs,
      cache_lookup_ms: recallLookupMs,
      embed_ms: timingsMs.embed_ms ?? 0,
      vector_ms: timingsMs.vector_ms ?? 0,
      total_ms: timingsMs.total_ms ?? 0,
    },
  }).catch((error) => { noteMemoryDbFailure(error, "recall-log"); });
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
  invalidateRecallCache,
  invalidateBm25Cache,
  bumpRecallStamp,
  ipHash,
  createQuotaExceededError: (message) => new QuotaExceededError(message),
  extractFacts,
  isEvalMode: IS_EVAL_MODE,
  freeSaveLimit: FREE_SAVE_LIMIT,
});

const recallMemoryUseCase = new RecallMemoryUseCase({
  recallCacheKey,
  getCachedRecall,
  setCachedRecall,
  readExactRecallPayload,
  writeRecallPayload,
  withTimeout,
  totalTimeoutMs: FAST_RECALL_TOTAL_TIMEOUT_MS,
  bucketRecall: async (query, auth) => {
    if (!IS_EVAL_MODE && auth.plan === "free") {
      const count = await countMonthlyEvents(auth.tenantId, "recall");
      if (count >= FREE_RECALL_LIMIT) {
        throw new QuotaExceededError(
          `Free plan limit reached: ${FREE_RECALL_LIMIT} recalls/month. Upgrade to Pro at tallei.app/dashboard/billing.`
        );
      }
    }
    return bucketRecall(query, auth);
  },
  memoryRepository,
  logRecallEvent,
  runRecallShadowChecks: () => {},
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
  bumpRecallStamp,
  ipHash,
});

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveMemory(
  content: string,
  auth: AuthContext,
  platform: string,
  requesterIp?: string,
  options?: {
    memoryType?: MemoryType;
    category?: string | null;
    isPinned?: boolean;
    preferenceKey?: string | null;
    runFactExtraction?: boolean;
  }
): Promise<SaveMemoryResult> {
  return saveMemoryUseCase.execute({
    content,
    auth,
    platform,
    requesterIp,
    memoryType: options?.memoryType,
    category: options?.category,
    isPinned: options?.isPinned,
    preferenceKey: options?.preferenceKey,
    runFactExtraction: options?.runFactExtraction,
  });
}

export async function recallMemories(
  query: string,
  auth: AuthContext,
  limit = 5,
  requesterIp?: string,
  options?: { types?: MemoryType[] }
): Promise<RecallResult> {
  return recallMemoryUseCase.execute({
    query,
    auth,
    limit,
    requesterIp,
    types: options?.types,
  });
}

export async function listMemories(auth: AuthContext) {
  const page = await listMemoriesUseCase.execute(auth, { limit: 200 });
  return page.memories;
}

export async function listMemoriesPage(
  auth: AuthContext,
  options?: {
    limit?: number;
    offset?: number;
  }
): Promise<ListedMemoriesPage> {
  return listMemoriesUseCase.execute(auth, {
    limit: options?.limit,
    offset: options?.offset,
    includeTotal: true,
  });
}

export async function deleteMemory(
  memoryId: string,
  auth: AuthContext,
  requesterIp?: string
): Promise<{ success: true }> {
  await deleteMemoryUseCase.execute({ memoryId, auth, requesterIp });
  return { success: true };
}

export async function savePreference(
  content: string,
  auth: AuthContext,
  platform: string,
  requesterIp?: string,
  options?: {
    category?: string | null;
    preferenceKey?: string | null;
    runFactExtraction?: boolean;
  }
): Promise<SaveMemoryResult> {
  return saveMemory(content, auth, platform, requesterIp, {
    memoryType: "preference",
    isPinned: true,
    category: options?.category ?? null,
    preferenceKey: options?.preferenceKey ?? null,
    runFactExtraction: options?.runFactExtraction,
  });
}

export async function listPreferences(auth: AuthContext) {
  const rows = await memoryRepository.listPreferences(auth, 200);
  return rows.map((row) => {
    let text = "";
    try {
      text = decryptMemoryContent(row.content_ciphertext);
    } catch {
      text = "[Encrypted memory unavailable]";
    }
    const summaryMeta = row.summary_json && typeof row.summary_json === "object"
      ? (row.summary_json as Record<string, unknown>)
      : {};
    return {
      id: row.id,
      text,
      category: row.category,
      isPinned: row.is_pinned,
      preferenceKey: typeof summaryMeta["preference_key"] === "string" ? summaryMeta["preference_key"] : null,
      referenceCount: row.reference_count,
      createdAt: row.created_at,
      metadata: summaryMeta,
    };
  });
}

export async function forgetPreference(
  preferenceId: string,
  auth: AuthContext,
  requesterIp?: string
): Promise<{ success: true }> {
  const row = await memoryRepository.getByIdScoped(auth, preferenceId, true);
  if (!row || row.memory_type !== "preference") {
    throw new Error("Preference not found");
  }
  return deleteMemory(preferenceId, auth, requesterIp);
}

// ── Prewarm ───────────────────────────────────────────────────────────────────

export function prewarmRecallCache(auth: AuthContext): void {
  const key = cacheScopeKey(auth);
  if (prewarmedUsers.has(key)) return;
  prewarmedUsers.add(key);
  void recallMemories("user projects preferences and tech stack", auth, 5).catch(() => {});
}
