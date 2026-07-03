import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import { applyPendingIntentAnswersFromTranscript } from "../../../src/loops/conductor-chat.js";
import {
  buildIntentAnswerPatch,
  isIntentResolutionPatch,
} from "../../../src/loops/intent-analysis.js";
import { intentAnalysisSchema } from "../../../src/loops/intent-discovery.js";
import { applySpecPatch } from "../../../src/loops/patch.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("buildIntentAnswerPatch records review-first approval and marks intent ready", () => {
  const analysis = intentAnalysisSchema.parse({
    outcome: "Send personalized replies to incoming support tickets",
    trigger: "When a new support ticket arrives",
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
  const spec = applySpecPatch(createEmptyLoopSpec(workspaceId), {
    intent: { outcome: analysis.outcome },
    intentDiscovery: {
      status: "needs_input",
      analysis,
      decisions: [],
      askedQuestionIds: ["approval-mode"],
    },
  });

  const patch = buildIntentAnswerPatch(
    spec,
    {
      questionId: "approval-mode",
      question: analysis.question!.question,
      options: analysis.question!.options,
    },
    {
      questionId: "approval-mode",
      answerText: "Review first",
      selectedOptionIds: ["review"],
      selectedValues: ["review_first"],
    },
  );

  assert.ok(patch);
  assert.equal(patch?.intentDiscovery?.status, "ready");
  assert.equal(patch?.approval?.mode, "mixed");
  assert.deepEqual(patch?.approval?.sensitiveRoles, ["destination"]);
  assert.equal(patch?.intentDiscovery?.decisions?.length, 1);
});

test("buildIntentAnswerPatch is idempotent for the same questionId", () => {
  const spec = applySpecPatch(createEmptyLoopSpec(workspaceId), {
    intentDiscovery: {
      status: "needs_input",
      decisions: [{
        questionId: "approval-mode",
        question: "Should replies send automatically or wait for your review?",
        answer: "Review first",
      }],
      askedQuestionIds: ["approval-mode"],
      analysis: intentAnalysisSchema.parse({
        outcome: "Send replies",
        trigger: "When a ticket arrives",
        decisions: [{
          questionId: "approval-mode",
          question: "Should replies send automatically or wait for your review?",
          answer: "Review first",
        }],
      }),
    },
  });

  const patch = buildIntentAnswerPatch(
    spec,
    {
      questionId: "approval-mode",
      question: "Should replies send automatically or wait for your review?",
      options: [
        { id: "review", label: "Review first", value: "review_first" },
        { id: "auto", label: "Send automatically", value: "auto" },
      ],
    },
    {
      questionId: "approval-mode",
      answerText: "Review first",
      selectedOptionIds: ["review"],
      selectedValues: ["review_first"],
    },
  );

  assert.equal(patch, null);
});

test("isIntentResolutionPatch allows intentDiscovery and approval only", () => {
  assert.equal(isIntentResolutionPatch({
    intentDiscovery: { status: "ready" },
    approval: { mode: "mixed" },
  }), true);
  assert.equal(isIntentResolutionPatch({
    taskBlueprint: {
      version: 1,
      summary: "Example",
      outcomes: [],
    },
  }), false);
});

test("applyPendingIntentAnswersFromTranscript patches spec from answered askQuestion", () => {
  const spec = applySpecPatch(createEmptyLoopSpec(workspaceId), {
    intent: { outcome: "Send personalized replies to incoming support tickets" },
    intentDiscovery: {
      status: "needs_input",
      askedQuestionIds: ["approval-mode"],
      decisions: [],
      analysis: intentAnalysisSchema.parse({
        outcome: "Send personalized replies to incoming support tickets",
        trigger: "When a new support ticket arrives",
        question: {
          id: "approval-mode",
          question: "Should replies send automatically or wait for your review?",
          options: [
            { id: "review", label: "Review first", value: "review_first" },
            { id: "auto", label: "Send automatically", value: "auto" },
          ],
        },
        decisions: [],
      }),
    },
  });

  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-askQuestion",
      toolCallId: "tool-1",
      state: "output-available",
      input: {
        questionId: "approval-mode",
        question: "Should replies send automatically or wait for your review?",
        options: [
          { id: "review", label: "Review first", value: "review_first" },
          { id: "auto", label: "Send automatically", value: "auto" },
        ],
      },
      output: {
        questionId: "approval-mode",
        answerText: "Review first",
        selectedOptionIds: ["review"],
        selectedValues: ["review_first"],
      },
    }],
  }] satisfies UIMessage[];

  const result = applyPendingIntentAnswersFromTranscript(messages, spec);
  assert.equal(result.applied, true);
  assert.equal(result.spec.intentDiscovery.status, "ready");
  assert.equal(result.spec.approval.mode, "mixed");
});
