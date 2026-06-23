import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import {
  formatContractValidationReason,
  stripToSchema,
  validateContractData,
} from "../../../src/services/conductor/contracts/data-contract.js";
import { normalizeRunMessages, pruneStepNarrationForStep, sanitizeSpecRunMessages } from "../../../src/services/conductor/runtime/run-messages.js";
import { dataInputSurfaceSchema, reviewSurfaceSchema } from "../../../src/services/conductor/contracts/input-surfaces.js";

test("stripToSchema keeps only declared contract properties", () => {
  const schema = {
    type: "object",
    properties: {
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["subject", "body"],
    additionalProperties: false,
  };
  const stripped = stripToSchema(schema, {
    subject: "Hello",
    body: "World",
    rationale: "extra",
    html: "<p>World</p>",
  }) as Record<string, unknown>;

  assert.deepEqual(stripped, { subject: "Hello", body: "World" });
  assert.equal(validateContractData(schema, stripped).valid, true);
});

test("formatContractValidationReason collapses repeated additionalProperties errors", () => {
  const reason = formatContractValidationReason(
    "data must NOT have additional properties, data must NOT have additional properties, data must NOT have additional properties",
  );
  assert.equal(reason, "Output has unexpected additional properties.");
});

test("sanitizeSpecRunMessages removes narration when finalizeAgent completed", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "data-agent", data: { stepIndex: 1 } },
      { type: "text", text: "Let me draft the reply now." },
      { type: "tool-finalizeAgent", toolCallId: "call-1", state: "output-available", input: {}, output: {} },
    ],
  }] satisfies UIMessage[];

  const sanitized = sanitizeSpecRunMessages(messages);
  assert.equal(sanitized[0]?.parts.some((part) => part.type === "text"), false);
  assert.equal(sanitized[0]?.parts.some((part) => part.type === "tool-finalizeAgent"), true);
});

test("normalizeRunMessages merges assistant parts for the same step index", () => {
  const messages = [
    {
      id: "assistant-step-0-a",
      role: "assistant",
      parts: [
        { type: "data-agent", data: { stepIndex: 0, agentId: "a", agentName: "Context", phase: "working" } },
        { type: "tool-searchMemory", toolCallId: "call-1", state: "output-available", input: {}, output: {} },
      ],
    },
    {
      id: "assistant-step-0-b",
      role: "assistant",
      parts: [
        { type: "data-agent", data: { stepIndex: 0, agentId: "a", agentName: "Context", phase: "working" } },
        { type: "text", text: "Finished context gathering." },
      ],
    },
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Continue" }] },
  ] satisfies UIMessage[];

  const normalized = normalizeRunMessages(messages);
  const merged = normalized.find((message) => message.id === "assistant-step-0-b");

  assert.ok(merged);
  assert.equal(merged?.parts.some((part) => part.type === "tool-searchMemory"), true);
  assert.equal(merged?.parts.some((part) => part.type === "text"), true);
  assert.equal(normalized.filter((message) => message.role === "assistant").length, 1);
});

test("pruneStepNarrationForStep removes stale draft text before a step retry", () => {
  const messages = [
    {
      id: "assistant-step-1",
      role: "assistant",
      parts: [
        { type: "data-agent", data: { stepIndex: 1, agentId: "draft", agentName: "Draft", phase: "working" } },
        { type: "text", text: "Old draft body" },
        { type: "tool-requestGate", toolCallId: "call-1", state: "output-available", input: { type: "review" }, output: {} },
      ],
    },
  ] satisfies UIMessage[];

  const pruned = pruneStepNarrationForStep(messages, 1);
  assert.equal(pruned[0]?.parts.some((part) => part.type === "text"), false);
  assert.equal(pruned[0]?.parts.some((part) => part.type === "tool-requestGate"), true);
});

test("normalizeRunMessages keeps the latest draft text when a step restarts", () => {
  const messages = [
    {
      id: "assistant-step-1-a",
      role: "assistant",
      parts: [
        { type: "data-agent", data: { stepIndex: 1, agentId: "draft", agentName: "Draft", phase: "working" } },
        { type: "text", text: "Old draft body" },
      ],
    },
    {
      id: "assistant-step-1-b",
      role: "assistant",
      parts: [
        { type: "data-agent", data: { stepIndex: 1, agentId: "draft", agentName: "Draft", phase: "working" } },
        { type: "text", text: "New draft body" },
      ],
    },
  ] satisfies UIMessage[];

  const normalized = normalizeRunMessages(messages);
  const merged = normalized.find((message) => message.role === "assistant");
  const text = merged?.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(text, "New draft body");
});

test("requestGate keeps input and review surface schemas split by gate type", () => {
  assert.equal(dataInputSurfaceSchema.safeParse("input.text").success, true);
  assert.equal(dataInputSurfaceSchema.safeParse("review.draft").success, false);
  assert.equal(reviewSurfaceSchema.safeParse("review.draft").success, true);
  assert.equal(reviewSurfaceSchema.safeParse("input.text").success, false);
});
