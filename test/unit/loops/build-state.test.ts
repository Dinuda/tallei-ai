import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_ERROR_CODES,
  BuildStateError,
  assembleLoopSpec,
  commitBuildArtifact,
  createBuildState,
  hashArtifact,
  loopBuildStateSchema,
  recoverBuildState,
  userFacingStageForPhase,
} from "../../../src/loops/build-state.js";
import {
  determineBuildContinuityRecovery,
  isCompiledPlanCurrent,
} from "../../../src/loops/build-continuity.js";
import { intentQuestionSchema } from "../../../src/loops/intent-discovery.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function intentArtifact() {
  return {
    workspaceId,
    intent: { goal: "Handle support email", outcome: "Draft safe replies", successCriteria: ["Correct priority"] },
    startCondition: "A support email arrives",
    sourceHints: [{ channel: "email", userMentionedApp: "Gmail" }],
  };
}

function throughBindings() {
  const intent = commitBuildArtifact({ state: createBuildState(), phase: "intent", artifact: intentArtifact() });
  const blueprint = commitBuildArtifact({
    state: intent.state, phase: "blueprint", expectedParentHash: intent.envelope.artifactHash,
    artifact: {
      taskBlueprint: { version: 1, summary: "Support reply", outcomes: [
        { id: "incoming", role: "trigger", description: "Receive support email", status: "pending" },
        { id: "draft", role: "destination", description: "Create reply draft", status: "pending" },
      ] },
      profile: "agentic",
      agent: { instructions: "Draft a reply", maxSteps: 12, maxTokens: 8000 },
      approval: {}, guardrails: {},
    },
  });
  const connectors = commitBuildArtifact({
    state: blueprint.state, phase: "connectors", expectedParentHash: blueprint.envelope.artifactHash,
    artifact: { selections: [
      { outcomeId: "incoming", connector: "gmail", confirmedByUser: true },
      { outcomeId: "draft", connector: "gmail", confirmedByUser: true },
    ] },
  });
  const bindings = commitBuildArtifact({
    state: connectors.state, phase: "bindings", expectedParentHash: connectors.envelope.artifactHash,
    artifact: {
      trigger: { kind: "event", source: "gmail", composioSlug: "GMAIL_NEW_MESSAGE" },
      bindings: [{ capability: "email.draft", connector: "gmail", actionSlug: "GMAIL_CREATE_DRAFT", role: "destination" }],
      composioActions: [], output: { kind: "none" },
    },
  });
  return { intent, blueprint, connectors, bindings };
}

function throughCompile() {
  const base = throughBindings();
  const review = commitBuildArtifact({
    state: base.bindings.state,
    phase: "review",
    expectedParentHash: base.bindings.envelope.artifactHash,
    artifact: {
      bindingHash: base.bindings.envelope.artifactHash,
      confirmedByUser: true,
      confirmedAt: new Date().toISOString(),
    },
  });
  const compiledPlanId = "22222222-2222-4222-8222-222222222222";
  const compiledPlanHash = "compiled-content-hash";
  const compile = commitBuildArtifact({
    state: review.state,
    phase: "compile",
    expectedParentHash: review.envelope.artifactHash,
    artifact: {
      reviewHash: review.envelope.artifactHash,
      compiledPlanId,
      compiledPlanHash,
    },
  });
  return { ...base, review, compile, compiledPlanId, compiledPlanHash };
}

test("commits typed artifacts and exposes four user stages", () => {
  const result = throughBindings();
  assert.equal(result.bindings.state.buildPhase, "review");
  assert.equal(userFacingStageForPhase("bindings"), "connect_tools");
  assert.equal(userFacingStageForPhase("test"), "review_and_activate");
  const spec = assembleLoopSpec(result.bindings.state);
  assert.equal(spec.intent.goal, "Handle support email");
  assert.equal(spec.taskBlueprint?.outcomes[0]?.selectedConnector, "gmail");
});

test("canonical hashes ignore object key order", () => {
  assert.equal(hashArtifact({ b: 2, a: 1 }), hashArtifact({ a: 1, b: 2 }));
});

test("replayed semantic events do not create another artifact revision", () => {
  const first = commitBuildArtifact({ state: createBuildState(), phase: "intent", artifact: intentArtifact() });
  const replayed = commitBuildArtifact({ state: first.state, phase: "intent", artifact: intentArtifact() });
  assert.equal(replayed.envelope.id, first.envelope.id);
  assert.equal(replayed.envelope.revision, 1);
  assert.deepEqual(replayed.invalidatedPhases, []);
});

