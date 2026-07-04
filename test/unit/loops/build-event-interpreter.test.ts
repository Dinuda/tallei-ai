import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import { eventsFromUiMessages } from "../../../src/loops/build-events.js";

import {
  bindingActionOutcomesForToolkit,
  deriveBindingArtifact,
  deriveBindingArtifactResult,
  connectorSelectionEvidence,
  interpretCompletedIntent,
  interpretBindingDiscovery,
  interpretConnectorSelections,
  interpretReviewConfirmation,
  deriveReviewProgress,
} from "../../../src/loops/build-event-interpreter.js";
import {
  commitBuildArtifact,
  createBuildState,
  loopBuildStateSchema,
  projectLoopSpec,
} from "../../../src/loops/build-state.js";
import { computeOutcomeBriefHash } from "../../../src/loops/outcome-brief.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function toolMessage(parts: Array<Record<string, unknown>>): UIMessage {
  return { id: crypto.randomUUID(), role: "assistant", parts } as UIMessage;
}

function intentState() {
  const committed = commitBuildArtifact({
    state: createBuildState(), phase: "intent", artifact: {
      workspaceId,
      intent: { goal: "Use Gmail to answer support email", outcome: "Answer support email", successCriteria: [] },
      startCondition: "A support email arrives", sourceHints: [{ channel: "email", userMentionedApp: "Gmail" }],
    },
  });
  return loopBuildStateSchema.parse({ ...committed.state, buildPhase: "intent" });
}

function connectorState() {
  const initial = intentState();
  const blueprint = commitBuildArtifact({
    state: { ...initial, buildPhase: "blueprint" }, phase: "blueprint",
    expectedParentHash: initial.artifacts.intent!.artifactHash,
    artifact: {
      taskBlueprint: { version: 1, summary: "Support", outcomes: [
        { id: "receive", role: "trigger", description: "Receive new support email", status: "pending" },
        { id: "read", role: "source", description: "Read support email", status: "pending" },
        { id: "classify", role: "transform", description: "Classify priority", status: "pending" },
        { id: "send", role: "destination", description: "Send reply", status: "pending" },
      ] },
      agent: { instructions: "Handle support", maxSteps: 12, maxTokens: 8000 }, approval: {}, guardrails: {},
    },
  });
  return blueprint.state;
}

