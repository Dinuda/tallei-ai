import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import { SaveMemoryUseCase } from "../../../src/orchestration/memory/save.usecase.js";

const auth: AuthContext = {
  userId: "u_1",
  tenantId: "t_1",
  authMode: "internal",
  plan: "pro",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSaveUseCaseForTest(
  extractFactsCalls: { count: number },
  createdRows: Array<Record<string, unknown>>,
  options?: {
    shouldBypassVector?: () => boolean;
    searchVectors?: () => Promise<unknown[]>;
    noteVectorFailure?: (error: unknown, context: string) => void;
  }
) {
  return new SaveMemoryUseCase({
    consumeMonthlySaveQuota: async () => 0,
    memoryRepository: {
      create: async (_auth, input) => {
        createdRows.push(input as unknown as Record<string, unknown>);
      },
      findActiveByContentHash: async () => null,
      incrementReferenceScoped: async () => true,
      updateContentAndSummaryScoped: async () => ({}),
      softDeleteScoped: async () => ({}),
      markSupersededPreferences: async () => [],
      getByIds: async () => [],
      logEvent: async () => {},
    },
    vectorRepository: {
      upsertMemoryVector: async () => ({}),
      searchVectors: async () => options?.searchVectors?.() ?? [],
    },
    shouldBypassVector: options?.shouldBypassVector ?? (() => true),
    noteVectorFailure: options?.noteVectorFailure ?? (() => {}),
    noteMemoryDbFailure: () => {},
    setRequestTimingFields: () => {},
    invalidateRecallCache: () => {},
    invalidateBm25Cache: () => {},
    bumpRecallStamp: async () => {},
    ipHash: () => null,
    createQuotaExceededError: (message) => new Error(message),
    extractFacts: async () => {
      extractFactsCalls.count += 1;
      return [{
        text: "User likes Rust.",
        subject: "user",
        temporal_context: null,
        supersedes_pattern: null,
      }];
    },
    isEvalMode: true,
    freeSaveLimit: 50,
  });
}

test("save memory skips extracted fact writes when runFactExtraction is false", async () => {
  const extractFactsCalls = { count: 0 };
  const createdRows: Array<Record<string, unknown>> = [];
  const saveUseCase = createSaveUseCaseForTest(extractFactsCalls, createdRows);

  await saveUseCase.execute({
    content: "My favorite programming language is Rust.",
    auth,
    platform: "chatgpt",
    memoryType: "preference",
    runFactExtraction: false,
  });

  await sleep(40);

  assert.equal(extractFactsCalls.count, 0);
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows.some((row) => row["category"] === "fact_extract"), false);
});

test("save memory skips vector dedup when runVectorDedup is false", async () => {
  const extractFactsCalls = { count: 0 };
  const createdRows: Array<Record<string, unknown>> = [];
  let searchCalls = 0;
  let vectorFailureCalls = 0;
  const saveUseCase = createSaveUseCaseForTest(extractFactsCalls, createdRows, {
    shouldBypassVector: () => false,
    searchVectors: async () => {
      searchCalls += 1;
      throw new Error("vector search should not run");
    },
    noteVectorFailure: () => {
      vectorFailureCalls += 1;
    },
  });

  await saveUseCase.execute({
    content: "User has a 5-year-old son.",
    auth,
    platform: "chatgpt-prepare",
    memoryType: "fact",
    runFactExtraction: false,
    runVectorDedup: false,
  });

  assert.equal(searchCalls, 0);
  assert.equal(vectorFailureCalls, 0);
  assert.equal(createdRows.length, 1);
});

test("save memory writes extracted facts when runFactExtraction is enabled", async () => {
  const extractFactsCalls = { count: 0 };
  const createdRows: Array<Record<string, unknown>> = [];
  const saveUseCase = createSaveUseCaseForTest(extractFactsCalls, createdRows);

  await saveUseCase.execute({
    content: "My favorite programming language is Rust.",
    auth,
    platform: "chatgpt",
    memoryType: "preference",
  });

  await sleep(40);

  assert.equal(extractFactsCalls.count, 1);
  assert.equal(createdRows.some((row) => row["category"] === "fact_extract"), true);
});
