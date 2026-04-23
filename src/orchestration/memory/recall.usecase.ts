import type { AuthContext } from "../../domain/auth/index.js";
import type { MemoryType } from "./memory-types.js";
import type { RecallSource } from "./fallback-policy.js";
import type { BucketRecallResult } from "../../infrastructure/recall/bucket-recall.js";
import type { RecallCacheLookupTimings } from "../../infrastructure/recall/fast-recall.js";
import type { ConflictHint } from "../../infrastructure/recall/scoring-utils.js";

export interface RecallResult {
  contextBlock: string;
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
  conflictHints?: ConflictHint[];
}

interface RecallMemoryUseCaseDeps {
  readonly recallCacheKey: (auth: AuthContext, query: string, limit: number, types?: MemoryType[]) => string;
  readonly getCachedRecall: (key: string) => RecallResult | null;
  readonly setCachedRecall: (key: string, result: RecallResult) => void;
  readonly readExactRecallPayload: <T>(
    auth: AuthContext,
    query: string,
    slot: "v1" | "v2",
    timings?: Partial<RecallCacheLookupTimings>
  ) => Promise<T | null>;
  readonly writeRecallPayload: <T>(auth: AuthContext, query: string, slot: "v1" | "v2", payload: T) => Promise<void>;
  readonly withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
  readonly totalTimeoutMs: number;
  readonly bucketRecall: (query: string, auth: AuthContext) => Promise<BucketRecallResult>;
  readonly logRecallEvent: (
    query: string,
    limit: number,
    auth: AuthContext,
    requesterIp: string | undefined,
    result: RecallResult,
    source: RecallSource,
    timingsMs?: Record<string, number>
  ) => void;
  readonly runRecallShadowChecks: (query: string, auth: AuthContext, limit: number, result: RecallResult) => void;
  readonly memoryRepository: {
    logEvent(input: {
      auth: AuthContext;
      action: string;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
}

interface RecallMemoryUseCaseInput {
  readonly query: string;
  readonly auth: AuthContext;
  readonly limit?: number;
  readonly requesterIp?: string;
  readonly types?: MemoryType[];
}

export class RecallMemoryUseCase {
  private readonly deps: RecallMemoryUseCaseDeps;
  private static readonly SPECULATIVE_BUCKET_DELAY_MS = 35;

  constructor(deps: RecallMemoryUseCaseDeps) {
    this.deps = deps;
  }

  async execute(input: RecallMemoryUseCaseInput): Promise<RecallResult> {
    const t0 = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - t0) / 1_000_000;

    const boundedLimit = Math.min(20, Math.max(1, input.limit ?? 5));
    const normalizedQuery = input.query.trim().toLowerCase().replace(/\s+/g, " ");
    const cacheKey = this.deps.recallCacheKey(
      input.auth,
      normalizedQuery,
      boundedLimit,
      input.types
    );

    // 1. LRU in-process cache
    const localCacheStartedAt = elapsedMs();
    const cached = this.deps.getCachedRecall(cacheKey);
    const processLocalMs = elapsedMs() - localCacheStartedAt;
    if (cached) {
      this.deps.logRecallEvent(
        input.query, boundedLimit, input.auth, input.requesterIp,
        cached, "exact_cache", {
          recall_local_ms: processLocalMs,
          recall_stamp_ms: 0,
          recall_redis_ms: 0,
          recall_bucket_ms: 0,
          cache_lookup_ms: processLocalMs,
        }
      );
      return cached;
    }

    // 2. Redis exact cache (survives restarts, shared across instances)
    // Start semantic fallback speculatively after a small delay to overlap tail latency.
    const recallLookupTimings: Partial<RecallCacheLookupTimings> = {};
    let bucketStartedAt = 0;
    let bucketPromise: Promise<BucketRecallResult> | null = null;
    const startBucket = (): Promise<BucketRecallResult> => {
      if (bucketPromise) return bucketPromise;
      bucketStartedAt = elapsedMs();
      bucketPromise = this.deps.withTimeout(
        this.deps.bucketRecall(normalizedQuery, input.auth),
        this.deps.totalTimeoutMs,
        "recall.bucket"
      );
      return bucketPromise;
    };
    const speculativeTimer = setTimeout(() => {
      void startBucket().catch(() => {});
    }, RecallMemoryUseCase.SPECULATIVE_BUCKET_DELAY_MS);
    speculativeTimer.unref?.();

    const redisCacheStartedAt = elapsedMs();
    const redisHit = await this.deps.readExactRecallPayload<RecallResult>(
      input.auth, normalizedQuery, "v1", recallLookupTimings
    );
    const cacheLookupMs = elapsedMs() - redisCacheStartedAt;
    const recallLocalMs = processLocalMs + (recallLookupTimings.recall_local_ms ?? 0);
    const recallStampMs = recallLookupTimings.recall_stamp_ms ?? 0;
    const recallRedisMs = recallLookupTimings.recall_redis_ms ?? 0;
    if (redisHit) {
      clearTimeout(speculativeTimer);
      this.deps.setCachedRecall(cacheKey, redisHit);
      this.deps.logRecallEvent(
        input.query, boundedLimit, input.auth, input.requesterIp,
        redisHit, "exact_cache", {
          recall_local_ms: recallLocalMs,
          recall_stamp_ms: recallStampMs,
          recall_redis_ms: recallRedisMs,
          recall_bucket_ms: 0,
          cache_lookup_ms: processLocalMs + cacheLookupMs,
        }
      );
      this.deps.runRecallShadowChecks(input.query, input.auth, boundedLimit, redisHit);
      return redisHit;
    }

    clearTimeout(speculativeTimer);

    // 3. Bucket recall — overlap with cache lookup when cache path is slow.
    let result: RecallResult;
    let source: RecallSource = "semantic_enriched";
    let timingsMs: Record<string, number> = {};

    try {
      const bucketResult = await startBucket();
      const bucketMs = Math.max(0, elapsedMs() - bucketStartedAt);
      const lookupWallMs = processLocalMs + (elapsedMs() - redisCacheStartedAt);
      result = {
        contextBlock: bucketResult.contextBlock,
        memories: bucketResult.memories,
        ...(bucketResult.conflictHints?.length ? { conflictHints: bucketResult.conflictHints } : {}),
      };
      timingsMs = {
        ...bucketResult.timingsMs,
        recall_local_ms: recallLocalMs,
        recall_stamp_ms: recallStampMs,
        recall_redis_ms: recallRedisMs,
        recall_bucket_ms: bucketMs,
        cache_lookup_ms: lookupWallMs,
      };
    } catch {
      // Total timeout — return empty rather than wrong memories
      const bucketMs = bucketStartedAt > 0
        ? Math.max(this.deps.totalTimeoutMs, elapsedMs() - bucketStartedAt)
        : this.deps.totalTimeoutMs;
      const lookupWallMs = processLocalMs + (elapsedMs() - redisCacheStartedAt);
      result = { contextBlock: "--- No relevant memories found ---", memories: [] };
      source = "recent_fallback";
      timingsMs = {
        recall_local_ms: recallLocalMs,
        recall_stamp_ms: recallStampMs,
        recall_redis_ms: recallRedisMs,
        recall_bucket_ms: bucketMs,
        cache_lookup_ms: lookupWallMs,
        total_ms: bucketMs,
      };
    }

    // Write to both caches — strip conflictHints so stale conflict data isn't served from cache
    const cacheableResult: RecallResult = { contextBlock: result.contextBlock, memories: result.memories };
    this.deps.setCachedRecall(cacheKey, cacheableResult);
    void this.deps.writeRecallPayload(input.auth, normalizedQuery, "v1", cacheableResult).catch(() => {});
    void this.deps.memoryRepository.logEvent({
      auth: input.auth,
      action: "recall",
      metadata: {
        query: normalizedQuery,
        limit: boundedLimit,
        hits: result.memories.length,
        source,
        ...timingsMs,
      },
    }).catch(() => {});

    this.deps.logRecallEvent(
      input.query, boundedLimit, input.auth, input.requesterIp,
      result, source, timingsMs
    );
    this.deps.runRecallShadowChecks(input.query, input.auth, boundedLimit, result);

    return result;
  }
}