function reviewBindingsState() {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const bindings = commitBuildArtifact({
    state: connectors.state, phase: "bindings", expectedParentHash: connectors.envelope.artifactHash,
    artifact: {
      trigger: { kind: "event", source: "gmail", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
      bindings: [{ capability: "GMAIL_SEND_EMAIL", connector: "gmail", actionSlug: "GMAIL_SEND_EMAIL", role: "destination" }],
      output: { kind: "none" },
    },
  });
  return bindings.state;
}

function presentAgentTeamOutput(bindingHash: string) {
  return {
    ok: true,
    parentArtifactHash: bindingHash,
    operationKey: `review:${bindingHash}:presentAgentTeam:review:${bindingHash}`,
    title: "Specialist team",
    specialists: [{
      id: "specialist-1",
      name: "Alex",
      roleTitle: "Support specialist",
      description: "Handles support email",
      avatarSeed: "seed-1",
      ownershipSummary: "Read and reply to support email",
      steps: [{ outcomeId: "read", role: "source", description: "Read support email", connector: "gmail" }],
    }],
  };
}

test("completed intent questions automatically produce intent and blueprint artifacts", () => {
  const state = intentState();
  const analysis = {
    outcome: "Prioritized support replies",
    trigger: "A Gmail support email arrives",
    executionOrder: [
      { role: "trigger", description: "Receive email" },
      { role: "transform", description: "Classify and draft" },
      { role: "destination", description: "Send approved reply" },
    ],
    questions: [{
      id: "approval", question: "Review replies before sending?", options: [
        { id: "yes", label: "Review first", value: "review" },
        { id: "no", label: "Send automatically", value: "auto" },
      ],
    }],
    decisions: [],
  } as const;
  const messages = [
    toolMessage([{ type: "tool-analyzeIntent", toolCallId: "analysis", state: "output-available", input: analysis, output: { ok: true, analysis } }]),
    toolMessage([{ type: "tool-askQuestion", toolCallId: "question", state: "output-available", input: {}, output: {
      questionId: "approval", answerText: "Review first", selectedOptionIds: ["yes"], selectedValues: ["review"],
    } }]),
  ];
  const interpreted = interpretCompletedIntent({
    state, spec: projectLoopSpec(state), messages, connectedToolkits: [{ slug: "gmail", name: "Gmail" }],
  });
  assert.ok(interpreted);
  assert.equal(interpreted.intent.sourceHints[0]?.userMentionedApp, "Gmail");
  assert.deepEqual(interpreted.blueprint.taskBlueprint.outcomes.map((row) => row.description), [
    "Receive email", "Classify and draft", "Send approved reply",
  ]);
});

test("Gmail picker answers are authoritative consent for every connector outcome", () => {
  const state = connectorState();
  const messages = ["receive", "read", "send"].map((outcomeId) => toolMessage([{
    type: "tool-pickConnectorApp", toolCallId: `pick-${outcomeId}`, state: "output-available",
    input: { outcomeId }, output: {
      questionId: `connector-app:${outcomeId}`, outcomeId, answerText: "Gmail",
      selectedOptionIds: ["gmail"], selectedValues: ["gmail"],
    },
  }]));
  const artifact = interpretConnectorSelections(state, messages);
  assert.ok(artifact);
  assert.deepEqual(artifact.selections.map((row) => row.connector), ["gmail", "gmail", "gmail"]);
  assert.ok(artifact.selections.every((row) => row.confirmedByUser));
});

test("one trigger picker also selects the linked initial source", () => {
  const state = connectorState();
  const messages = [
    toolMessage([{
      type: "tool-discoverConnectorsForBlueprint", toolCallId: "discover", state: "output-available",
      input: {}, output: {
        groups: [
          { outcomeId: "receive", linkedOutcomeIds: ["read"] },
          { outcomeId: "send", linkedOutcomeIds: [] },
        ],
        autoResolved: [],
      },
    }]),
    ...["receive", "send"].map((outcomeId) => toolMessage([{
      type: "tool-pickConnectorApp", toolCallId: `pick-${outcomeId}`, state: "output-available",
      input: { outcomeId }, output: { outcomeId, selectedValues: ["gmail"] },
    }])),
  ];

  const artifact = interpretConnectorSelections(state, messages);
  assert.deepEqual(artifact?.selections.map((row) => row.outcomeId), ["receive", "read", "send"]);
  assert.deepEqual(artifact?.selections.map((row) => row.connector), ["gmail", "gmail", "gmail"]);
});

test("connector interpretation rejects a value outside the discovered connector catalogue", () => {
  const state = connectorState();
  const messages = [
    toolMessage([{
      type: "tool-discoverConnectorsForBlueprint", toolCallId: "discover", state: "output-available",
      input: {}, output: {
        groups: [{
          outcomeId: "receive",
          linkedOutcomeIds: ["read"],
          askOptions: [{ id: "connector-outlook", label: "Outlook", value: "outlook" }],
        }],
        autoResolved: [],
      },
    }]),
    toolMessage([{
      type: "tool-pickConnectorApp", toolCallId: "pick-receive", state: "output-available",
      input: { outcomeId: "receive", role: "trigger" },
      output: { outcomeId: "receive", role: "trigger", selectedValues: ["made-up-helpdesk"] },
    }]),
  ];

  assert.equal(interpretConnectorSelections(state, messages), null);
  assert.deepEqual(connectorSelectionEvidence(messages), []);
});

test("connector interpretation waits until every required picker is answered", () => {
  const state = connectorState();
  const messages = [toolMessage([{
    type: "tool-pickConnectorApp", toolCallId: "pick-receive", state: "output-available",
    input: { outcomeId: "receive" }, output: {
      questionId: "connector-app:receive", outcomeId: "receive", answerText: "Gmail",
      selectedOptionIds: ["gmail"], selectedValues: ["gmail"],
    },
  }])];
  assert.equal(interpretConnectorSelections(state, messages), null);
});

test("connector interpretation folds completed tool events without rescanning UI messages", () => {
  const state = connectorState();
  const messages = ["receive", "read", "send"].map((outcomeId) => toolMessage([{
    type: "tool-pickConnectorApp", toolCallId: `event-${outcomeId}`, state: "output-available",
    input: { outcomeId }, output: { outcomeId, selectedValues: ["gmail"] },
  }]));
  const events = eventsFromUiMessages(messages).map((event, index) => ({
    id: String(index), loopId: "loop", threadKind: "build" as const, runId: null,
    sequence: index + 1, createdAt: new Date(0).toISOString(), toolCallId: event.toolCallId ?? null, ...event,
  }));
  const artifact = interpretConnectorSelections(state, events);
  assert.deepEqual(artifact?.selections.map((selection) => selection.outcomeId), ["receive", "read", "send"]);
});

test("complete discovery results automatically produce the binding artifact", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const artifact = deriveBindingArtifact(connectors.state, [{
    toolkit: "gmail",
    suggestedBindings: [
      { outcomeId: "read", connector: "gmail", capability: "GMAIL_FETCH_EMAILS", actionSlug: "GMAIL_FETCH_EMAILS", role: "source" },
      { outcomeId: "send", connector: "gmail", capability: "GMAIL_SEND_EMAIL", actionSlug: "GMAIL_SEND_EMAIL", role: "destination" },
    ],
  }], [{
    toolkit: "gmail",
    triggers: [{ slug: "GMAIL_NEW_GMAIL_MESSAGE", name: "New Gmail message" }],
  }]);
  assert.equal(artifact?.trigger.kind, "event");
  assert.deepEqual(artifact?.bindings.map((binding) => binding.actionSlug), ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"]);
});

test("atomic binding.resolved evidence is authoritative while legacy evidence stays supported", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const artifact = {
    trigger: { kind: "event" as const, source: "gmail", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE", config: { labelIds: ["INBOX"] } },
    bindings: [
      { connector: "gmail", capability: "GMAIL_FETCH_MESSAGE", actionSlug: "GMAIL_FETCH_MESSAGE", role: "source" as const },
      { connector: "gmail", capability: "GMAIL_REPLY_TO_THREAD", actionSlug: "GMAIL_REPLY_TO_THREAD", role: "destination" as const },
    ],
    composioActions: [],
    output: { kind: "none" as const },
  };
  const events = [{
    id: "resolved", loopId: "loop", threadKind: "build" as const, runId: null,
    sequence: 1, eventKey: "binding-resolved:hash", type: "binding.resolved" as const,
    payload: {
      artifact,
      blueprintHash: connectors.state.artifacts.blueprint!.artifactHash,
      connectorHash: connectors.state.artifacts.connectors!.artifactHash,
    },
    toolCallId: null, createdAt: new Date(0).toISOString(),
  }];

  assert.deepEqual(interpretBindingDiscovery(connectors.state, events), artifact);
});

test("binding discovery derives only connector-backed action outcomes from the blueprint", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });

  assert.deepEqual(
    bindingActionOutcomesForToolkit(projectLoopSpec(connectors.state), "GMAIL").map((outcome) => outcome.id),
    ["read", "send"],
  );
});

