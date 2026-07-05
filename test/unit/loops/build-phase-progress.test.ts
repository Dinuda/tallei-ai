import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import {
  deriveActivationProgress,
  deriveBindingProgress,
  deriveBlueprintProgress,
  deriveBuildPhaseProgress,
  deriveCompileProgress,
  deriveConnectorProgress,
  deriveIntentProgress,
  deriveReviewPhaseProgress,
  deriveTestProgress,
  isTestSatisfiedForCompile,
} from "../../../src/loops/build-phase-progress.js";
import { eventsFromUiMessages } from "../../../src/loops/build-events.js";
import {
  commitBuildArtifact,
  createBuildState,
  loopBuildStateSchema,
} from "../../../src/loops/build-state.js";

function toolMessage(parts: Array<Record<string, unknown>>): UIMessage {
  return { id: crypto.randomUUID(), role: "assistant", parts } as UIMessage;
}

function intentState() {
  const committed = commitBuildArtifact({
    state: createBuildState(), phase: "intent", artifact: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      intent: { goal: "Use Gmail to answer support email", outcome: "Answer support email", successCriteria: [] },
      startCondition: "A support email arrives", sourceHints: [{ channel: "email", userMentionedApp: "Gmail" }],
    },
  });
  return loopBuildStateSchema.parse({ ...committed.state, buildPhase: "intent" });
}

function connectorBlueprintState() {
  const initial = intentState();
  const blueprint = commitBuildArtifact({
    state: { ...initial, buildPhase: "blueprint" }, phase: "blueprint",
    expectedParentHash: initial.artifacts.intent!.artifactHash,
    artifact: {
      taskBlueprint: { version: 1, summary: "Support", outcomes: [
        { id: "receive", role: "trigger", description: "Receive new support email", status: "pending" },
        { id: "read", role: "source", description: "Read support email", status: "pending" },
        { id: "send", role: "destination", description: "Send reply", status: "pending" },
      ] },
      agent: { instructions: "Handle support", maxSteps: 12, maxTokens: 8000 }, approval: {}, guardrails: {},
    },
  });
  return loopBuildStateSchema.parse({ ...blueprint.state, buildPhase: "connectors" });
}

