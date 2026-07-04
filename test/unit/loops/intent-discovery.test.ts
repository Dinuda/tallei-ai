import assert from "node:assert/strict";
import test from "node:test";

import { intentAnalysisSchema } from "../../../src/loops/intent-discovery.js";

const completeExecutionOrder = [
  { role: "trigger", description: "Receives an incoming support request" },
  { role: "transform", description: "Drafts a personalized reply" },
  { role: "destination", description: "Sends the reply to the customer" },
] as const;

test("intent analysis schema accepts zero queued questions", () => {
  const missingQuestions = intentAnalysisSchema.safeParse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
    executionOrder: completeExecutionOrder,
  });
  const emptyQuestions = intentAnalysisSchema.safeParse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
    executionOrder: completeExecutionOrder,
    questions: [],
  });

  assert.equal(missingQuestions.success, true);
  assert.equal(emptyQuestions.success, true);
});

test("intent analysis schema accepts up to four business questions", () => {
  const analysis = intentAnalysisSchema.parse({
    outcome: "Send personalized replies to incoming support emails",
    trigger: "When a new support email arrives",
    executionOrder: completeExecutionOrder,
    questions: [
      {
        id: "scope",
        question: "Which support requests should be handled?",
        options: [
          { id: "all", label: "All requests", value: "all" },
          { id: "urgent", label: "Urgent requests", value: "urgent" },
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
    executionOrder: completeExecutionOrder,
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
    executionOrder: completeExecutionOrder,
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

test("intent analysis schema rejects app and platform questions", () => {
  const parsed = intentAnalysisSchema.safeParse({
    outcome: "Send personalized replies to incoming support requests",
    trigger: "When a support request arrives",
    executionOrder: completeExecutionOrder,
    questions: [{
      id: "support-platform",
      question: "Which support platform do your tickets come from?",
      options: [
        { id: "gmail", label: "Gmail", value: "gmail" },
        { id: "zendesk", label: "Zendesk", value: "zendesk" },
      ],
    }],
  });

  assert.equal(parsed.success, false);
});

test("intent analysis schema leaves ticket-source questions to connector discovery", () => {
  const parsed = intentAnalysisSchema.safeParse({
    outcome: "Send personalized replies to incoming support requests",
    trigger: "When a support request arrives",
    executionOrder: completeExecutionOrder,
    questions: [{
      id: "ticket-source",
      question: "Where do the support tickets come from?",
      options: [
        { id: "helpdesk", label: "Help desk", value: "helpdesk" },
        { id: "shared", label: "Shared queue", value: "shared_queue" },
      ],
    }],
  });

  assert.equal(parsed.success, false);
});

test("intent analysis schema requires a complete plan starting with a trigger", () => {
  const empty = intentAnalysisSchema.safeParse({
    outcome: "Handle support requests",
    trigger: "When a request arrives",
    executionOrder: [],
  });
  const wrongOrder = intentAnalysisSchema.safeParse({
    outcome: "Handle support requests",
    trigger: "When a request arrives",
    executionOrder: [
      { role: "transform", description: "Classifies the request" },
      { role: "destination", description: "Sends the reply" },
    ],
  });

  assert.equal(empty.success, false);
  assert.equal(wrongOrder.success, false);
});
