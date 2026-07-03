import assert from "node:assert/strict";
import test from "node:test";

import { buildConductorSystemPrompt, buildRuntimePlannerPrompt, buildTestRunPlannerPrompt } from "../../../src/loops/planning-agent.js";
import { compactStepHistoryForPlanner } from "../../../src/loops/tool-result-compact.js";
import { seedSpecFromTemplate } from "../../../src/loops/patch.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";
import { computeOutcomeBriefHash } from "../../../src/loops/outcome-brief.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("buildConductorSystemPrompt includes workspace and compile blockers", () => {
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  const prompt = buildConductorSystemPrompt({
    workspaceName: "Personal",
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
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
      status: "chosen",
      selectedConnector: "composio",
    }],
  };
  spec.bindings = [{ capability: "web.search", connector: "composio" }];
  spec.trigger = { kind: "schedule", cron: "0 7 * * 1-5", timezone: "UTC" };
  spec.output = { kind: "chat", target: "#general", connector: "slack" };
  spec.intentDiscovery = { status: "ready", decisions: [], assumptions: [], askedQuestionIds: [] };
  spec.intentDiscovery = {
    ...spec.intentDiscovery,
    status: "confirmed",
    confirmedBriefHash: computeOutcomeBriefHash(spec),
  };
  const prompt = buildConductorSystemPrompt({
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    connectedToolkits: [],
  });
  assert.match(prompt, /Compile blockers: none/);
  assert.match(prompt, /Next:.*compileLoop/);
});

test("buildConductorSystemPrompt requests specialist roster confirmation without model summary fields", () => {
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  spec.taskBlueprint = {
    version: 1,
    summary: "Research digest",
    outcomes: [{
      id: "src",
      role: "source",
      description: "Research the requested topics",
      status: "chosen",
      selectedConnector: "composio",
    }],
  };
  spec.bindings = [{ capability: "web.search", connector: "composio" }];
  spec.output = { kind: "chat", target: "Research channel" };
  spec.intentDiscovery = { status: "ready", decisions: [], assumptions: [], askedQuestionIds: [] };
  const confirmationHash = computeOutcomeBriefHash(spec);

  const prompt = buildConductorSystemPrompt({
    spec,
    confirmationHash,
    connectedToolkits: [],
  });

  assert.match(prompt, /presentAgentTeam/);
  assert.match(prompt, /Do not generate or pass review summary fields to confirmOutcomeBrief/i);
  assert.doesNotMatch(prompt, /summary\.runsWhen|summary\.steps|summary\.approval|summary\.result/);
  assert.match(prompt, new RegExp(confirmationHash));
  assert.doesNotMatch(prompt, /reviewOutcomeBrief/);
  assert.match(prompt, /never display/i);
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
      modifiedInputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      behaviorInstructions: ["Use existing messages output when available."],
      plannerCard: {
        summary: "List Gmail",
        argGuides: {},
        antiPatterns: ["Never use id: in query"],
      },
      composioAction: {
        toolkit: "gmail",
        actionSlug: "GMAIL_FETCH_EMAILS",
        label: "Read email",
        inputInstructions: [{
          field: "query",
          required: true,
          sources: [{ type: "planner", description: "Construct from current run context." }],
        }],
        outputInstructions: [{ name: "messages", path: "data.messages" }],
        dependsOn: [],
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
  assert.match(prompt, /composioAction/);
  assert.match(prompt, /modifiedInputSchema/);
  assert.match(prompt, /Use existing messages output when available/);
  assert.match(prompt, /Planner args are suggestions only/);
  assert.match(prompt, /message_id: abc123/);
  assert.match(prompt, /same tool with the same resolved arguments/i);
});

test("buildRuntimePlannerPrompt excludes exhausted tools and uses provider-neutral completion rules", () => {
  const prompt = buildRuntimePlannerPrompt({
    planOutcome: "A record is updated",
    planGoal: "Update the selected record",
    toolCatalog: [
      {
        id: "tool_exhausted",
        capability: "records.lookup",
        connector: "example",
        actionSlug: "LOOKUP_RECORD",
        plannerCard: { summary: "Look up a record", argGuides: {} },
      },
      {
        id: "tool_available",
        capability: "records.update",
        connector: "example",
        actionSlug: "UPDATE_RECORD",
        plannerCard: { summary: "Update a record", argGuides: {} },
      },
    ],
    exhaustedToolIds: ["tool_exhausted"],
    stepHistory: [],
    connectorPlaybook: { compiledAt: new Date().toISOString(), useCase: "Update records" },
  });

  assert.doesNotMatch(prompt, /tool_exhausted/);
  assert.match(prompt, /tool_available/);
  assert.match(prompt, /finishOnSuccess/);
  assert.doesNotMatch(prompt, /Gmail|snippet|email read|send, post, reply/i);
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

test("buildConductorSystemPrompt includes the requested prompt sections", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const prompt = buildConductorSystemPrompt({
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    connectedToolkits: [],
  });
  assert.match(prompt, /— Core rules —/);
  assert.match(prompt, /— Blueprint & patch flow —/);
  assert.match(prompt, /— Hard stops —/);
  assert.match(prompt, /— Safety —/);
  assert.match(prompt, /Available tools:/);
  assert.match(prompt, /pickConnectorApp/);
  assert.match(prompt, /analyzeIntent/);
  assert.match(prompt, /confirmOutcomeBrief/);
  assert.match(prompt, /presentAgentTeam/);
  assert.match(prompt, /presentReplyOptions/);
  assert.doesNotMatch(prompt, /reviewOutcomeBrief/);
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
      status: "pending",
    }],
  };
  const prompt = buildConductorSystemPrompt({
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    connectedToolkits: [],
  });
  assert.match(prompt, /Spec JSON:/);
  assert.match(prompt, /AI newsletter/);
  assert.equal((prompt.match(/"taskBlueprint"/g) ?? []).length, 1);
});

test("Conductor refreshes confirmation state per step without a nested summary model", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../../../src/transport/http/routes/loops.ts", import.meta.url),
    "utf8",
  ));

  assert.match(source, /prepareStep:\s*\(\) => \(\{ system: buildCurrentSystemPrompt\(\) \}\)/);
  assert.match(source, /confirmationHash:\s*computeOutcomeBriefHash\(currentSpec!\)/);
  assert.match(source, /presentAgentTeam:\s*tool/);
  assert.doesNotMatch(source, /summarizeOutcomeBriefForUser|reviewOutcomeBrief:\s*tool/);
});
