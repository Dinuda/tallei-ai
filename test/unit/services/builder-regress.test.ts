import assert from "node:assert/strict";
import test from "node:test";

import { buildRegressionPatch, invalidationPlan, revisedArtifactForPhase } from "../../../src/services/conductor/builder/artifacts.js";

test("revisedArtifactForPhase maps analyzer phases to artifact keys", () => {
  assert.equal(revisedArtifactForPhase("discovery"), "intent");
  assert.equal(revisedArtifactForPhase("requirements"), "buildContract");
  assert.equal(revisedArtifactForPhase("compile"), "spec");
  assert.equal(revisedArtifactForPhase("verification"), "verification");
});

test("discovery invalidation clears all artifacts", () => {
  const plan = invalidationPlan("discovery");
  assert.deepEqual(plan.preserved, []);
  assert.equal(plan.invalidated.length, 4);
});

test("compile regression patch keeps build contract fields unset", () => {
  const patch = buildRegressionPatch({
    id: "sess",
    phase: "saved",
    title: "t",
    goal: "g",
    composioSessionId: "trs",
    workflowRunId: null,
    specId: "spec",
    workflowId: "wf",
    resolvedIntent: null,
    discoveredToolContracts: [],
    buildContract: { version: "v1", requirements: [], issues: [], createdAt: "x", updatedAt: "x" },
    artifactBundleJson: null,
    currentProposal: null,
    error: null,
    revision: 0,
    analyzerUsage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0, models: {} },
    builderTrace: [],
    phaseHistory: [],
    pendingRevision: null,
    createdAt: "x",
    updatedAt: "x",
  }, "compile");
  assert.equal(patch.phase, "intent_resolved");
  assert.equal(patch.workflowId, null);
});
