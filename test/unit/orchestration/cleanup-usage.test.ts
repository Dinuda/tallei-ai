import assert from "node:assert/strict";
import test from "node:test";

import { emptyCleanupAiUsage, recordCleanupAiUsage } from "../../../src/orchestration/memory-cleanup/usage.js";
import type { AppModelRequest, AppModelResponse } from "../../../src/model/types.js";

const request: Pick<AppModelRequest, "messages" | "model"> = {
  model: "gpt-5-nano",
  messages: [{ role: "user", content: "hello" }],
};

test("recordCleanupAiUsage prices versioned gpt-5-nano models", () => {
  const usage = emptyCleanupAiUsage();
  const response: AppModelResponse = {
    text: "world",
    model: "gpt-5-nano-2025-08-07",
    finishReason: "stop",
    provider: "openai",
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

test("recordCleanupAiUsage uses default pricing for unknown models like big-pickle", () => {
  const usage = emptyCleanupAiUsage();
  const response: AppModelResponse = {
    text: "world",
    model: "big-pickle",
    finishReason: "stop",
    provider: "opencode",
    usage: {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    },
  };

  recordCleanupAiUsage(usage, request, response);

  assert.equal(usage.calls, 1);
  assert.ok(Math.abs(usage.estimatedCostUsd - 0.6) < 1e-9);
});