function reviewBindingsState() {
  const base = connectorBlueprintState();
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

test("deriveIntentProgress requires analyzeIntent before questions", () => {
  const state = intentState();
  const pending = deriveIntentProgress(state, []);
  assert.equal(pending.nextTool, "analyzeIntent");
});

test("deriveIntentProgress requires askQuestion after analyzeIntent", () => {
  const state = intentState();
  const messages = [toolMessage([{
    type: "tool-analyzeIntent",
    toolCallId: "analysis",
    state: "output-available",
    input: {
      outcome: "Support replies",
      trigger: "Email arrives",
      executionOrder: [],
      questions: [{
        id: "approval",
        question: "Review before sending?",
        options: [
          { id: "yes", label: "Yes", value: "yes" },
          { id: "no", label: "No", value: "no" },
        ],
      }],
      decisions: [],
    },
    output: { ok: true },
  }])];
  const progress = deriveIntentProgress(state, messages);
  assert.equal(progress.nextTool, "askQuestion");
});

test("deriveBlueprintProgress exposes no model tools", () => {
  const progress = deriveBlueprintProgress();
  assert.deepEqual(progress.allowedTools, []);
  assert.equal(progress.terminal, true);
});

test("deriveConnectorProgress requires discovery then pickConnectorApp", () => {
  const state = connectorBlueprintState();
  assert.equal(deriveConnectorProgress(state, []).nextTool, "discoverConnectorsForBlueprint");
  const discovered = deriveConnectorProgress(state, [toolMessage([{
    type: "tool-discoverConnectorsForBlueprint",
    toolCallId: "discover",
    state: "output-available",
    input: {},
    output: {
      ok: true,
      groups: [{
        outcomeId: "read",
        role: "source",
        askOptions: [{ id: "gmail", label: "Gmail", value: "gmail" }],
      }],
    },
  }])]);
  assert.equal(discovered.nextTool, "pickConnectorApp");
  assert.equal(discovered.handoffPending, true);
});

test("deriveReviewPhaseProgress follows roster then confirmation", () => {
  const state = reviewBindingsState();
  const hash = state.artifacts.bindings!.artifactHash;
  assert.equal(deriveReviewPhaseProgress(state, []).nextTool, "presentAgentTeam");
  const roster = deriveReviewPhaseProgress(state, [toolMessage([{
    type: "tool-presentAgentTeam",
    toolCallId: "team",
    state: "output-available",
    input: { groups: [{ outcomeIds: ["read"] }] },
    output: {
      ok: true,
      parentArtifactHash: hash,
      specialists: [{
        id: "s1", name: "Alex", roleTitle: "Reader", description: "Read", avatarSeed: "seed",
        ownershipSummary: "Read email", steps: [{ outcomeId: "read", role: "source", description: "Read" }],
      }],
    },
  }])]);
  assert.equal(roster.nextTool, "confirmOutcomeBrief");
  assert.equal(roster.handoffPending, true);
});

test("deriveReviewPhaseProgress works during compile recovery", () => {
  const state = loopBuildStateSchema.parse({ ...reviewBindingsState(), buildPhase: "compile" });
  const hash = state.artifacts.bindings!.artifactHash;
  const progress = deriveBuildPhaseProgress(state, [toolMessage([{
    type: "tool-presentAgentTeam",
    toolCallId: "team",
    state: "output-available",
    input: { groups: [{ outcomeIds: ["read"] }] },
    output: {
      ok: true,
      parentArtifactHash: hash,
      specialists: [{
        id: "s1", name: "Alex", roleTitle: "Reader", description: "Read", avatarSeed: "seed",
        ownershipSummary: "Read email", steps: [{ outcomeId: "read", role: "source", description: "Read" }],
      }],
    },
  }])], { effectivePhase: "review" });
  assert.equal(progress.nextTool, "confirmOutcomeBrief");
});

test("deriveCompileProgress requires compileLoop in compile phase", () => {
  const reviewCommitted = commitBuildArtifact({
    state: reviewBindingsState(), phase: "review",
    expectedParentHash: reviewBindingsState().artifacts.bindings!.artifactHash,
    artifact: {
      bindingHash: reviewBindingsState().artifacts.bindings!.artifactHash,
      confirmedByUser: true,
      confirmedAt: new Date().toISOString(),
    },
  });
  const compileState = loopBuildStateSchema.parse({ ...reviewCommitted.state, buildPhase: "compile" });
  const progress = deriveCompileProgress(compileState, []);
  assert.equal(progress.nextTool, "compileLoop");
});

test("deriveTestProgress completes when test artifact matches compile hash", () => {
  const bindings = reviewBindingsState();
  const review = commitBuildArtifact({
    state: bindings,
    phase: "review",
    expectedParentHash: bindings.artifacts.bindings!.artifactHash,
    artifact: {
      bindingHash: bindings.artifacts.bindings!.artifactHash,
      confirmedByUser: true,
      confirmedAt: new Date().toISOString(),
    },
  });
  const compile = commitBuildArtifact({
    state: review.state,
    phase: "compile",
    expectedParentHash: review.envelope.artifactHash,
    artifact: {
      reviewHash: review.envelope.artifactHash,
      compiledPlanId: "22222222-2222-4222-8222-222222222222",
      compiledPlanHash: "compiled-hash",
    },
  });
  const tested = commitBuildArtifact({
    state: compile.state,
    phase: "test",
    expectedParentHash: compile.envelope.artifactHash,
    artifact: {
      compileHash: compile.envelope.artifactHash,
      compiledPlanId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      passed: true,
    },
  });
  const state = loopBuildStateSchema.parse({ ...tested.state, buildPhase: "test" });
  const progress = deriveTestProgress(state, []);
  assert.equal(progress.status, "complete");
  assert.equal(isTestSatisfiedForCompile(state, []), true);
});

test("deriveTestProgress still allows testRunLoop after a failed attempt", () => {
  const bindings = reviewBindingsState();
  const review = commitBuildArtifact({
    state: bindings,
    phase: "review",
    expectedParentHash: bindings.artifacts.bindings!.artifactHash,
    artifact: {
      bindingHash: bindings.artifacts.bindings!.artifactHash,
      confirmedByUser: true,
      confirmedAt: new Date().toISOString(),
    },
  });
  const compile = commitBuildArtifact({
    state: review.state,
    phase: "compile",
    expectedParentHash: review.envelope.artifactHash,
    artifact: {
      reviewHash: review.envelope.artifactHash,
      compiledPlanId: "22222222-2222-4222-8222-222222222222",
      compiledPlanHash: "compiled-hash",
    },
  });
  const state = loopBuildStateSchema.parse({ ...compile.state, buildPhase: "test" });
  const compileHash = compile.envelope.artifactHash;
  const messages = [toolMessage([{
    type: "tool-testRunLoop",
    toolCallId: "test-1",
    state: "output-available",
    input: { scenario: { label: "Smoke" } },
    output: {
      ok: false,
      retryAllowed: true,
      parentArtifactHash: compileHash,
      error: "Step failed",
    },
  }])];
  const progress = deriveTestProgress(state, messages);
  assert.equal(progress.nextTool, "testRunLoop");
  assert.equal(isTestSatisfiedForCompile(state, messages), false);
});

test("deriveActivationProgress requires presentReplyOptions before activateLoop", () => {
  const bindings = reviewBindingsState();
  const review = commitBuildArtifact({
    state: bindings,
    phase: "review",
    expectedParentHash: bindings.artifacts.bindings!.artifactHash,
    artifact: {
      bindingHash: bindings.artifacts.bindings!.artifactHash,
      confirmedByUser: true,
      confirmedAt: new Date().toISOString(),
    },
  });
  const compile = commitBuildArtifact({
    state: review.state,
    phase: "compile",
    expectedParentHash: review.envelope.artifactHash,
    artifact: {
      reviewHash: review.envelope.artifactHash,
      compiledPlanId: "22222222-2222-4222-8222-222222222222",
      compiledPlanHash: "compiled-hash",
    },
  });
  const tested = commitBuildArtifact({
    state: compile.state,
    phase: "test",
    expectedParentHash: compile.envelope.artifactHash,
    artifact: {
      compileHash: compile.envelope.artifactHash,
      compiledPlanId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      passed: true,
    },
  });
  const state = loopBuildStateSchema.parse({ ...tested.state, buildPhase: "activation" });
  assert.equal(deriveActivationProgress(state, []).nextTool, "presentReplyOptions");
});

function activationReadyState() {
  const bindings = reviewBindingsState();
  const review = commitBuildArtifact({
    state: bindings,
    phase: "review",
    expectedParentHash: bindings.artifacts.bindings!.artifactHash,
    artifact: {
      bindingHash: bindings.artifacts.bindings!.artifactHash,
      confirmedByUser: true,
      confirmedAt: new Date().toISOString(),
    },
  });
  const compile = commitBuildArtifact({
    state: review.state,
    phase: "compile",
    expectedParentHash: review.envelope.artifactHash,
    artifact: {
      reviewHash: review.envelope.artifactHash,
      compiledPlanId: "22222222-2222-4222-8222-222222222222",
      compiledPlanHash: "compiled-hash",
    },
  });
  const tested = commitBuildArtifact({
    state: compile.state,
    phase: "test",
    expectedParentHash: compile.envelope.artifactHash,
    artifact: {
      compileHash: compile.envelope.artifactHash,
      compiledPlanId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      passed: true,
    },
  });
  return loopBuildStateSchema.parse({ ...tested.state, buildPhase: "activation" });
}

test("deriveActivationProgress advances to activateLoop after Activate Automation reply", () => {
  const state = activationReadyState();
  const messages = [toolMessage([{
    type: "tool-presentReplyOptions",
    toolCallId: "activate-prompt",
    state: "output-available",
    input: {
      options: [
        { id: "activate", label: "Activate Automation", message: "Activate Automation" },
        { id: "hold", label: "Hold", message: "Hold for now" },
      ],
    },
    output: {
      selectedOptionId: "activate",
      message: "Activate Automation",
    },
  }])];
  const progress = deriveActivationProgress(state, messages);
  assert.equal(progress.nextTool, "activateLoop");
  assert.deepEqual(progress.allowedTools, ["activateLoop"]);
});

test("deriveActivationProgress accepts legacy selectedValues activation replies", () => {
  const state = activationReadyState();
  const messages = [toolMessage([{
    type: "tool-presentReplyOptions",
    toolCallId: "activate-prompt",
    state: "output-available",
    input: { options: [{ id: "yes", label: "Yes", message: "Yes" }] },
    output: { selectedValues: ["confirm"] },
  }])];
  assert.equal(deriveActivationProgress(state, messages).nextTool, "activateLoop");
});

test("deriveActivationProgress keeps presentReplyOptions after decline reply", () => {
  const state = activationReadyState();
  const messages = [toolMessage([{
    type: "tool-presentReplyOptions",
    toolCallId: "activate-prompt",
    state: "output-available",
    input: {
      options: [
        { id: "activate", label: "Activate", message: "Activate" },
        { id: "hold", label: "Hold", message: "Hold for now" },
      ],
    },
    output: {
      selectedOptionId: "hold",
      message: "Hold for now",
    },
  }])];
  const progress = deriveActivationProgress(state, messages);
  assert.equal(progress.nextTool, "presentReplyOptions");
  assert.equal(progress.reason, "activation_confirm_declined");
});

test("deriveActivationProgress is terminal complete when loop status is active", () => {
  const state = activationReadyState();
  const progress = deriveActivationProgress(state, [], { loopStatus: "active" });
  assert.equal(progress.status, "complete");
  assert.equal(progress.terminal, true);
  assert.equal(progress.reason, "activation_complete");
});

test("deriveActivationProgress is terminal complete after successful activateLoop", () => {
  const state = activationReadyState();
  const messages = [toolMessage([{
    type: "tool-activateLoop",
    toolCallId: "activate-1",
    state: "output-available",
    input: { confirmedByUser: true },
    output: {
      ok: true,
      status: "active",
      turnOutcome: "build_complete",
      alreadyActive: true,
    },
  }])];
  const progress = deriveActivationProgress(state, messages);
  assert.equal(progress.status, "complete");
  assert.equal(progress.terminal, true);
  assert.deepEqual(progress.allowedTools, []);
  assert.equal(progress.reason, "activation_complete");
});

test("deriveActivationProgress surfaces missing test prerequisite", () => {
  const state = loopBuildStateSchema.parse({ ...reviewBindingsState(), buildPhase: "activation" });
  assert.equal(deriveActivationProgress(state, []).nextTool, "testRunLoop");
  assert.equal(deriveActivationProgress(state, []).reason, "test_prerequisite_missing");
});

test("deriveBindingProgress surfaces askQuestion after resolveBindings pendingQuestions", () => {
  const state = loopBuildStateSchema.parse({ ...reviewBindingsState(), buildPhase: "bindings" });
  const progress = deriveBindingProgress(state, [toolMessage([{
    type: "tool-resolveBindings",
    toolCallId: "resolve",
    state: "output-available",
    input: {},
    output: {
      ok: true,
      pendingQuestions: [{
        questionId: "binding-action-read",
        question: "Which Gmail action should read support email?",
        options: [
          { id: "read", label: "Read", value: "GMAIL_READ" },
          { id: "fetch", label: "Fetch", value: "GMAIL_FETCH" },
        ],
        outcomeId: "read",
        role: "source",
      }],
    },
  }])]);
  assert.equal(progress.nextTool, "askQuestion");
  assert.equal(progress.handoffPending, true);
});

test("deriveBuildPhaseProgress attaches pendingUiTool from build events", () => {
  const state = reviewBindingsState();
  const events = eventsFromUiMessages([toolMessage([{
    type: "tool-confirmOutcomeBrief",
    toolCallId: "confirm-1",
    state: "input-available",
    input: {
      briefHash: "a".repeat(64),
      question: "Ready?",
      options: [
        { id: "confirm", label: "Yes", value: "confirm" },
        { id: "other", label: "No", value: "other" },
      ],
    },
  }])]).map((event, index) => ({
    id: String(index),
    loopId: "loop",
    threadKind: "build" as const,
    runId: null,
    sequence: index + 1,
    createdAt: new Date(0).toISOString(),
    toolCallId: event.toolCallId ?? null,
    ...event,
  }));
  const progress = deriveBuildPhaseProgress(state, events);
  assert.equal(progress.pendingUiTool?.toolCallId, "confirm-1");
  assert.equal(progress.pendingUiTool?.toolName, "confirmOutcomeBrief");
});
