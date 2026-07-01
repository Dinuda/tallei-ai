import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteTtlCacheEntry,
  getTtlCacheEntry,
  setTtlCacheEntry,
  type TtlCacheStore,
} from "../../../src/infrastructure/cache/ttl-cache.js";

test("getTtlCacheEntry returns stored value before expiry", () => {
  const store: TtlCacheStore<string> = new Map();
  setTtlCacheEntry(store, "a", "hello", 60_000, 10);
  assert.equal(getTtlCacheEntry(store, "a"), "hello");
});

test("getTtlCacheEntry returns undefined after expiry", () => {
  const store: TtlCacheStore<string> = new Map();
  store.set("a", { value: "stale", exp: Date.now() - 1 });
  assert.equal(getTtlCacheEntry(store, "a"), undefined);
  assert.equal(store.has("a"), false);
});

test("setTtlCacheEntry evicts oldest entry when max size is reached", () => {
  const store: TtlCacheStore<number> = new Map();
  setTtlCacheEntry(store, "first", 1, 60_000, 2);
  setTtlCacheEntry(store, "second", 2, 60_000, 2);
  setTtlCacheEntry(store, "third", 3, 60_000, 2);
  assert.equal(store.size, 2);
  assert.equal(getTtlCacheEntry(store, "first"), undefined);
  assert.equal(getTtlCacheEntry(store, "second"), 2);
  assert.equal(getTtlCacheEntry(store, "third"), 3);
});

test("deleteTtlCacheEntry removes a key", () => {
  const store: TtlCacheStore<string> = new Map();
  setTtlCacheEntry(store, "a", "value", 60_000, 10);
  deleteTtlCacheEntry(store, "a");
  assert.equal(getTtlCacheEntry(store, "a"), undefined);
});
