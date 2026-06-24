import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowBuilderSession } from "../../../src/services/conductor/index.js";
import {
  allowedActionsForState,
  reduceBuilderState,
  stateFromSession,
} from "../../../src/services/conductor/builder/state-machine.js";

function session(overrides: Partial<WorkflowBuilderSession> = {}): WorkflowBuilderSession {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    builderState: "intent.collecting",
    title: "Test",
    goal: "Build a loop",
    composioSessionId: "cs_test",
    workflowRunId: null,
    specId: null,
    workflowId: null,
    resolvedIntent: null,
    discoveredToolContracts: [],
    buildContract: null,
    connectorSetup: null,
    artifactBundleJson: null,
    currentProposal: null,
    error: null,
    revision: 0,
    analyzerUsage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0, models: {} },
    builderTrace: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test("stateFromSession uses builderState as source of truth", () => {
  assert.equal(stateFromSession(session({ builderState: "intent.collecting" })), "intent.collecting");
  assert.equal(stateFromSession(session({ builderState: "requirements.resolving" })), "requirements.resolving");
  assert.equal(stateFromSession(session({ builderState: "compile.previewing" })), "compile.previewing");
  assert.equal(stateFromSession(session({ builderState: "verification.testing" })), "verification.testing");
  assert.equal(stateFromSession(session({ builderState: "failed" })), "failed");
  assert.equal(stateFromSession(session({ builderState: "intent.collecting", error: { message: "boom" } })), "failed");
});

test("allowedActionsForState exposes only state-local actions", () => {
  assert.deepEqual(allowedActionsForState("intent.resolving"), ["resolveIntent"]);
  assert.equal(allowedActionsForState("requirements.selecting_apps").includes("assistantMessage"), false);
  assert.equal(allowedActionsForState("requirements.selecting_apps").includes("saveLoop"), false);
  assert.equal(allowedActionsForState("intent.collecting").includes("intentClarification"), true);
  assert.equal(allowedActionsForState("intent.collecting").includes("interactivePrompt" as never), false);
  assert.equal(allowedActionsForState("compile.awaiting_approval").includes("saveLoop"), true);
  assert.equal(allowedActionsForState("compile.awaiting_approval").includes("saveApproval"), true);
  assert.equal(allowedActionsForState("verification.awaiting_activation").includes("confirmActivation"), true);
});

test("client actions and assistant messages do not transition state", () => {
  const current = session({ builderState: "requirements.resolving" });
  assert.equal(
    reduceBuilderState("requirements.resolving", { kind: "client_action", name: "scheduleSetup" }, current),
    "requirements.resolving",
  );
  assert.equal(
    reduceBuilderState("requirements.resolving", { kind: "assistant_message", name: "assistantMessage" }, current),
    "requirements.resolving",
  );
});

test("server actions advance exactly one deterministic state", () => {
  assert.equal(
    reduceBuilderState("intent.collecting", { kind: "server_action", name: "resolveIntent" }, session()),
    "requirements.selecting_apps",
  );
  assert.equal(
    reduceBuilderState("requirements.selecting_apps", { kind: "server_action", name: "getAvailableTools" }, session()),
    "requirements.resolving",
  );
  assert.equal(
    reduceBuilderState("compile.awaiting_approval", { kind: "server_action", name: "saveLoop" }, session()),
    "verification.testing",
  );
  assert.equal(
    reduceBuilderState("verification.awaiting_activation", { kind: "server_action", name: "confirmActivation" }, session()),
    "complete",
  );
});
