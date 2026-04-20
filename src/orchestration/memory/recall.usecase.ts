import type { AuthContext } from "../../domain/auth/index.js";
import type { MemoryType } from "./memory-types.js";
import {
  buildFallbackTimings,
  selectFallbackSource,
  type RecallSource,
  type SnapshotStatus,
} from "./fallback-policy.js";

export interface RecallResult {
  contextBlock: string;
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
}

interface RecallSnapshot {
  status?: string;
  lookupMs?: number;
  ageMs?: number;
}

interface SnapshotLookup {
  status: SnapshotStatus;
  result: RecallResult | null;
  snapshot_lookup_ms: number;
  snapshot_age_ms: number;
}

interface FallbackResult {
  contextBlock: string;
  memories: RecallResult["memories"];
  elapsedMs: number;
  relevanceMiss: boolean;
}

interface RecallMemoryUseCaseDeps {
  readonly normalizeRecallQuery: (query: string) => string;
  readonly recallCacheKey: (auth: AuthContext, query: string, limit: number, types?: MemoryType[]) => string;
  readonly recallEnrichmentKey: (auth: AuthContext, query: string, limit: number, types?: MemoryType[]) => string;
  readonly getCachedRecall: (cacheKey: string) => RecallResult | null;
  readonly setCachedRecall: (cacheKey: string, result: RecallResult) => void;
  readonly readExactRecallPayload: <T>(auth: AuthContext, query: string, slot: "v1" | "v2") => Promise<T | null>;
  readonly readWarmRecallPayload: <T>(auth: AuthContext, query: string, slot: "v1" | "v2") => Promise<T | null>;
  readonly writeRecallPayload: <T>(auth: AuthContext, query: string, slot: "v1" | "v2", payload: T) => Promise<void>;
  readonly runBackgroundRecallEnrichment: (key: string, task: () => Promise<void>) => void;
  readonly withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
  readonly fastRecallTotalTimeoutMs: number;
  readonly hybridRecall: (
    query: string,
    auth: AuthContext,
    limit: number,
    options?: { types?: MemoryType[] }
  ) => Promise<{ contextBlock: string; memories: RecallResult["memories"]; timingsMs: Record<string, number> }>;
  readonly memoryRepository: {
    logEvent(input: {
      auth: AuthContext;
      action: string;
      memoryId?: string;
      ipHash?: string | null;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  readonly lookupPrecomputedRecallV1: (auth: AuthContext, query: string, limit: number) => Promise<SnapshotLookup>;
  readonly buildRecentFallback: (
    auth: AuthContext,
    query: string,
    limit: number,
    types?: MemoryType[]
  ) => Promise<FallbackResult>;
  readonly queueSnapshotRefresh: (auth: AuthContext, reason: string, delayMs: number) => Promise<void>;
  readonly logRecallEvent: (
    query: string,
    limit: number,
    auth: AuthContext,
    requesterIp: string | undefined,
    result: RecallResult,
    source: RecallSource,
    timingsMs?: Record<string, number>,
    snapshot?: RecallSnapshot
  ) => void;
  readonly runRecallShadowChecks: (query: string, auth: AuthContext, limit: number, result: RecallResult) => void;
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
    const lookupStartedAt = process.hrtime.bigint();
    const cacheLookupMs = () => Number(process.hrtime.bigint() - lookupStartedAt) / 1_000_000;

    const boundedLimit = Math.min(20, Math.max(1, input.limit ?? 5));
    const normalizedQuery = this.deps.normalizeRecallQuery(input.query);
    const normalizedTypes = input.types && input.types.length > 0
      ? [...new Set(input.types)].sort()
      : [];
    const cacheQuery = normalizedTypes.length > 0
      ? `${normalizedQuery} [types:${normalizedTypes.join(",")}]`
      : normalizedQuery;
    const cacheKey = this.deps.recallCacheKey(input.auth, cacheQuery, boundedLimit, normalizedTypes);
    const cached = this.deps.getCachedRecall(cacheKey);
    if (cached) {
      this.deps.logRecallEvent(input.query, boundedLimit, input.auth, input.requesterIp, cached, "exact_cache", {
        cache_lookup_ms: cacheLookupMs(),
      });
      return cached;
    }

    const exactHit = await this.deps.readExactRecallPayload<RecallResult>(input.auth, cacheQuery, "v1");
    if (exactHit) {
      this.deps.setCachedRecall(cacheKey, exactHit);
      this.deps.logRecallEvent(input.query, boundedLimit, input.auth, input.requesterIp, exactHit, "exact_cache", {
        cache_lookup_ms: cacheLookupMs(),
      });
      this.deps.runRecallShadowChecks(input.query, input.auth, boundedLimit, exactHit);
      return exactHit;
    }

    const warmHit = await this.deps.readWarmRecallPayload<RecallResult>(input.auth, cacheQuery, "v1");
    if (warmHit) {
      this.deps.setCachedRecall(cacheKey, warmHit);
      this.deps.runBackgroundRecallEnrichment(
        this.deps.recallEnrichmentKey(input.auth, cacheQuery, boundedLimit, normalizedTypes),
        async () => {
          const hybridResult = await this.deps.withTimeout(
            this.deps.hybridRecall(normalizedQuery, input.auth, boundedLimit, { types: normalizedTypes }),
            this.deps.fastRecallTotalTimeoutMs,
            "recall.enrichTotal"
          );
          const enrichedResult: RecallResult = {
            contextBlock: hybridResult.contextBlock,
            memories: hybridResult.memories,
          };
          this.deps.setCachedRecall(cacheKey, enrichedResult);
          await this.deps.writeRecallPayload(input.auth, cacheQuery, "v1", enrichedResult);
          await this.deps.memoryRepository.logEvent({
            auth: input.auth,
            action: "recall_enrich",
            metadata: {
              query: normalizedQuery,
              limit: boundedLimit,
              source: "semantic_enriched",
              cache_hit: false,
              enrich_ms: hybridResult.timingsMs.total_ms ?? 0,
              embed_ms: hybridResult.timingsMs.embed_ms ?? 0,
              vector_ms: hybridResult.timingsMs.vector_ms ?? 0,
              graph_ms: 0,
            },
          });
        }
      );
      this.deps.logRecallEvent(input.query, boundedLimit, input.auth, input.requesterIp, warmHit, "warm_cache", {
        cache_lookup_ms: cacheLookupMs(),
      });
      this.deps.runRecallShadowChecks(input.query, input.auth, boundedLimit, warmHit);
      return warmHit;
    }

    const snapshotLookup = await this.deps.lookupPrecomputedRecallV1(input.auth, cacheQuery, boundedLimit);
    if (snapshotLookup.status === "hit" && snapshotLookup.result) {
      this.deps.setCachedRecall(cacheKey, snapshotLookup.result);
      void this.deps.writeRecallPayload(input.auth, cacheQuery, "v1", snapshotLookup.result).catch(() => {});
      this.deps.logRecallEvent(
        input.query,
        boundedLimit,
        input.auth,
        input.requesterIp,
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
      this.deps.runRecallShadowChecks(input.query, input.auth, boundedLimit, snapshotLookup.result);
      return snapshotLookup.result;
    }

    // Run semantic search synchronously so the first call returns the correct
    // memory. The old pattern (lexical fallback now + semantic in background)
    // meant the right answer only appeared on the second identical query.
    // If semantic search times out, fall back to recent memories.
    let result: RecallResult;
    let source: ReturnType<typeof selectFallbackSource>;
    let fallbackElapsedMs = 0;
    let relevanceMiss = false;

    try {
      const hybridResult = await this.deps.withTimeout(
        this.deps.hybridRecall(normalizedQuery, input.auth, boundedLimit, { types: normalizedTypes }),
        this.deps.fastRecallTotalTimeoutMs,
        "recall.hybridSync"
      );
      result = { contextBlock: hybridResult.contextBlock, memories: hybridResult.memories };
      source = "semantic_enriched" satisfies RecallSource;
      this.deps.setCachedRecall(cacheKey, result);
      void this.deps.writeRecallPayload(input.auth, cacheQuery, "v1", result).catch(() => {});
      void this.deps.memoryRepository.logEvent({
        auth: input.auth,
        action: "recall_hybrid_sync",
        metadata: {
          query: normalizedQuery,
          limit: boundedLimit,
          enrich_ms: hybridResult.timingsMs.total_ms ?? 0,
          vector_ms: hybridResult.timingsMs.vector_ms ?? 0,
        },
      }).catch(() => {});
    } catch {
      // Semantic search timed out — use recent memories as safety net.
      const fallback = await this.deps.buildRecentFallback(
        input.auth,
        normalizedQuery,
        boundedLimit,
        normalizedTypes
      );
      result = { contextBlock: fallback.contextBlock, memories: fallback.memories };
      source = selectFallbackSource(snapshotLookup.status);
      fallbackElapsedMs = fallback.elapsedMs;
      relevanceMiss = fallback.relevanceMiss;
      this.deps.setCachedRecall(cacheKey, result);
      if (relevanceMiss) {
        void this.deps.queueSnapshotRefresh(input.auth, "fallback_relevance_miss_v1", 750).catch(() => {});
      }
    }

    this.deps.logRecallEvent(
      input.query,
      boundedLimit,
      input.auth,
      input.requesterIp,
      result,
      source,
      buildFallbackTimings({
        cacheLookupMs: cacheLookupMs(),
        fallbackElapsedMs,
        relevanceMiss,
      }),
      {
        status: snapshotLookup.status,
        lookupMs: snapshotLookup.snapshot_lookup_ms,
        ageMs: snapshotLookup.snapshot_age_ms,
      }
    );
    this.deps.runRecallShadowChecks(input.query, input.auth, boundedLimit, result);

    return result;
  }
}
