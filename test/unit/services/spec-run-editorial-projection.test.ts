import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectionPath = new URL("../../../src/services/loop-runtime/spec-run-editorial-projection.ts", import.meta.url);

test("spec-run editorial projection loads persisted step attempts", async () => {
  const source = await readFile(projectionPath, "utf8");
  assert.match(source, /loop_engine_step_attempts/);
  assert.match(source, /loop_engine_interactions/);
  assert.match(source, /buildOperatorViewFromInteraction/);
  assert.doesNotMatch(source, /buildSpecAgentSteps/);
  assert.doesNotMatch(source, /inferActiveAgentIndex/);
  assert.doesNotMatch(source, /inferAgentToolRefs/);
});

test("spec-run editorial projection derives agentGraph children from runtime steps", async () => {
  const source = await readFile(projectionPath, "utf8");
  assert.match(source, /children: steps\.map/);
});

test("spec-run editorial projection preserves persona on agent snapshots", async () => {
  const source = await readFile(projectionPath, "utf8");
  assert.match(source, /snapshot\.persona/);
  assert.match(source, /displayName/);
  assert.match(source, /avatarSeed/);
});
