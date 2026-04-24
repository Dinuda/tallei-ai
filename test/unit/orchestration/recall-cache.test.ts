import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import { RecallMemoryUseCase, type RecallResult } from "../../../src/orchestration/memory/recall.usecase.js";
import type { BucketRecallResult } from "../../../src/infrastructure/recall/bucket-recall.js";
import type { RecallCacheLookupTimings } from "../../../src/infrastructure/recall/fast-recall.js";
import type { MemoryType } from "../../../src/orchestration/memory/memory-types.js";

const auth: AuthContext = {
  userId: "user_1",
  tenantId: "tenant_1",
  authMode: "api_key",
  plan: "pro",
  keyId: "key_1",
  connectorType: "chatgpt",
};

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeTypes(types?: MemoryType[]): string {
  if (!types || types.length === 0) return "all";
  return [...new Set(types)].sort().join(",");
}

function makeResult(text: string): RecallResult {
  return {
    contextBlock: `--- Your Past Context ---\n${text}\n---`,
    memories: [{
      id: "mem_1",
      text,
      score: 0.91,
      metadata: { memory_type: "fact" },
    }],
  };
}

function makeHarness(options?: { redisPayload?: RecallResult }) {
  const localCache = new Map<string, RecallResult>();
  const redisCache = new Map<string, RecallResult>();
  const logs: Array<{ source: string; timingsMs?: Record<string, number> }> = [];
  let bucketCalls = 0;
  let readExactCalls = 0;
  let writeExactCalls = 0;

  if (options?.redisPayload) {
    redisCache.set("tenant_1:user_1:product catalogue:v1", options.redisPayload);
  }

  const useCase = new RecallMemoryUseCase({
    recallCacheKey: (inputAuth, query, limit, types) =>
      `${inputAuth.tenantId}:${inputAuth.userId}:${limit}:${normalizeQuery(query)}:${normalizeTypes(types)}`,
    getCachedRecall: (key) => localCache.get(key) ?? null,
    setCachedRecall: (key, result) => {
      localCache.set(key, result);
    },
    readExactRecallPayload: async <T>(
      inputAuth: AuthContext,
      query: string,
      slot: "v1" | "v2",
      timings?: Partial<RecallCacheLookupTimings>
    ): Promise<T | null> => {
      readExactCalls += 1;
      if (timings) {
        timings.recall_local_ms = (timings.recall_local_ms ?? 0) + 0.1;
        timings.recall_stamp_ms = (timings.recall_stamp_ms ?? 0) + 0.2;
        timings.recall_redis_ms = (timings.recall_redis_ms ?? 0) + 0.3;
      }
      return (redisCache.get(`${inputAuth.tenantId}:${inputAuth.userId}:${normalizeQuery(query)}:${slot}`) as T | undefined) ?? null;
    },
    writeRecallPayload: async <T>(
      inputAuth: AuthContext,
      query: string,
      slot: "v1" | "v2",
      payload: T
    ): Promise<void> => {
      writeExactCalls += 1;
      redisCache.set(
        `${inputAuth.tenantId}:${inputAuth.userId}:${normalizeQuery(query)}:${slot}`,
        payload as RecallResult
      );
    },
    withTimeout: async <T>(promise: Promise<T>): Promise<T> => promise,
    totalTimeoutMs: 1_000,
    bucketRecall: async (query): Promise<BucketRecallResult> => {
      bucketCalls += 1;
      const result = makeResult(`bucket result for ${query}`);
      return {
        ...result,
        timingsMs: { total_ms: 12, embed_ms: 1, vector_ms: 2 },
      };
    },
    logRecallEvent: (_query, _limit, _auth, _requesterIp, _result, source, timingsMs) => {
      logs.push({ source, timingsMs });
    },
    runRecallShadowChecks: () => {},
    memoryRepository: {
      logEvent: async () => {},
    },
  });

  return {
    useCase,
    localCache,
    redisCache,
    logs,
    get bucketCalls() {
      return bucketCalls;
    },
    get readExactCalls() {
      return readExactCalls;
    },
    get writeExactCalls() {
      return writeExactCalls;
    },
  };
}

test("recall uses process-local exact cache on repeated normalized query", async () => {
  const harness = makeHarness();

  const first = await harness.useCase.execute({
    auth,
    query: " Product   Catalogue ",
    limit: 5,
  });
  const second = await harness.useCase.execute({
    auth,
    query: "product catalogue",
    limit: 5,
  });

  assert.deepEqual(second, first);
  assert.equal(harness.bucketCalls, 1);
  assert.equal(harness.readExactCalls, 1);
  assert.equal(harness.writeExactCalls, 1);
  assert.equal(harness.logs[0]?.source, "semantic_enriched");
  assert.equal(harness.logs[1]?.source, "exact_cache");
  assert.equal(harness.logs[1]?.timingsMs?.recall_bucket_ms, 0);
});

test("recall uses Redis exact cache and warms process-local cache without bucket recall", async () => {
  const cached = makeResult("cached product catalogue context");
  const harness = makeHarness({ redisPayload: cached });

  const first = await harness.useCase.execute({
    auth,
    query: "Product Catalogue",
    limit: 5,
  });
  const second = await harness.useCase.execute({
    auth,
    query: "product catalogue",
    limit: 5,
  });

  assert.deepEqual(first, cached);
  assert.deepEqual(second, cached);
  assert.equal(harness.bucketCalls, 0);
  assert.equal(harness.readExactCalls, 1);
  assert.equal(harness.logs[0]?.source, "exact_cache");
  assert.equal(harness.logs[0]?.timingsMs?.recall_bucket_ms, 0);
  assert.equal(harness.logs[1]?.source, "exact_cache");
  assert.equal(harness.logs[1]?.timingsMs?.recall_bucket_ms, 0);
  assert.equal(harness.localCache.size, 1);
});
