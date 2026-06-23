import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyRevisionIntent,
  evaluateRevisionIntentGuardrails,
  isAutoContinueUserMessage,
  loopIntentRevisionSchema,
} from "../../../src/services/conductor/contracts/intent-context.js";
import type { WorkflowBuilderSession } from "../../../src/services/conductor/services/session.service.js";
import { emptyLoopBuilderUsage } from "../../../src/services/conductor/utils/progress.js";

const intentContextPath = new URL(
  "../../../src/services/conductor/contracts/intent-context.ts",
  import.meta.url,
);

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
    resolvedIntent: null,
    discoveredToolContracts: [],
    buildContract: null,
    artifactBundleJson: null,
    currentProposal: null,
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

test("isAutoContinueUserMessage matches continue and resume only", () => {
  assert.equal(isAutoContinueUserMessage("continue"), true);
  assert.equal(isAutoContinueUserMessage("Resume"), true);
  assert.equal(isAutoContinueUserMessage("change my connector"), false);
  assert.equal(isAutoContinueUserMessage(""), false);
});

test("classifyRevisionIntent skips LLM for auto-continue messages", async () => {
  const result = await classifyRevisionIntent({
    session: baseSession(),
    userMessage: "continue",
  });
  assert.equal(result.targetPhase, null);
  assert.equal(result.confidence, 0);
});

test("evaluateRevisionIntentGuardrails returns targetPhase when confident and allowed", () => {
  const parsed = loopIntentRevisionSchema.parse({
    targetPhase: "discovery",
    revisedArtifact: "intent",
    confidence: 0.9,
    reason: "User wants to change the loop goal",
  });
  const result = evaluateRevisionIntentGuardrails(parsed, "compile");
  assert.equal(result.targetPhase, "discovery");
  assert.equal(result.revisedArtifact, "intent");
});

test("evaluateRevisionIntentGuardrails rejects low-confidence revisions", () => {
  const parsed = loopIntentRevisionSchema.parse({
    targetPhase: "discovery",
    revisedArtifact: "intent",
    confidence: 0.4,
    reason: "Uncertain",
  });
  const result = evaluateRevisionIntentGuardrails(parsed, "compile");
  assert.equal(result.targetPhase, null);
});

test("evaluateRevisionIntentGuardrails rejects invalid regression paths", () => {
  const parsed = loopIntentRevisionSchema.parse({
    targetPhase: "verification",
    revisedArtifact: "verification",
    confidence: 0.95,
    reason: "Skip ahead",
  });
  const result = evaluateRevisionIntentGuardrails(parsed, "requirements");
  assert.equal(result.targetPhase, null);
  assert.match(result.reason, /not allowed/);
});

test("classifyRevisionIntent uses loopBuilderOpenAiChat with JSON prompt", async () => {
  const source = await readFile(intentContextPath, "utf8");
  assert.match(source, /loopBuilderOpenAiChat/);
  assert.match(source, /responseFormat:\s*"json_object"/);
  assert.match(source, /Return JSON:/);
  assert.doesNotMatch(source, /generateObject/);
});
