import assert from "node:assert/strict";
import test from "node:test";

import { buildPlannerSystemPrompt } from "../../../src/loops/planning-agent.js";
import { seedSpecFromTemplate } from "../../../src/loops/patch.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("buildPlannerSystemPrompt includes workspace name and missing slots", () => {
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  const prompt = buildPlannerSystemPrompt({
    workspaceName: "Personal",
    spec,
    connectedToolkits: [{ slug: "gmail", name: "Gmail", connected: true }],
  });
  assert.match(prompt, /Workspace: Personal/);
  assert.match(prompt, /Missing slots:/);
  assert.match(prompt, /gmail\(connected\)/);
});

test("buildPlannerSystemPrompt reports ready when slots filled", () => {
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  spec.bindings = [{ capability: "web.search", connector: "composio" }];
  spec.trigger = { kind: "schedule", cron: "0 7 * * 1-5", timezone: "UTC" };
  spec.output = { kind: "chat", target: "#general", connector: "slack" };
  const prompt = buildPlannerSystemPrompt({
    spec,
    connectedToolkits: [],
  });
  assert.match(prompt, /All required slots are filled/);
});
