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
import { computeOutcomeBriefHash } from "../../../src/loops/outcome-brief.js";
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

test("activateLoopInputSchema requires explicit confirmation and accepts optional compiledPlanId", () => {
  const id = "00000000-0000-4000-8000-000000000099";
  assert.equal(activateLoopInputSchema.safeParse({}).success, false);
  assert.deepEqual(activateLoopInputSchema.parse({ confirmedByUser: true }), { confirmedByUser: true });
  assert.deepEqual(activateLoopInputSchema.parse({ compiledPlanId: id, confirmedByUser: true }), { compiledPlanId: id, confirmedByUser: true });
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
    briefHash: "a".repeat(64),
    question: "Ready to build this?",
    options: [
      { id: "confirm", label: "Looks good", value: "confirm" },
      { id: "other", label: "Change something", value: "other" },
    ],
    recommendedOptionIds: ["confirm"],
  });
  assert.equal(parsed.question, "Ready to build this?");
  assert.equal(parsed.options.length, 2);
});

test("confirmOutcomeBriefInputSchema rejects briefHash-only payloads", () => {
  assert.throws(() => confirmOutcomeBriefInputSchema.parse({
    briefHash: "a".repeat(64),
  }));
});

test("confirmOutcomeBriefInputSchema rejects more than two options", () => {
  assert.throws(() => confirmOutcomeBriefInputSchema.parse({
    briefHash: "a".repeat(64),
    question: "Ready to build this?",
    options: [
      { id: "confirm", label: "Looks good", value: "confirm" },
      { id: "other", label: "Change it", value: "other" },
      { id: "other", label: "Change trigger", value: "other" },
    ],
  }));
});

test("confirmOutcomeBriefInputSchema rejects category-specific change options", () => {
  assert.throws(() => confirmOutcomeBriefInputSchema.parse({
    briefHash: "a".repeat(64),
    question: "Ready to build this?",
    options: [
      { id: "confirm", label: "Looks good", value: "confirm" },
      { id: "change_trigger", label: "Change trigger timing", value: "change_trigger" },
    ],
  }));
});

test("confirmOutcomeBriefInputSchema rejects allowOther true", () => {
  assert.throws(() => confirmOutcomeBriefInputSchema.parse({
    briefHash: "a".repeat(64),
    question: "Ready to build this?",
    options: [
      { id: "confirm", label: "Looks good", value: "confirm" },
      { id: "other", label: "Change it", value: "other" },
    ],
    allowOther: true,
  }));
});

test("confirmOutcomeBriefInputSchema rejects non-SHA-256 hashes", () => {
  assert.throws(() => confirmOutcomeBriefInputSchema.parse({
    briefHash: "brief-hash-123",
    question: "Ready to build this?",
    options: [
      { id: "confirm", label: "Looks good", value: "confirm" },
      { id: "other", label: "Change something", value: "other" },
    ],
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

test("buildConductorSystemPrompt issues every queued intent question in one turn", () => {
  const spec = createEmptyLoopSpec("00000000-0000-4000-8000-000000000001");
  const prompt = buildConductorSystemPrompt({
    spec,
    confirmationHash: computeOutcomeBriefHash(spec),
    connectedToolkits: [{ slug: "gmail", name: "Gmail", connected: true }],
  });

  assert.match(prompt, /askQuestion/);
  assert.match(prompt, /ask every returned question in the same assistant turn/i);
  assert.match(prompt, /askQuestion × N/i);
  assert.match(prompt, /N may be zero/i);
  assert.match(prompt, /never add a generic confirmation or filler question/i);
  assert.match(prompt, /Never ask which app, platform, inbox, provider, or service/i);
  assert.doesNotMatch(prompt, /single follow-up question/i);
  assert.doesNotMatch(prompt, /one clarification question at a time/i);
  assert.match(prompt, /Compile blockers/i);
  assert.match(prompt, /discoverBindings/);
  assert.match(prompt, /Available tools:/);
});

test("conductor builder renders interactive prompts without auto-selecting connectors", async () => {
  const fs = await import("node:fs/promises");
  const [source, layout, shared, route] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-builder-layout.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../src/transport/http/routes/loops.ts", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /InteractivePromptMenu/);
  assert.match(shared, /pickConnectorApp/);
  assert.match(shared, /hasUnansweredUiToolCalls/);
  assert.match(shared, /isConductorBudgetExhausted/);
  assert.match(source, /answerTool/);
  assert.match(source, /submitConductorToolAnswer/);
  assert.match(source, /parseContinuationIntent/);
  assert.match(source, /findPendingInteractivePrompts/);
  assert.match(source, /pendingQuestions/);
  assert.match(layout, /const activePendingQuestion = pendingQuestions\[0\] \?\? null/);
  assert.match(layout, /pendingQuestionStepsRef/);
  assert.doesNotMatch(layout, /\{pendingQuestions\.map\(/);
  assert.doesNotMatch(shared, /autoApplyConnector/);
  assert.doesNotMatch(shared, /shouldAutoSendConductorChat/);
  assert.doesNotMatch(shared, /hasPriorTerminalExecutionForOperation/);
  const pendingResolver = shared.slice(
    shared.indexOf("export function findPendingInteractivePrompts"),
    shared.indexOf("export function shouldShowThinkingIndicator"),
  );
  assert.match(pendingResolver, /prompts\.push/);
  assert.match(pendingResolver, /step: \{ index: index \+ 1, total: visible\.length \}/);
  assert.match(route, /conductorStepLimitForPhase\(requestStartPhase\)/);
  assert.match(route, /operationKey/);
  assert.match(route, /duplicateToolExecution/);
});
