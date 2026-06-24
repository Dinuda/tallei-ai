import assert from "node:assert/strict";
import test from "node:test";

import type { UIMessage } from "ai";

import type { WorkflowBuilderSession } from "../../../src/services/conductor/index.js";
import {
  buildBuilderSystemPrompt,
  compactBuilderContext,
  getBuilderStatePolicy,
} from "../../../src/services/conductor/builder/state-policy.js";

function session(overrides: Partial<WorkflowBuilderSession> = {}): WorkflowBuilderSession {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    builderState: "intent.collecting",
    title: "Test",
    goal: "Build a support ticket loop",
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

const messages: UIMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "Set up a loop that monitors support tickets and drafts replies." }],
  } as UIMessage,
];

test("intent policy forbids setup and provider questions", () => {
  const policy = getBuilderStatePolicy("intent.collecting");

  assert.match(policy.objective, /business outcome/i);
  assert.ok(policy.forbiddenTopics.some((topic) => /app selection/i.test(topic)));
  assert.ok(policy.forbiddenTopics.some((topic) => /AI providers/i.test(topic)));
  assert.equal(Boolean(policy.actionGuidance.intentClarification), true);
  assert.equal(Boolean(policy.actionGuidance.resolveIntent), true);
});

test("builder system prompt uses one stable identity", () => {
  const prompt = buildBuilderSystemPrompt({
    state: "requirements.selecting_apps",
    allowedActions: ["appSelection", "getAvailableTools"],
    session: session({ builderState: "requirements.selecting_apps" }),
    messages,
  });

  assert.match(prompt, /You are Tallei Builder/);
  assert.match(prompt, /not a rotating specialist persona/);
  assert.doesNotMatch(prompt, /Intent Analyst|Setup Coordinator|Flow Architect|Launch Specialist/);
  assert.match(prompt, /Allowed action guidance/);
});

test("compact builder context carries durable state instead of transcript prose", () => {
  const context = compactBuilderContext({
    state: "requirements.resolving",
    allowedActions: ["requirementSetup", "resolveBuildRequirement"],
    session: session({
      builderState: "requirements.resolving",
      buildContract: {
        version: "v1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        issues: [],
        requirements: [{
          id: "trigger_schedule",
          kind: "trigger_schedule",
          required: true,
          status: "unresolved",
          question: "How should this loop run?",
        }],
      },
    }),
    messages,
  });

  assert.equal(context.state, "requirements.resolving");
  assert.deepEqual(context.allowedActions, ["requirementSetup", "resolveBuildRequirement"]);
  assert.equal((context.unresolvedRequirements as unknown[]).length, 1);
  assert.equal(context.latestUserMessage, "Set up a loop that monitors support tickets and drafts replies.");
});
