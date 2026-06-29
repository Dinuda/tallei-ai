import assert from "node:assert/strict";
import test from "node:test";

import {
  activateLoopInputSchema,
  askQuestionInputSchema,
  askQuestionOutputSchema,
  compileLoopInputSchema,
  confirmOutcomeBriefInputSchema,
  testRunLoopInputSchema,
} from "../../../src/loops/conductor-tools.js";
import { buildConductorSystemPrompt } from "../../../src/loops/planning-agent.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

test("testRunLoopInputSchema accepts scenario payload", () => {
  const parsed = testRunLoopInputSchema.parse({
    scenario: {
      label: "New Gmail message",
      triggerPayload: { from: "user@example.com" },
      context: "Support request",
    },
  });
  assert.equal(parsed.scenario.label, "New Gmail message");
});

test("compileLoopInputSchema accepts empty payload", () => {
  assert.deepEqual(compileLoopInputSchema.parse({}), {});
});

test("activateLoopInputSchema accepts optional compiledPlanId", () => {
  const id = "00000000-0000-4000-8000-000000000099";
  assert.deepEqual(activateLoopInputSchema.parse({}), {});
  assert.deepEqual(activateLoopInputSchema.parse({ compiledPlanId: id }), { compiledPlanId: id });
});

test("askQuestionInputSchema accepts structured question payloads", () => {
  const parsed = askQuestionInputSchema.parse({
    questionId: "trigger",
    question: "How should this loop start?",
    options: [
      { id: "manual", label: "Manual", value: "manual" },
      { id: "schedule", label: "Schedule", value: "schedule" },
    ],
    recommendedOptionIds: ["manual"],
    step: { index: 1, total: 5 },
  });

  assert.equal(parsed.questionId, "trigger");
  assert.equal(parsed.step?.total, 5);
});

test("askQuestionInputSchema rejects questions with fewer than two options", () => {
  assert.throws(() => askQuestionInputSchema.parse({
    questionId: "trigger",
    question: "How should this loop start?",
    options: [{ id: "manual", label: "Manual", value: "manual" }],
  }));
});

test("confirmOutcomeBriefInputSchema requires LLM-provided question and options", () => {
  const parsed = confirmOutcomeBriefInputSchema.parse({
    briefHash: "abc123",
    question: "Ready to build this?",
    options: [
      { id: "confirm", label: "Looks good", value: "confirm" },
      { id: "changes", label: "Change something", value: "other" },
    ],
    recommendedOptionIds: ["confirm"],
  });
  assert.equal(parsed.question, "Ready to build this?");
  assert.equal(parsed.options.length, 2);
});

test("confirmOutcomeBriefInputSchema rejects briefHash-only payloads", () => {
  assert.throws(() => confirmOutcomeBriefInputSchema.parse({
    briefHash: "abc123",
  }));
});

test("askQuestionOutputSchema accepts user answers", () => {
  const parsed = askQuestionOutputSchema.parse({
    questionId: "trigger",
    answerText: "manual",
    selectedOptionIds: ["manual"],
    selectedValues: ["manual"],
  });

  assert.equal(parsed.answerText, "manual");
});

test("buildConductorSystemPrompt requires askQuestion only as last resort", () => {
  const spec = createEmptyLoopSpec("00000000-0000-4000-8000-000000000001");
  const prompt = buildConductorSystemPrompt({
    spec,
    connectedToolkits: [{ slug: "gmail", name: "Gmail", connected: true }],
  });

  assert.match(prompt, /askQuestion/);
  assert.match(prompt, /Compile blockers/i);
  assert.match(prompt, /discoverBindings/);
});

test("conductor builder renders interactive prompts without auto-selecting connectors", async () => {
  const fs = await import("node:fs/promises");
  const [source, layout, shared] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-builder-layout.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /InteractivePromptMenu/);
  assert.match(shared, /pickConnectorApp/);
  assert.match(shared, /hasUnansweredUiToolCalls/);
  assert.match(shared, /shouldAutoSendConductorChat/);
  assert.match(source, /addToolOutput/);
  assert.match(source, /shouldAutoSendConductorChat/);
  assert.match(source, /findPendingInteractivePrompt/);
  assert.doesNotMatch(source, /findAutoConnectorPromptTarget/);
  assert.doesNotMatch(shared, /autoApplyConnector/);
  const pendingResolver = shared.slice(
    shared.indexOf("export function findPendingInteractivePrompt"),
    shared.indexOf("export function shouldShowThinkingIndicator"),
  );
  assert.doesNotMatch(pendingResolver, /if \(!blueprintNeedsConnectorPick\(spec\)\) return null/);
});
