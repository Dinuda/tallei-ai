import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectionPath = new URL("../../../src/services/conductor/runtime/spec-run-editorial-projection.ts", import.meta.url);

test("spec-run editorial projection loads persisted step attempts", async () => {
  const source = await readFile(projectionPath, "utf8");
  assert.match(source, /loop_engine_step_attempts/);
  assert.match(source, /loop_engine_interactions/);
  assert.match(source, /buildOperatorViewFromInteraction/);
  assert.doesNotMatch(source, /buildSpecAgentSteps/);
  assert.doesNotMatch(source, /inferActiveAgentIndex/);
  assert.doesNotMatch(source, /inferAgentToolRefs/);
});

test("spec-run editorial projection exposes run definition agentGraph children", async () => {
  const source = await readFile(projectionPath, "utf8");
  assert.match(source, /specRun\.loopDefinition\.agentGraph\.children\.map/);
});

test("spec-run editorial projection preserves persona on agent snapshots", async () => {
  const source = await readFile(projectionPath, "utf8");
  assert.match(source, /snapshot\.persona/);
  assert.match(source, /displayName/);
  assert.match(source, /avatarSeed/);
});

test("spec-run editorial projection exposes slim spec roster and build contract", async () => {
  const source = await readFile(projectionPath, "utf8");
  assert.match(source, /spec: \{/);
  assert.match(source, /specId/);
  assert.match(source, /agents,/);
  assert.match(source, /buildContract/);
  assert.match(source, /definition: \{/);
  assert.match(source, /specRun\.loopDefinition/);
  assert.match(source, /builderSessionId: specRun\.builderSessionId/);
});

test("spec-run editorial projection exposes runner contract metadata", async () => {
  const source = await readFile(projectionPath, "utf8");
  assert.match(source, /inputContract: asRecord\(snapshot\.inputContract\)/);
  assert.match(source, /outputContract: asRecord\(snapshot\.outputContract\)/);
  assert.match(source, /handoffBindings: Array\.isArray\(snapshot\.handoffBindings\)/);
  assert.match(source, /renderer: typeof snapshot\.renderer === "string"/);
});
