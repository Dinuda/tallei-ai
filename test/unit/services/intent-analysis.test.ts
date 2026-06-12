import assert from "node:assert/strict";
import test from "node:test";

import {
  isUserFacingIntentQuestion,
  resolveLoopIntentContext,
} from "../../../src/services/loop-builder/intent-analysis.js";
import { loopIntentAnalysisSchema } from "../../../src/services/loop-engine/intent-context.js";

const newsletterPrompt = [
  "Write a weekly newsletter draft for my subscribers every Friday.",
  "Then send it to my marketing team using Gmail.",
].join(" ");

const sampleQuestion = {
  id: "approval_model",
  question: "What should happen after the newsletter is ready?",
  reason: "The request mixes drafting and delivery.",
  choices: [
    { id: "send_after_approval", label: "Send after approval", value: "Send after my approval", impact: "Execute delivery after a final approval." },
    { id: "draft_only", label: "Draft only", value: "Create a draft only", impact: "Stop after producing a reviewed draft." },
  ],
  recommendedChoiceId: "send_after_approval",
};

test("intent answers override defaults and skipped questions become assumptions", () => {
  const analysis = loopIntentAnalysisSchema.parse({
    normalizedIntent: {
      outcome: "Prepare and deliver a weekly AI newsletter.",
      toolCategories: ["email"],
      cadence: "Every Friday morning.",
      approvalModel: "Ambiguous between draft-only and send.",
      runtimeInputs: ["Recipient addresses"],
    },
    questions: [sampleQuestion],
    assumptions: [],
    connectorFeasibility: [],
    analyzedAt: "2026-06-12T00:00:00.000Z",
  });
  const context = resolveLoopIntentContext({
    analysis,
    answers: [{ questionId: "approval_model", choiceId: "draft_only" }],
    skippedQuestionIds: [],
  });
  assert.equal(context.decisions[0]?.answer, "Create a draft only");
  assert.equal(context.decisions[0]?.source, "user");
  assert.match(context.resolvedIntent, /Create a draft only/);
  assert.match(context.resolvedIntent, /Approval model:/);
});

test("free-text intent answers are sanitized before persistence", () => {
  const analysis = loopIntentAnalysisSchema.parse({
    normalizedIntent: {
      outcome: "Send a report.",
      toolCategories: ["email"],
      cadence: "Weekly.",
      approvalModel: "Send after approval.",
      runtimeInputs: [],
    },
    questions: [{
      ...sampleQuestion,
      id: "runtime_input",
      question: "Who should receive the report?",
    }],
    assumptions: [],
    connectorFeasibility: [],
    analyzedAt: "2026-06-12T00:00:00.000Z",
  });
  const context = resolveLoopIntentContext({
    analysis,
    answers: [{ questionId: "runtime_input", freeText: "Send to person@example.com" }],
  });
  assert.equal(context.decisions[0]?.answer, "Send to [runtime email]");
});

test("question filtering does not reinterpret model-owned semantics", () => {
  assert.equal(isUserFacingIntentQuestion(sampleQuestion), true);
  assert.equal(isUserFacingIntentQuestion({
    ...sampleQuestion,
    question: "Should the Composio action slug use GMAIL_SEND_EMAIL?",
  }), true);
});

test("intent resolution rejects answers outside the scoped analysis", () => {
  const analysis = loopIntentAnalysisSchema.parse({
    normalizedIntent: {
      outcome: "Prepare a newsletter.",
      toolCategories: ["email"],
      cadence: "Weekly.",
      approvalModel: "Needs clarification.",
      runtimeInputs: [],
    },
    questions: [sampleQuestion],
    assumptions: [],
    connectorFeasibility: [],
    analyzedAt: "2026-06-12T00:00:00.000Z",
  });
  assert.throws(() => resolveLoopIntentContext({
    analysis,
    answers: [{ questionId: "approval_model", choiceId: "fabricated_choice" }],
  }), /Unknown choice/);
  assert.throws(() => resolveLoopIntentContext({
    analysis,
    answers: [{ questionId: "unknown_question", freeText: "anything" }],
  }), /Unknown intent question/);
});
