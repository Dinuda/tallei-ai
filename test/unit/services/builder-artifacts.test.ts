import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRegressionPatch,
  invalidationPlan,
  requiresRegressionConfirmation,
} from "../../../src/services/conductor/builder/artifacts.js";
import type { WorkflowBuilderSession } from "../../../src/services/conductor/services/session.service.js";
import { emptyLoopBuilderUsage } from "../../../src/services/conductor/utils/progress.js";

function baseSession(overrides: Partial<WorkflowBuilderSession> = {}): WorkflowBuilderSession {
  return {
    id: "sess-1",
    phase: "intent_resolved",
    title: "Test",
    goal: "Test loop",
    composioSessionId: "trs_1",
    workflowRunId: null,
    specId: "spec-1",
    workflowId: "wf-1",
    resolvedIntent: {
      resolvedIntent: "Monitor inbox",
      resolvedAt: "2026-01-01T00:00:00.000Z",
      analysis: {
        normalizedIntent: {
          outcome: "Monitor inbox",
          toolCategories: ["communication"],
          cadence: "daily",
          approvalModel: "approve",
          runtimeInputs: [],
        },
        analyzedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    discoveredToolContracts: [{ toolRef: "composio.gmail.action.GMAIL_LIST_MESSAGES" } as never],
    buildContract: { version: "v1", requirements: [], issues: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    artifactBundleJson: null,
    currentProposal: { title: "Loop" } as never,
    error: null,
    revision: 1,
    analyzerUsage: emptyLoopBuilderUsage(),
    builderTrace: [],
    phaseHistory: [],
    pendingRevision: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("invalidationPlan for requirements preserves intent only", () => {
  const plan = invalidationPlan("requirements");
  assert.deepEqual(plan.preserved, ["intent"]);
  assert.deepEqual(plan.invalidated, ["buildContract", "spec", "verification"]);
});

test("requiresRegressionConfirmation is true when intent or spec is cleared", () => {
  assert.equal(requiresRegressionConfirmation(invalidationPlan("discovery")), true);
  assert.equal(requiresRegressionConfirmation(invalidationPlan("compile")), true);
  assert.equal(requiresRegressionConfirmation(invalidationPlan("requirements")), true);
});

test("buildRegressionPatch clears downstream artifacts", () => {
  const patch = buildRegressionPatch(baseSession(), "requirements");
  assert.equal(patch.phase, "resolving_requirements");
  assert.equal(patch.buildContract, null);
  assert.equal(patch.currentProposal, null);
  assert.equal(patch.workflowId, null);
  assert.equal(patch.resolvedIntent, undefined);
});
