import assert from "node:assert/strict";
import test from "node:test";

import {
  readComposioMetadata,
  resetComposioMetadataCacheForTests,
  type ComposioMetadataCachePolicy,
} from "../../../../src/integrations/composio/metadata-cache.js";

process.env.NODE_ENV ??= "test";

const policy: ComposioMetadataCachePolicy = {
  freshTtlMs: 50,
  staleTtlMs: 250,
  emptyTtlMs: 25,
};

test("readComposioMetadata reuses fresh values from the local cache", async () => {
  resetComposioMetadataCacheForTests();
  let now = 0;
  let loadCalls = 0;

  const read = () =>
    readComposioMetadata(
      "composio:test:fresh",
      async () => {
        loadCalls += 1;
        return ["gmail"];
      },
      policy,
      { now: () => now },
    );

  assert.deepEqual(await read(), ["gmail"]);
  now = 10;
  assert.deepEqual(await read(), ["gmail"]);
  assert.equal(loadCalls, 1);
  resetComposioMetadataCacheForTests();
});

test("readComposioMetadata returns stale values and refreshes in the background", async () => {
  resetComposioMetadataCacheForTests();
  let now = 0;
  let loadCalls = 0;

  const read = () =>
    readComposioMetadata(
      "composio:test:stale",
      async () => {
        loadCalls += 1;
        return loadCalls === 1 ? ["gmail"] : ["slack"];
      },
      policy,
      { now: () => now },
    );

  assert.deepEqual(await read(), ["gmail"]);
  now = 60;
  assert.deepEqual(await read(), ["gmail"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loadCalls, 2);
  now = 70;
  assert.deepEqual(await read(), ["slack"]);
  resetComposioMetadataCacheForTests();
});

test("readComposioMetadata caches empty results briefly", async () => {
  resetComposioMetadataCacheForTests();
  let now = 0;
  let loadCalls = 0;

  const read = () =>
    readComposioMetadata(
      "composio:test:empty",
      async () => {
        loadCalls += 1;
        return [];
      },
      policy,
      { now: () => now },
    );

  assert.deepEqual(await read(), []);
  now = 10;
  assert.deepEqual(await read(), []);
  now = 100;
  assert.deepEqual(await read(), []);
  assert.equal(loadCalls, 2);
  resetComposioMetadataCacheForTests();
});

test("readComposioMetadata keeps distinct keys isolated", async () => {
  resetComposioMetadataCacheForTests();
  let loadCalls = 0;

  const load = async () => {
    loadCalls += 1;
    return ["gmail"];
  };

  const first = await readComposioMetadata("composio:test:version-a", load, policy);
  const second = await readComposioMetadata("composio:test:version-b", load, policy);
  assert.deepEqual(first, ["gmail"]);
  assert.deepEqual(second, ["gmail"]);
  assert.equal(loadCalls, 2);
  resetComposioMetadataCacheForTests();
});
