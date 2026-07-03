import assert from "node:assert/strict";
import test from "node:test";

test("loop engine schema uses only the append-only event log for build state and chat", async () => {
  const [schema, store] = await Promise.all([
    import("node:fs/promises").then((fs) => fs.readFile(
      new URL("../../../src/infrastructure/db/loop-engine-schema.ts", import.meta.url), "utf8",
    )),
    import("node:fs/promises").then((fs) => fs.readFile(
      new URL("../../../src/loops/store.ts", import.meta.url), "utf8",
    )),
  ]);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS loop_build_events/);
  assert.match(schema, /uq_loop_build_events_sequence/);
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS loop_specs/);
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS loop_chat_threads/);
  assert.doesNotMatch(store, /messages_json|FROM loop_specs|INTO loop_specs|loop_chat_threads/);
});
