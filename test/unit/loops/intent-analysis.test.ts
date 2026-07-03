import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = new URL("../../../src/transport/http/routes/loops.ts", import.meta.url);

test("analyzeIntent tool output no longer adds nextQuestion", async () => {
  const source = await readFile(routePath, "utf8");

  assert.match(source, /analyzeIntent: tool\(\{/);
  assert.match(source, /return \{ ok: true, analysis \};/);
  assert.doesNotMatch(source, /nextQuestion/);
});