test("binding artifact waits for meaningful trigger config and preserves the answer", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const discoveries = [{ toolkit: "gmail", suggestedBindings: [
    { outcomeId: "read", connector: "gmail", capability: "GMAIL_FETCH_EMAILS", actionSlug: "GMAIL_FETCH_EMAILS", role: "source" },
    { outcomeId: "send", connector: "gmail", capability: "GMAIL_SEND_EMAIL", actionSlug: "GMAIL_SEND_EMAIL", role: "destination" },
  ] }];
  const triggers = [{ toolkit: "gmail", triggers: [{
    slug: "GMAIL_NEW_GMAIL_MESSAGE", name: "New Gmail message",
    config: { properties: { labelIds: { type: "array", description: "Only watch selected labels", items: { type: "string" } } } },
  }] }];
  assert.equal(deriveBindingArtifact(connectors.state, discoveries, triggers), null);
  const artifact = deriveBindingArtifact(connectors.state, discoveries, triggers, [{
    outcomeId: "receive", connector: "gmail", config: { labelIds: ["INBOX"] },
  }]);
  assert.equal(artifact?.trigger.kind, "event");
  if (artifact?.trigger.kind === "event") assert.deepEqual(artifact.trigger.config, { labelIds: ["INBOX"] });
});

test("missing destination binding returns a visible structured diagnostic", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "outlook", confirmedByUser: true },
      { outcomeId: "read", connector: "outlook", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const result = deriveBindingArtifactResult(connectors.state, [{
    toolkit: "outlook",
    suggestedBindings: [{ outcomeId: "read", connector: "outlook", capability: "OUTLOOK_GET_EMAIL", actionSlug: "OUTLOOK_GET_EMAIL" }],
  }], [{ toolkit: "outlook", triggers: [{ slug: "OUTLOOK_NEW_EMAIL", name: "New email" }] }]);
  assert.equal(result.artifact, null);
  const missing = result.diagnostics.find((row) => row.code === "MISSING_ACTION_BINDING");
  assert.equal(missing?.outcomeId, "send");
  assert.equal(missing?.connector, "gmail");
  assert.match(missing?.message ?? "", /No action is mapped/i);
});

