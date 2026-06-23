import assert from "node:assert/strict";
import test from "node:test";

import {
  createLoopIntentContext,
  loopIntentAnalysisSchema,
  normalizeLoopIntentContext,
} from "../../../src/services/conductor/contracts/intent-context.js";

const analysis = loopIntentAnalysisSchema.parse({
  normalizedIntent: {
    outcome: "Monitor Gmail support",
    toolCategories: [],
    cadence: "On new email",
    approvalModel: "Human approval",
    runtimeInputs: [],
  },
  questions: [],
  assumptions: ["Tickets arrive by email"],
  connectorFeasibility: [],
  interactivePrompts: [],
  events: [],
  analyzedAt: "2026-06-23T10:29:37.366Z",
});

test("createLoopIntentContext does not duplicate assumptions at top level", () => {
  const context = createLoopIntentContext({
    analysis,
    resolvedIntent: "Monitor Gmail support",
    resolvedAt: "2026-06-23T10:29:37.366Z",
  });
  assert.deepEqual(context.assumptions, []);
  assert.deepEqual(context.analysis.assumptions, ["Tickets arrive by email"]);
});

test("normalizeLoopIntentContext strips mirrored legacy assumptions", () => {
  const legacy = {
    analysis,
    decisions: [],
    assumptions: [...analysis.assumptions],
    resolvedIntent: "Monitor Gmail support",
    resolvedAt: "2026-06-23T10:29:37.366Z",
  };
  const normalized = normalizeLoopIntentContext(legacy);
  assert.deepEqual(normalized.assumptions, []);
});

test("normalizeLoopIntentContext keeps decision-derived assumptions", () => {
  const withDecision = {
    analysis,
    decisions: [{ questionId: "q1", question: "Cadence?", answer: "Hourly", source: "user" as const }],
    assumptions: ["Tickets arrive by email", "Hourly cadence confirmed"],
    resolvedIntent: "Monitor Gmail support",
    resolvedAt: "2026-06-23T10:29:37.366Z",
  };
  const normalized = normalizeLoopIntentContext(withDecision);
  assert.deepEqual(normalized.assumptions, ["Tickets arrive by email", "Hourly cadence confirmed"]);
});
