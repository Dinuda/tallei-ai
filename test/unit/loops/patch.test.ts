import assert from "node:assert/strict";
import test from "node:test";

import { applySpecPatch, getMissingSlots, isReadyToCompile, seedSpecFromTemplate } from "../../../src/loops/patch.js";

test("seedSpecFromTemplate research_digest fills intent", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  assert.equal(spec.profile, "agentic");
  assert.ok(spec.intent.goal.includes("digest"));
});

test("applySpecPatch updates bindings", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const base = seedSpecFromTemplate(workspaceId, "research_digest");
  const updated = applySpecPatch(base, {
    bindings: [{ capability: "email.read", connector: "outlook" }],
  });
  assert.equal(updated.bindings[0]?.connector, "outlook");
});

test("getMissingSlots detects empty bindings on draft template", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const spec = seedSpecFromTemplate(workspaceId, "");
  const missing = getMissingSlots(spec);
  assert.ok(missing.includes("bindings"));
});

test("isReadyToCompile false until required slots filled", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const spec = seedSpecFromTemplate(workspaceId, "");
  assert.equal(isReadyToCompile(spec), false);
  spec.bindings = [{ capability: "web.search", connector: "composio" }];
  spec.trigger = { kind: "schedule", cron: "0 7 * * 1-5", timezone: "UTC" };
  spec.output = { kind: "chat", target: "#general", connector: "slack" };
  assert.equal(isReadyToCompile(spec), true);
});