test("rejects stale parent hashes", () => {
  const intent = commitBuildArtifact({ state: createBuildState(), phase: "intent", artifact: intentArtifact() });
  assert.throws(() => commitBuildArtifact({
    state: intent.state, phase: "blueprint", expectedParentHash: "0".repeat(64),
    artifact: { taskBlueprint: { version: 1, summary: "x", outcomes: [] }, approval: {}, guardrails: {} },
  }), (error: unknown) => error instanceof BuildStateError && error.code === BUILD_ERROR_CODES.STALE_PARENT);
});

test("revising an upstream artifact invalidates downstream artifacts", () => {
  const result = throughBindings();
  const revised = commitBuildArtifact({
    state: result.bindings.state, phase: "intent",
    artifact: { ...intentArtifact(), intent: { ...intentArtifact().intent, outcome: "Escalate urgent mail" } },
  });
  assert.deepEqual(revised.invalidatedPhases, ["blueprint", "connectors", "bindings"]);
  assert.equal(revised.state.buildPhase, "blueprint");
  assert.equal(revised.state.artifacts.bindings, undefined);
});

test("compile artifact is the canonical current-plan identity", () => {
  const result = throughCompile();
  assert.equal(isCompiledPlanCurrent(result.compile.state, {
    id: result.compiledPlanId,
    contentHash: result.compiledPlanHash,
  }), true);
  assert.equal(isCompiledPlanCurrent(result.compile.state, {
    id: result.compiledPlanId,
    contentHash: "different-plan-content",
  }), false);
});

test("continuity supervisor rewinds a missing compiled plan once", () => {
  const result = throughCompile();
  const recovery = determineBuildContinuityRecovery(result.compile.state, null);
  assert.deepEqual(recovery, {
    phase: "compile",
    reason: "compiled_plan_missing",
    parentArtifactHash: result.review.envelope.artifactHash,
  });
  const rewound = recoverBuildState({
    state: result.compile.state,
    phase: recovery!.phase,
    reason: recovery!.reason,
  });
  assert.equal(rewound.state.buildPhase, "compile");
  assert.equal(rewound.state.artifacts.compile, undefined);
  assert.deepEqual(rewound.invalidatedPhases, ["compile"]);
  assert.equal(determineBuildContinuityRecovery(rewound.state, null), null);
});

test("rejects bindings to an unselected connector", () => {
  const result = throughBindings();
  assert.throws(() => commitBuildArtifact({
    state: result.connectors.state, phase: "bindings", expectedParentHash: result.connectors.envelope.artifactHash,
    artifact: {
      trigger: { kind: "manual" },
      bindings: [{ capability: "message.send", connector: "slack", role: "destination" }],
      output: { kind: "none" },
    },
  }), (error: unknown) => error instanceof BuildStateError && error.code === BUILD_ERROR_CODES.UNSELECTED_CONNECTOR);
});

test("intent questions accept any plain-language wording", () => {
  assert.equal(intentQuestionSchema.safeParse({
    id: "scope", question: "Handle email, WhatsApp, or both?", options: [
      { id: "email", label: "Email", value: "email" },
      { id: "both", label: "Both", value: "both" },
    ],
  }).success, true);
  assert.equal(intentQuestionSchema.safeParse({
    id: "provider", question: "Which connector should I integrate with?", options: [
      { id: "gmail", label: "Gmail", value: "gmail" },
      { id: "outlook", label: "Outlook", value: "outlook" },
    ],
  }).success, true);
});

test("hard cutover rejects the former flat LoopSpec shape", () => {
  assert.equal(loopBuildStateSchema.safeParse({
    workspaceId, intent: intentArtifact().intent, trigger: { kind: "manual" }, bindings: [],
  }).success, false);
});

test("review must reference the exact binding artifact", () => {
  const { bindings } = throughBindings();
  assert.throws(() => commitBuildArtifact({
    state: bindings.state, phase: "review", expectedParentHash: bindings.envelope.artifactHash,
    artifact: { bindingHash: "f".repeat(64), confirmedByUser: true, confirmedAt: new Date().toISOString() },
  }), (error: unknown) => error instanceof BuildStateError && error.code === BUILD_ERROR_CODES.STALE_PARENT);
});

test("database command handler locks the loop and commits event state transactionally", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../../../src/loops/store.ts", import.meta.url), "utf8",
  ));
  assert.match(source, /client\.query\("BEGIN"\)/);
  assert.match(source, /SELECT id FROM loops[^`]+FOR UPDATE/);
  assert.match(source, /getLatestArtifactEvent/);
  assert.match(source, /client\.query\("COMMIT"\)/);
  assert.match(source, /client\.query\("ROLLBACK"\)/);
});