test("wrong outcome and connector evidence is rejected visibly", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const result = deriveBindingArtifactResult(connectors.state, [{ toolkit: "outlook", suggestedBindings: [
    { outcomeId: "unknown", connector: "outlook", capability: "X", actionSlug: "X" },
    { outcomeId: "send", connector: "outlook", capability: "OUTLOOK_SEND", actionSlug: "OUTLOOK_SEND" },
  ] }], [{ toolkit: "gmail", triggers: [{ slug: "GMAIL_NEW_GMAIL_MESSAGE", name: "New Gmail message" }] }]);
  assert.equal(result.artifact, null);
  assert.ok(result.diagnostics.some((row) => row.code === "UNKNOWN_OUTCOME"));
  assert.ok(result.diagnostics.some((row) => row.code === "OUTCOME_CONNECTOR_MISMATCH"));
});

test("duplicate bindings are rejected instead of silently replacing one", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const result = deriveBindingArtifactResult(connectors.state, [{ toolkit: "gmail", suggestedBindings: [
    { outcomeId: "read", connector: "gmail", capability: "READ_A", actionSlug: "READ_A" },
    { outcomeId: "read", connector: "gmail", capability: "READ_B", actionSlug: "READ_B" },
    { outcomeId: "send", connector: "gmail", capability: "SEND", actionSlug: "SEND" },
  ] }], [{ toolkit: "gmail", triggers: [{ slug: "GMAIL_NEW_GMAIL_MESSAGE", name: "New Gmail message" }] }]);
  assert.equal(result.artifact, null);
  assert.ok(result.diagnostics.some((row) => row.code === "DUPLICATE_ACTION_BINDING"));
});

test("ambiguous triggers require an explicit provider trigger selection", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const discoveries = [{ toolkit: "gmail", suggestedBindings: [
    { outcomeId: "read", connector: "gmail", capability: "READ", actionSlug: "READ" },
    { outcomeId: "send", connector: "gmail", capability: "SEND", actionSlug: "SEND" },
  ] }];
  const triggers = [{ toolkit: "gmail", triggers: [
    { slug: "GMAIL_NEW_SUPPORT_EMAIL_V2", name: "New support email" },
    { slug: "GMAIL_NEW_SUPPORT_EMAIL", name: "New support email" },
  ] }];
  const ambiguous = deriveBindingArtifactResult(connectors.state, discoveries, triggers);
  assert.ok(ambiguous.diagnostics.some((row) => row.code === "AMBIGUOUS_TRIGGER" && row.options?.length === 2));
  const selected = deriveBindingArtifactResult(connectors.state, discoveries, triggers, [{
    outcomeId: "receive", connector: "gmail", triggerSlug: "GMAIL_NEW_SUPPORT_EMAIL", config: {},
  }]);
  assert.equal(selected.artifact?.trigger.kind, "event");
  if (selected.artifact?.trigger.kind === "event") assert.equal(selected.artifact.trigger.composioSlug, "GMAIL_NEW_SUPPORT_EMAIL");
});

test("review confirmation is interpreted once against the exact binding hash", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const bindings = commitBuildArtifact({
    state: connectors.state, phase: "bindings", expectedParentHash: connectors.envelope.artifactHash,
    artifact: {
      trigger: { kind: "event", source: "gmail", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
      bindings: [{ capability: "GMAIL_SEND_EMAIL", connector: "gmail", actionSlug: "GMAIL_SEND_EMAIL", role: "destination" }],
      output: { kind: "none" },
    },
  });
  const hash = bindings.envelope.artifactHash;
  const messages = [toolMessage([{
    type: "tool-confirmOutcomeBrief", toolCallId: "confirm", state: "output-available", input: { briefHash: hash },
    output: { action: "confirm", briefHash: hash },
  }])];
  const review = interpretReviewConfirmation(bindings.state, messages);
  assert.equal(review?.bindingHash, hash);
  assert.equal(review?.confirmedByUser, true);
});

