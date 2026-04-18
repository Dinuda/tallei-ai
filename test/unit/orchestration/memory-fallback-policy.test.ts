import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFallbackTimings,
  selectFallbackSource,
} from "../../../src/orchestration/memory/fallback-policy.js";

test("selectFallbackSource maps snapshot states to expected recall source", () => {
  assert.equal(selectFallbackSource("miss"), "precomputed_graph_miss");
  assert.equal(selectFallbackSource("stale"), "precomputed_graph_stale");
  assert.equal(selectFallbackSource("error"), "recent_fallback");
  assert.equal(selectFallbackSource("disabled"), "recent_fallback");
  assert.equal(selectFallbackSource("hit"), "recent_fallback");
});

test("buildFallbackTimings returns normalized recall timing metadata", () => {
  const result = buildFallbackTimings({
    cacheLookupMs: 12.5,
    fallbackElapsedMs: 78.2,
    relevanceMiss: true,
  });

  assert.deepEqual(result, {
    cache_lookup_ms: 12.5,
    fallback_ms: 78.2,
    total_ms: 78.2,
    relevance_miss: 1,
  });
});
