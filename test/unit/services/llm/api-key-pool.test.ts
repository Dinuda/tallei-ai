import assert from "node:assert/strict";
import test from "node:test";

import {
  LlmApiKeyPool,
  parseRetryAfterMs,
  resetLlmApiKeyPoolsForTests,
} from "../../../../src/services/llm/api-key-pool.js";

test("LlmApiKeyPool assigns stable slot per user", () => {
  const pool = new LlmApiKeyPool(["k1", "k2", "k3"]);
  const a = pool.pickSlot("user-a");
  const b = pool.pickSlot("user-b");
  assert.equal(pool.pickSlot("user-a"), a);
  assert.ok(a >= 0 && a < 3);
  assert.ok(b >= 0 && b < 3);
});

test("LlmApiKeyPool fails over when preferred slot is rate limited", () => {
  const pool = new LlmApiKeyPool(["k1", "k2", "k3"]);
  const preferred = pool.pickSlot("user-a");
  pool.markRateLimited("opencode", preferred, 60_000);
  const next = pool.pickAvailableSlot("opencode", "user-a", new Set());
  assert.notEqual(next, preferred);
  assert.ok(next >= 0);
});

test("createPooledLlmFetch retries on 429 with next key", async () => {
  resetLlmApiKeyPoolsForTests();
  const pool = new LlmApiKeyPool(["key-one", "key-two"]);
  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    seen.push(auth);
    if (auth.includes("key-one")) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const { createPooledLlmFetch } = await import("../../../../src/services/llm/api-key-pool.js");
    const response = await createPooledLlmFetch(pool, "opencode", "user-a")(
      "https://example.com/v1/chat/completions",
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    assert.ok(seen[0]?.includes("key-one"));
    assert.ok(seen[1]?.includes("key-two"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseRetryAfterMs handles seconds", () => {
  assert.equal(parseRetryAfterMs("30"), 30_000);
});

test.after(resetLlmApiKeyPoolsForTests);
