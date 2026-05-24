import assert from "node:assert/strict";
import test from "node:test";

import { emptyCleanupAiUsage, recordCleanupAiUsage } from "../../../src/orchestration/memory-cleanup/usage.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../../src/providers/ai/types.js";

const request: ChatCompletionRequest = {
  messages: [{ role: "user", content: "hello" }],
};

test("recordCleanupAiUsage prices versioned gpt-5-nano models", () => {
  const usage = emptyCleanupAiUsage();
  const response: ChatCompletionResponse = {
    text: "world",
    model: "gpt-5-nano-2025-08-07",
    finishReason: "stop",
    usage: {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    },
  };

  recordCleanupAiUsage(usage, request, response);

  assert.equal(usage.calls, 1);
  assert.equal(usage.estimatedCostUsd, 0.45);
});
