import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const intentResolverPath = new URL("../../../src/services/loop-builder/intent-resolver.ts", import.meta.url);
const creatorPath = new URL("../../../src/services/loop-executor/creator.ts", import.meta.url);
const specRunnerPath = new URL("../../../src/services/loop-runtime/spec-runner.ts", import.meta.url);

test("builder saves executable loop definitions instead of new runnable specs", async () => {
  const source = await readFile(intentResolverPath, "utf8");
  assert.match(source, /createLoopFromDefinition/);
  assert.match(source, /definitionFromApprovedSpec/);
});

test("workflow creator persists loopDefinition metadata for new loops", async () => {
  const source = await readFile(creatorPath, "utf8");
  assert.match(source, /loopDefinition: parsed/);
});

test("spec runs snapshot and replay the executable loop definition", async () => {
  const source = await readFile(specRunnerPath, "utf8");
  assert.match(source, /JSON\.stringify\(spec\)/);
  assert.match(source, /parseLoopDefinitionSnapshot\(row\.definition_snapshot\)/);
  assert.match(source, /spec: projection\.loopDefinition/);
});
