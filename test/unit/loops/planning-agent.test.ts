import assert from "node:assert/strict";
import test from "node:test";

import { buildConductorSystemPrompt, buildRuntimePlannerPrompt, buildTestRunPlannerPrompt } from "../../../src/loops/planning-agent.js";
import { compactStepHistoryForPlanner } from "../../../src/loops/tool-result-compact.js";
import { seedSpecFromTemplate } from "../../../src/loops/patch.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";
import { computeOutcomeBriefHash } from "../../../src/loops/outcome-brief.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("buildConductorSystemPrompt includes workspace and compile blockers without ambient connector inventory", () => {
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  const prompt = buildConductorSystemPrompt({
    workspaceName: "Personal",
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    connectedToolkits: [{ slug: "gmail", name: "Gmail", connected: true }],
  });
  assert.match(prompt, /Workspace: Personal/);
  assert.match(prompt, /Compile blockers/);
  assert.doesNotMatch(prompt, /Connected \(\*=connected\)/);
  assert.doesNotMatch(prompt, /gmail\*/i);
});

test("intent prompt does not expose connector inventory", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const prompt = buildConductorSystemPrompt({
    workspaceName: "Personal",
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    buildPhase: "intent",
    connectedToolkits: [
      { slug: "gmail", name: "Gmail", connected: true },
      { slug: "outlook", name: "Outlook", connected: false },
      { slug: "zendesk", name: "Zendesk", connected: false },
    ],
  });
  assert.doesNotMatch(prompt, /Connected \(\*=connected\)/);
  assert.doesNotMatch(prompt, /\b(?:Outlook|Zendesk)\b/);
  // Static glossary/examples may mention common app names; connected-toolkit inventory must not leak.
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
  assert.match(prompt, /exactly two buttons/i);
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
  assert.match(prompt, /<role>/);
  assert.match(prompt, /<capabilities>/);
  assert.match(prompt, /<workflow>/);
  assert.match(prompt, /<guidelines>/);
  assert.match(prompt, /<hard_stops>/);
  assert.match(prompt, /<safety>/);
  assert.match(prompt, /<specialist_review>/);
  assert.match(prompt, /<activation_complete>/);
  assert.match(prompt, /<examples>/);
  assert.match(prompt, /<response_format>/);
  assert.match(prompt, /Available tools:/);
  assert.match(prompt, /pickConnectorApp/);
  assert.match(prompt, /analyzeIntent/);
  assert.match(prompt, /confirmOutcomeBrief/);
  assert.match(prompt, /presentAgentTeam/);
  assert.match(prompt, /presentReplyOptions/);
  assert.doesNotMatch(prompt, /reviewOutcomeBrief/);
  assert.match(prompt, /do not narrate a next action/i);
  assert.match(prompt, /immediately emitting the corresponding tool call/i);
  assert.match(prompt, /Phase recovery crosses a server handoff/);
});

test("buildConductorSystemPrompt includes glossary, read-before-write, and examples without Spec JSON leak", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const prompt = buildConductorSystemPrompt({
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    connectedToolkits: [],
  });

  const examplesBlock = prompt.match(/<examples>([\s\S]*?)<\/examples>/)?.[1] ?? "";
  assert.ok(examplesBlock.length > 0, "expected non-empty examples block");
  assert.match(prompt, /Trigger → what starts the automation/);
  assert.match(prompt, /Before activateLoop → a passing testRunLoop/);
  assert.match(examplesBlock, /analyzeIntent/);
  assert.match(examplesBlock, /presentAgentTeam/);
  assert.match(examplesBlock, /confirmOutcomeBrief/);
  assert.doesNotMatch(examplesBlock, /"workspaceId"/);
  assert.doesNotMatch(examplesBlock, /\{"intent"/);
  assert.match(prompt, /before → after/i);
});

test("buildConductorSystemPrompt steers confirmOutcomeBrief when roster is already prepared", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const prompt = buildConductorSystemPrompt({
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    connectedToolkits: [],
    buildPhase: "review",
    phaseProgress: {
      phase: "review",
      status: "in_progress",
      nextTool: "confirmOutcomeBrief",
      allowedTools: ["confirmOutcomeBrief"],
      instruction: "The specialist team roster is already shown. Call confirmOutcomeBrief now in this step. Do not summarize or repeat the roster.",
      handoffPending: true,
      terminal: false,
    },
  });
  assert.match(prompt, /Call confirmOutcomeBrief now/i);
  assert.match(prompt, /Do not summarize or repeat the roster/i);
});

test("buildConductorSystemPrompt uses phase progress instruction for connectors", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const prompt = buildConductorSystemPrompt({
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    connectedToolkits: [],
    buildPhase: "connectors",
    phaseProgress: {
      phase: "connectors",
      status: "in_progress",
      nextTool: "pickConnectorApp",
      allowedTools: ["pickConnectorApp"],
      instruction: "Call pickConnectorApp for each remaining unresolved app role. Do not summarize app choices in plain text.",
      handoffPending: true,
      terminal: false,
    },
  });
  assert.match(prompt, /pickConnectorApp/);
  assert.match(prompt, /Do not summarize app choices/i);
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

  assert.match(source, /prepareStep:\s*async \(\) => \{/);
  assert.match(source, /system: buildCurrentSystemPrompt\(\)/);
  assert.match(source, /toolChoice: modelGateway\.resolveToolChoice\(activeTools\.length\)/);
  assert.match(source, /confirmationHash:\s*currentBuildState!\.artifacts\.bindings\?\.artifactHash\s*\?\?\s*computeOutcomeBriefHash\(currentSpec!\)/);
  assert.match(source, /presentAgentTeam:\s*tool/);
  assert.match(source, /Review isn't complete yet\. Confirm the specialist team summary before compiling\./);
  assert.match(source, /recoverToPhase:\s*"review"/);
  assert.match(source, /deriveBuildPhaseProgress/);
  assert.match(source, /phaseProgress/);
  assert.match(source, /activeToolsForPhase/);
  assert.match(source, /requestPhaseContract/);
  assert.match(source, /requestPhaseContract\.allowedTools\.includes\(toolName\)/);
  assert.doesNotMatch(source, /lastToolExecution\?\.recoverToPhase/);
  assert.match(source, /recoverLoopBuildToCompile/);
  assert.doesNotMatch(source, /summarizeOutcomeBriefForUser|reviewOutcomeBrief:\s*tool/);
});

test("buildConductorSystemPrompt includes activation no-recap rules", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const prompt = buildConductorSystemPrompt({
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    buildPhase: "activation",
    connectedToolkits: [],
  });

  assert.match(prompt, /ActivationSummaryCard/);
  assert.match(prompt, /at most one short sentence/i);
  assert.match(prompt, /Never recap workflow steps/i);
  assert.match(prompt, /activation summary—reply with at most one short sentence/i);
  assert.match(prompt, /do not use bullets or tables—the UI renders the activation summary card/i);
});
