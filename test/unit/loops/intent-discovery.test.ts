import assert from "node:assert/strict";
import test from "node:test";

import {
  intentAnalysisSchema,
  unresolvedIntentQuestion,
} from "../../../src/loops/intent-discovery.js";

test("intent analysis schema accepts canonical approval payloads", () => {
  const analysis = intentAnalysisSchema.parse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
    executionOrder: [
      { role: "trigger", description: "When a new support email arrives" },
      { role: "transform", description: "Classify and draft personalized replies" },
      { role: "destination", description: "Send replies after review" },
    ],
    approval: {
      mode: "mixed",
      sensitiveRoles: ["destination"],
      sensitiveCapabilities: [],
    },
    decisions: [{
      questionId: "approval-mode",
      question: "Should replies send automatically or wait for your review?",
      answer: "Review first",
    }],
  });

  assert.equal(analysis.approval?.mode, "mixed");
  assert.deepEqual(analysis.approval?.sensitiveRoles, ["destination"]);
  assert.equal(analysis.executionOrder.length, 3);
});

test("intent analysis schema defaults executionOrder to empty array", () => {
  const analysis = intentAnalysisSchema.parse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
  });
  assert.deepEqual(analysis.executionOrder, []);
});

test("unresolvedIntentQuestion suppresses already asked or answered questions", () => {
  const analysis = intentAnalysisSchema.parse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
    question: {
      id: "approval-mode",
      question: "Should replies send automatically or wait for your review?",
      options: [
        { id: "review", label: "Review first", value: "review_first" },
        { id: "auto", label: "Send automatically", value: "auto" },
      ],
    },
    decisions: [],
  });

  assert.equal(unresolvedIntentQuestion(analysis)?.id, "approval-mode");
  assert.equal(unresolvedIntentQuestion(analysis, {
    status: "needs_input",
    decisions: [],
    askedQuestionIds: ["approval-mode"],
  }), undefined);
});
