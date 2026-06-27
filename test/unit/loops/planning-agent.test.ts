import assert from "node:assert/strict";
import test from "node:test";

import { buildConductorSystemPrompt, buildTestRunPlannerPrompt } from "../../../src/loops/planning-agent.js";
import { seedSpecFromTemplate } from "../../../src/loops/patch.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("buildConductorSystemPrompt includes workspace and compile blockers", () => {
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  const prompt = buildConductorSystemPrompt({
    workspaceName: "Personal",
    spec,
    connectedToolkits: [{ slug: "gmail", name: "Gmail", connected: true }],
  });
  assert.match(prompt, /Workspace: Personal/);
  assert.match(prompt, /Compile blockers/);
  assert.match(prompt, /gmail\(connected\)/);
});

test("buildConductorSystemPrompt reports ready when slots filled", () => {
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  spec.bindings = [{ capability: "web.search", connector: "composio" }];
  spec.trigger = { kind: "schedule", cron: "0 7 * * 1-5", timezone: "UTC" };
  spec.output = { kind: "chat", target: "#general", connector: "slack" };
  const prompt = buildConductorSystemPrompt({
    spec,
    connectedToolkits: [],
  });
  assert.match(prompt, /No compile blockers/);
  assert.match(prompt, /compileLoop/);
  assert.match(prompt, /testRunLoop/);
  assert.match(prompt, /activateLoop/);
});

test("buildTestRunPlannerPrompt includes scenario and test prefix", () => {
  const prompt = buildTestRunPlannerPrompt({
    planGoal: "Triage support email",
    scenario: {
      label: "Urgent login issue",
      context: "Customer cannot sign in",
      triggerPayload: { subject: "Help", from: "user@example.com" },
    },
    toolCatalog: [{
      id: "tool_email_read",
      capability: "email.read",
      connector: "gmail",
      actionSlug: "GMAIL_FETCH_EMAILS",
      inputSchema: {},
    }],
    stepHistory: [],
  });
  assert.match(prompt, /TEST RUN/);
  assert.match(prompt, /Urgent login issue/);
  assert.match(prompt, /user@example.com/);
  assert.match(prompt, /Complete in one step/i);
});

test("buildConductorSystemPrompt emphasizes toolkit planning tools", () => {
  const spec = seedSpecFromTemplate(workspaceId, "lead_scoring");
  const prompt = buildConductorSystemPrompt({
    spec,
    connectedToolkits: [],
  });
  assert.match(prompt, /own loop configuration/i);
  assert.match(prompt, /decomposeTask/);
  assert.match(prompt, /discoverConnectorsForBlueprint/);
  assert.match(prompt, /pickConnectorApp/);
  assert.match(prompt, /MANDATORY before bindings/i);
  assert.match(prompt, /Never duplicate the same app/i);
  assert.match(prompt, /discoverBindings/);
  assert.match(prompt, /listConnectorCatalog/);
  assert.match(prompt, /Never ask.*default instructions vs custom/i);
  assert.match(prompt, /presentReplyOptions/);
  assert.match(prompt, /NEVER ask about Composio actions/i);
});

test("buildConductorSystemPrompt includes task blueprint when present", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  spec.taskBlueprint = {
    version: 1,
    summary: "AI newsletter",
    outcomes: [{
      id: "src",
      role: "source",
      description: "Content source",
      candidates: [],
      status: "pending",
    }],
  };
  const prompt = buildConductorSystemPrompt({ spec, connectedToolkits: [] });
  assert.match(prompt, /Current task blueprint/);
  assert.match(prompt, /AI newsletter/);
});

test("buildConductorSystemPrompt flags vague draft intent", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const prompt = buildConductorSystemPrompt({ spec, connectedToolkits: [] });
  assert.match(prompt, /Intent may still be vague/i);
});