test("review confirmation accepts computeOutcomeBriefHash when binding artifact hash differs", () => {
  const base = connectorState();
  const connectors = commitBuildArtifact({
    state: base, phase: "connectors", expectedParentHash: base.artifacts.blueprint!.artifactHash,
    artifact: { selections: [
      { outcomeId: "receive", connector: "gmail", confirmedByUser: true },
      { outcomeId: "read", connector: "gmail", confirmedByUser: true },
      { outcomeId: "send", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const bindings = commitBuildArtifact({
    state: connectors.state, phase: "bindings", expectedParentHash: connectors.envelope.artifactHash,
    artifact: {
      trigger: { kind: "event", source: "gmail", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
      bindings: [{ capability: "GMAIL_SEND_EMAIL", connector: "gmail", actionSlug: "GMAIL_SEND_EMAIL", role: "destination" }],
      output: { kind: "none" },
    },
  });
  const outcomeBriefHash = computeOutcomeBriefHash(projectLoopSpec(bindings.state));
  assert.notEqual(outcomeBriefHash, bindings.envelope.artifactHash);
  const messages = [toolMessage([{
    type: "tool-confirmOutcomeBrief", toolCallId: "confirm", state: "output-available",
    input: { briefHash: outcomeBriefHash },
    output: { action: "confirm", briefHash: outcomeBriefHash },
  }])];
  const review = interpretReviewConfirmation(bindings.state, messages);
  assert.equal(review?.bindingHash, bindings.envelope.artifactHash);
  assert.equal(review?.confirmedByUser, true);
});

test("deriveReviewProgress requires presentAgentTeam when roster is missing", () => {
  const state = reviewBindingsState();
  const hash = state.artifacts.bindings!.artifactHash;
  const progress = deriveReviewProgress(state, []);
  assert.equal(progress?.bindingHash, hash);
  assert.equal(progress?.rosterPrepared, false);
  assert.equal(progress?.confirmationComplete, false);
  assert.equal(progress?.nextTool, "presentAgentTeam");
});

test("deriveReviewProgress requires confirmOutcomeBrief after roster is prepared", () => {
  const state = reviewBindingsState();
  const hash = state.artifacts.bindings!.artifactHash;
  const messages = [toolMessage([{
    type: "tool-presentAgentTeam",
    toolCallId: "team",
    state: "output-available",
    input: { groups: [{ outcomeIds: ["read"] }] },
    output: presentAgentTeamOutput(hash),
  }])];
  const progress = deriveReviewProgress(state, messages);
  assert.equal(progress?.rosterPrepared, true);
  assert.equal(progress?.confirmationComplete, false);
  assert.equal(progress?.nextTool, "confirmOutcomeBrief");
});

test("deriveReviewProgress is complete after confirmOutcomeBrief", () => {
  const state = reviewBindingsState();
  const hash = state.artifacts.bindings!.artifactHash;
  const messages = [
    toolMessage([{
      type: "tool-presentAgentTeam",
      toolCallId: "team",
      state: "output-available",
      input: { groups: [{ outcomeIds: ["read"] }] },
      output: presentAgentTeamOutput(hash),
    }]),
    toolMessage([{
      type: "tool-confirmOutcomeBrief",
      toolCallId: "confirm",
      state: "output-available",
      input: { briefHash: hash },
      output: { action: "confirm", briefHash: hash },
    }]),
  ];
  const progress = deriveReviewProgress(state, messages);
  assert.equal(progress?.rosterPrepared, true);
  assert.equal(progress?.confirmationComplete, true);
  assert.equal(progress?.nextTool, null);
});

test("model-facing route and prompt contain no artifact commit tools", async () => {
  const [route, prompt] = await Promise.all([
    import("node:fs/promises").then((fs) => fs.readFile(new URL("../../../src/transport/http/routes/loops.ts", import.meta.url), "utf8")),
    import("node:fs/promises").then((fs) => fs.readFile(new URL("../../../src/loops/planning-agent.ts", import.meta.url), "utf8")),
  ]);
  for (const name of ["commitIntent", "commitBlueprint", "selectConnectors", "commitBindings", "confirmReview"]) {
    assert.doesNotMatch(route, new RegExp(`\\b${name}\\b`));
    assert.doesNotMatch(prompt, new RegExp(`\\b${name}\\b`));
  }
});
