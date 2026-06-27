import assert from "node:assert/strict";
import test from "node:test";

import { buildConductorSystemPrompt, buildRuntimePlannerPrompt, buildTestRunPlannerPrompt } from "../../../src/loops/planning-agent.js";
import { compactStepHistoryForPlanner } from "../../../src/loops/tool-result-compact.js";
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
  assert.match(prompt, /gmail\*/);
});

test("buildConductorSystemPrompt reports ready when slots filled", () => {
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  spec.taskBlueprint = {
    version: 1,
    summary: "Research digest",
    outcomes: [{
      id: "src",
      role: "source",
      description: "Web research",
      candidates: [],
      status: "chosen",
      selectedConnector: "composio",
    }],
  };
  spec.bindings = [{ capability: "web.search", connector: "composio" }];
  spec.trigger = { kind: "schedule", cron: "0 7 * * 1-5", timezone: "UTC" };
  spec.output = { kind: "chat", target: "#general", connector: "slack" };
  const prompt = buildConductorSystemPrompt({
    spec,
    connectedToolkits: [],
  });
  assert.match(prompt, /Compile blockers: none/);
  assert.match(prompt, /Next:.*compileLoop/);
});

test("buildTestRunPlannerPrompt includes scenario and test prefix", () => {
  const prompt = buildTestRunPlannerPrompt({
    planOutcome: "Urgent tickets classified; drafts ready for review",
    planGoal: "Triage support email",
    agentInstructions: "Classify priority and draft replies only.",
    successCriteria: ["Accurate priority", "Safe drafts"],
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
      plannerCard: {
        summary: "List Gmail",
        argGuides: {},
      },
    }],
    stepHistory: [],
    connectorPlaybook: {
      compiledAt: new Date().toISOString(),
      useCase: "Support triage",
    },
  });
  assert.match(prompt, /TEST RUN/);
  assert.match(prompt, /Urgent login issue/);
});

test("buildRuntimePlannerPrompt includes connector playbook and trigger context", () => {
  const prompt = buildRuntimePlannerPrompt({
    planOutcome: "Customers receive timely support replies",
    planGoal: "Auto-reply to support tickets",
    toolCatalog: [{
      id: "tool_email_read",
      capability: "email.read",
      connector: "gmail",
      actionSlug: "GMAIL_FETCH_EMAILS",
      plannerCard: {
        summary: "List Gmail",
        argGuides: {},
        antiPatterns: ["Never use id: in query"],
      },
    }],
    stepHistory: [],
    connectorPlaybook: {
      compiledAt: new Date().toISOString(),
      useCase: "Support triage",
      pitfalls: ["Use message_id for get-by-id"],
    },
    triggerContext: "message_id: abc123",
  });
  assert.match(prompt, /Outcome: Customers receive timely support replies/);
  assert.match(prompt, /Connector playbook/);
  assert.match(prompt, /Never use id:/);
  assert.match(prompt, /message_id: abc123/);
  assert.match(prompt, /do not call email.read again/i);
});

test("compactStepHistoryForPlanner keeps latest 2 messages and shrinks payloads", () => {
  const hugeBody = "x".repeat(50_000);
  const compacted = compactStepHistoryForPlanner([{
    toolId: "tool_email_read",
    result: {
      data: {
        messages: [
          { messageId: "old", messageTimestamp: 1000, messageText: "old mail" },
          { messageId: "mid", messageTimestamp: 2000, messageText: "mid mail" },
          { messageId: "new1", messageTimestamp: 3000, messageText: hugeBody },
          { messageId: "new2", messageTimestamp: 4000, messageText: "newest" },
        ],
      },
    },
  }]);
  const serialized = JSON.stringify(compacted);
  assert.ok(serialized.length < 10_000, `expected compact history, got ${serialized.length} bytes`);
  const row = compacted[0] as { result: { data: { messages: Array<{ messageId: string; snippet: string }>; _runtimeNote: string } } };
  assert.equal(row.result.data.messages.length, 2);
  assert.equal(row.result.data.messages[0]?.messageId, "new2");
  assert.equal(row.result.data.messages[1]?.messageId, "new1");
  assert.match(row.result.data._runtimeNote, /latest 2 of 4/);
  assert.equal(row.result.data.messages[1]?.snippet?.length, 600);
});

test("buildConductorSystemPrompt includes first principles ownership and tool playbook", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const prompt = buildConductorSystemPrompt({ spec, connectedToolkits: [] });
  assert.match(prompt, /## First principles/);
  assert.match(prompt, /## Ownership/);
  assert.match(prompt, /## Tool playbook/);
  assert.match(prompt, /autoApplyConnector/);
  assert.match(prompt, /pickConnectorApp/);
  assert.match(prompt, /presentReplyOptions/);
});

test("buildConductorSystemPrompt includes full spec JSON once", () => {
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
  assert.match(prompt, /Spec JSON:/);
  assert.match(prompt, /AI newsletter/);
  assert.equal((prompt.match(/"taskBlueprint"/g) ?? []).length, 1);
});
