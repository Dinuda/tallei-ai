import assert from "node:assert/strict";
import test from "node:test";

process.env.TALLEI_HTTP__INTERNAL_API_SECRET ??= "test-internal-secret";
process.env.TALLEI_DB__URL ??= "postgresql://test:test@localhost:5432/test";
process.env.TALLEI_AUTH__JWT_SECRET ??= "test-jwt-secret";

const {
  computeUploadIngestRetryDelayMs,
  isRetryableUploadIngestError,
} = await import("../../../src/services/uploaded-file-ingest-jobs.js");

test("computeUploadIngestRetryDelayMs uses capped exponential backoff", () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(computeUploadIngestRetryDelayMs(1, 500, 10_000), 500);
    assert.equal(computeUploadIngestRetryDelayMs(2, 500, 10_000), 1_000);
    assert.equal(computeUploadIngestRetryDelayMs(3, 500, 10_000), 2_000);
    assert.equal(computeUploadIngestRetryDelayMs(7, 500, 3_000), 3_000);
  } finally {
    Math.random = originalRandom;
  }
});

test("isRetryableUploadIngestError classifies terminal parse/type errors as non-retryable", () => {
  assert.equal(isRetryableUploadIngestError("Unsupported file type for document ingest"), false);
  assert.equal(isRetryableUploadIngestError("Legacy .doc files are not supported yet"), false);
  assert.equal(isRetryableUploadIngestError("Empty content after parsing"), false);
  assert.equal(isRetryableUploadIngestError("Missing download_link for uploaded file ingest job"), false);
  assert.equal(isRetryableUploadIngestError("HTTP 503 upstream timeout"), true);
  assert.equal(isRetryableUploadIngestError("fetch failed"), true);
});
