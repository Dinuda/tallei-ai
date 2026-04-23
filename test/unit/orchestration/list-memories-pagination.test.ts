import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import { ListMemoriesUseCase } from "../../../src/orchestration/memory/list.usecase.js";

const auth: AuthContext = {
  userId: "u_1",
  tenantId: "t_1",
  authMode: "internal",
  plan: "pro",
};

test("list memories returns pagination metadata and total when requested", async () => {
  let countCalls = 0;
  let logMetadata: Record<string, unknown> | undefined;

  const useCase = new ListMemoriesUseCase({
    memoryRepository: {
      list: async () => [
        {
          id: "m_1",
          content_ciphertext: "enc:one",
          summary_json: { title: "One" },
          platform: "chatgpt",
          memory_type: "fact",
          category: "general",
          is_pinned: false,
          reference_count: 2,
          created_at: "2026-04-20T10:00:00.000Z",
        },
        {
          id: "m_2",
          content_ciphertext: "enc:two",
          summary_json: {},
          platform: "claude",
          memory_type: "preference",
          category: "profile",
          is_pinned: true,
          reference_count: 5,
          created_at: "2026-04-19T10:00:00.000Z",
        },
      ],
      count: async () => {
        countCalls += 1;
        return 5;
      },
      logEvent: async ({ metadata }) => {
        logMetadata = metadata;
      },
    },
    decryptMemoryContent: (ciphertext) => ciphertext.replace("enc:", "plain:"),
    noteMemoryDbFailure: () => {},
  });

  const result = await useCase.execute(auth, { limit: 2, offset: 2, includeTotal: true });

  assert.equal(result.memories.length, 2);
  assert.equal(result.memories[0]?.text, "plain:one");
  assert.equal(result.memories[1]?.metadata["memory_type"], "preference");
  assert.equal(result.limit, 2);
  assert.equal(result.offset, 2);
  assert.equal(result.total, 5);
  assert.equal(result.hasMore, true);
  assert.equal(countCalls, 1);
  assert.equal(logMetadata?.["limit"], 2);
  assert.equal(logMetadata?.["offset"], 2);
  assert.equal(logMetadata?.["total"], 5);
});

test("list memories skips count call when includeTotal is false", async () => {
  let countCalls = 0;

  const useCase = new ListMemoriesUseCase({
    memoryRepository: {
      list: async () => [],
      count: async () => {
        countCalls += 1;
        return 0;
      },
      logEvent: async () => {},
    },
    decryptMemoryContent: () => "plain",
    noteMemoryDbFailure: () => {},
  });

  const result = await useCase.execute(auth, { limit: 20, offset: 0, includeTotal: false });

  assert.equal(result.total, null);
  assert.equal(result.hasMore, false);
  assert.equal(countCalls, 0);
});
