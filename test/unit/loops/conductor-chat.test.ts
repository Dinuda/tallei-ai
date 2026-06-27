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
