import assert from "node:assert/strict";
import test from "node:test";

import { intentAnalysisSchema } from "../../../src/loops/intent-discovery.js";

test("intent analysis schema requires at least one queued question", () => {
  const missingQuestions = intentAnalysisSchema.safeParse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
  });
  const emptyQuestions = intentAnalysisSchema.safeParse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
    questions: [],
  });

  assert.equal(missingQuestions.success, false);
  assert.equal(emptyQuestions.success, false);
});

test("intent analysis schema accepts between one and four queued questions", () => {
  const analysis = intentAnalysisSchema.parse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
    questions: [
      {
        id: "channel",
        question: "Which email inbox should we watch?",
        options: [
          { id: "primary", label: "Primary inbox", value: "primary" },
          { id: "shared", label: "Shared inbox", value: "shared" },
        ],
      },
      {
        id: "review",
        question: "Should drafts be reviewed before sending?",
        options: [
          { id: "review", label: "Review first", value: "review_first" },
          { id: "auto", label: "Send automatically", value: "auto" },
        ],
      },
      {
        id: "tone",
        question: "What tone should the replies use?",
        options: [
          { id: "friendly", label: "Friendly", value: "friendly" },
          { id: "formal", label: "Formal", value: "formal" },
        ],
      },
      {
        id: "follow-up",
        question: "Should we add a follow-up reminder?",
        options: [
          { id: "yes", label: "Yes", value: "yes" },
          { id: "no", label: "No", value: "no" },
        ],
      },
    ],
  });

  assert.equal(analysis.questions.length, 4);
});

test("intent analysis schema rejects five queued questions", () => {
  const parsed = intentAnalysisSchema.safeParse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
    questions: Array.from({ length: 5 }, (_, index) => ({
      id: `q-${index + 1}`,
      question: `Question ${index + 1}?`,
      options: [
        { id: "yes", label: "Yes", value: "yes" },
        { id: "no", label: "No", value: "no" },
      ],
    })),
  });

  assert.equal(parsed.success, false);
});

test("intent analysis schema rejects duplicate question IDs", () => {
  const parsed = intentAnalysisSchema.safeParse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
    questions: [
      {
        id: "review",
        question: "Should drafts be reviewed before sending?",
        options: [
          { id: "review", label: "Review first", value: "review_first" },
          { id: "auto", label: "Send automatically", value: "auto" },
        ],
      },
      {
        id: "review",
        question: "Should we ask for a second approval?",
        options: [
          { id: "yes", label: "Yes", value: "yes" },
          { id: "no", label: "No", value: "no" },
        ],
      },
    ],
  });

  assert.equal(parsed.success, false);
});
