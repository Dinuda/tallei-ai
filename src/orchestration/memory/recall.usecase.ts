import type { AuthContext } from "../../domain/auth/index.js";
import type { MemoryType } from "./memory-types.js";
import type { RecallSource } from "./fallback-policy.js";
import type { BucketRecallResult } from "../../infrastructure/recall/bucket-recall.js";

export interface RecallResult {
  contextBlock: string;
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
}

interface RecallMemoryUseCaseDeps {
  readonly recallCacheKey: (auth: AuthContext, query: string, limit: number, types?: MemoryType[]) => string;
  readonly getCachedRecall: (key: string) => RecallResult | null;
  readonly setCachedRecall: (key: string, result: RecallResult) => void;
  readonly readExactRecallPayload: <T>(auth: AuthContext, query: string, slot: "v1" | "v2") => Promise<T | null>;
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
    const cacheLocalMs = elapsedMs() - localCacheStartedAt;
    if (cached) {
      this.deps.logRecallEvent(
        input.query, boundedLimit, input.auth, input.requesterIp,
        cached, "exact_cache", {
          cache_local_ms: cacheLocalMs,
          cache_redis_ms: 0,
          bucket_ms: 0,
          cache_lookup_ms: cacheLocalMs,
        }
      );
      return cached;
    }

    // 2. Redis exact cache (survives restarts, shared across instances)
    const redisCacheStartedAt = elapsedMs();
    const redisHit = await this.deps.readExactRecallPayload<RecallResult>(
      input.auth, normalizedQuery, "v1"
    );
    const cacheRedisMs = elapsedMs() - redisCacheStartedAt;
    if (redisHit) {
      this.deps.setCachedRecall(cacheKey, redisHit);
      this.deps.logRecallEvent(
        input.query, boundedLimit, input.auth, input.requesterIp,
        redisHit, "exact_cache", {
          cache_local_ms: cacheLocalMs,
          cache_redis_ms: cacheRedisMs,
          bucket_ms: 0,
          cache_lookup_ms: cacheLocalMs + cacheRedisMs,
        }
      );
      this.deps.runRecallShadowChecks(input.query, input.auth, boundedLimit, redisHit);
      return redisHit;
    }

    // 3. Bucket recall — synchronous, always returns semantically correct result
    let result: RecallResult;
    let source: RecallSource = "semantic_enriched";
    let timingsMs: Record<string, number> = {};

    try {
      const bucketStartedAt = elapsedMs();
      const bucketResult = await this.deps.withTimeout(
        this.deps.bucketRecall(normalizedQuery, input.auth),
        this.deps.totalTimeoutMs,
        "recall.bucket"
      );
      const bucketMs = elapsedMs() - bucketStartedAt;
      result = { contextBlock: bucketResult.contextBlock, memories: bucketResult.memories };
      timingsMs = {
        ...bucketResult.timingsMs,
        cache_local_ms: cacheLocalMs,
        cache_redis_ms: cacheRedisMs,
        bucket_ms: bucketMs,
        cache_lookup_ms: cacheLocalMs + cacheRedisMs + bucketMs,
      };
    } catch {
      // Total timeout — return empty rather than wrong memories
      result = { contextBlock: "--- No relevant memories found ---", memories: [] };
      source = "recent_fallback";
      timingsMs = {
        cache_local_ms: cacheLocalMs,
        cache_redis_ms: cacheRedisMs,
        bucket_ms: this.deps.totalTimeoutMs,
        cache_lookup_ms: cacheLocalMs + cacheRedisMs + this.deps.totalTimeoutMs,
        total_ms: this.deps.totalTimeoutMs,
      };
    }

    // Write to both caches
    this.deps.setCachedRecall(cacheKey, result);
    void this.deps.writeRecallPayload(input.auth, normalizedQuery, "v1", result).catch(() => {});
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
