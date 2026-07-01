import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import {
  normalizeConductorChatMessages,
  sanitizeConductorChatMessages,
} from "../../../src/loops/conductor-chat.js";

test("normalizeConductorChatMessages drops empty assistant placeholders", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    { id: "assistant-empty", role: "assistant", parts: [] },
    { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Which trigger?" }] },
  ] satisfies UIMessage[];

  assert.deepEqual(
    normalizeConductorChatMessages(messages).map((message) => message.id),
    ["user-1", "assistant-1"],
  );
});

test("sanitizeConductorChatMessages strips OpenAI item ids from replayed history", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "reasoning",
      text: "Planning",
      providerOptions: { openai: { itemId: "rs_123" } },
    }],
  }] satisfies UIMessage[];

  const sanitized = sanitizeConductorChatMessages(messages);
  const reasoning = sanitized[0]?.parts[0] as { providerOptions?: { openai?: { itemId?: string } } };
  assert.equal(reasoning.providerOptions?.openai?.itemId, undefined);
});

test("sanitizeConductorChatMessages promotes interrupted UI prompts to input-available when input is complete", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-askQuestion",
      toolCallId: "tool-1",
      state: "input-streaming",
      input: {
        questionId: "trigger",
        question: "How should this start?",
        options: [
          { id: "manual", label: "Manual", value: "manual" },
          { id: "email", label: "Email", value: "email" },
        ],
      },
    }],
  }] satisfies UIMessage[];

  const sanitized = sanitizeConductorChatMessages(messages);
  const toolPart = sanitized[0]?.parts[0] as { state?: string; output?: unknown };
  assert.equal(toolPart.state, "input-available");
  assert.equal(toolPart.output, undefined);
});

test("sanitizeConductorChatMessages turns interrupted background tools into output-error", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-discoverBindings",
      toolCallId: "tool-1",
      state: "input-streaming",
      input: {
        toolkit: "gmail",
        outcomes: [{ id: "out-1", description: "Send email" }],
      },
    }],
  }] satisfies UIMessage[];

  const sanitized = sanitizeConductorChatMessages(messages);
  const toolPart = sanitized[0]?.parts[0] as {
    state?: string;
    output?: { error?: string; interrupted?: boolean };
    errorText?: string;
  };
  assert.equal(toolPart.state, "output-error");
  assert.equal(toolPart.output?.interrupted, true);
  assert.match(toolPart.output?.error ?? "", /interrupted/i);
  assert.match(toolPart.errorText ?? "", /interrupted/i);
});
