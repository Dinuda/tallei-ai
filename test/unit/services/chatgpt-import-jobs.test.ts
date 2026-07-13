import assert from "node:assert/strict";
import test from "node:test";

process.env.TALLEI_HTTP__INTERNAL_API_SECRET ??= "test-internal-secret";
process.env.TALLEI_DB__URL ??= "postgresql://test:test@localhost:5432/test";
process.env.TALLEI_AUTH__JWT_SECRET ??= "test-jwt-secret";

const {
  computeChatGptImportRetryDelayMs,
  isRetryableChatGptImportError,
} = await import("../../../src/services/chatgpt-import/jobs.service.js");

test("computeChatGptImportRetryDelayMs uses capped exponential backoff", () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(computeChatGptImportRetryDelayMs(1, 500, 10_000), 500);
    assert.equal(computeChatGptImportRetryDelayMs(2, 500, 10_000), 1_000);
    assert.equal(computeChatGptImportRetryDelayMs(3, 500, 10_000), 2_000);
    assert.equal(computeChatGptImportRetryDelayMs(7, 500, 3_000), 3_000);
  } finally {
    Math.random = originalRandom;
  }
});

test("isRetryableChatGptImportError marks deterministic parse/validation failures as terminal", () => {
  assert.equal(isRetryableChatGptImportError("Validation failed: input is required"), false);
  assert.equal(isRetryableChatGptImportError("No importable JSON found in upload"), false);
  assert.equal(isRetryableChatGptImportError("Unsupported file type"), false);
  assert.equal(isRetryableChatGptImportError("ECONNREFUSED to upstream"), true);
  assert.equal(isRetryableChatGptImportError("fetch failed"), true);
});
