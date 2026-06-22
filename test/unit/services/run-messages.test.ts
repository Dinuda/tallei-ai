import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import { mergeRunChatMessages, normalizeRunMessages } from "../../../src/services/loop-runtime/run-messages.js";

test("loop run messages discard empty interrupted-stream assistant artifacts", () => {
  const messages = [
    { id: "seed", role: "user", parts: [{ type: "text", text: "Ticket body" }] },
    { id: "approval", role: "user", parts: [{ type: "text", text: "approve" }] },
    { id: "assistant-empty", role: "assistant", parts: [] },
    { id: "approval-2", role: "user", parts: [{ type: "text", text: "approve" }] },
  ] satisfies UIMessage[];

  assert.deepEqual(
    normalizeRunMessages(messages).map((message) => message.id),
    ["seed", "approval", "approval-2"],
  );
});

test("loop run messages dedupe repeated message ids", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "approve" }] },
    { id: "user-1", role: "user", parts: [{ type: "text", text: "approve again" }] },
  ] satisfies UIMessage[];

  const normalized = normalizeRunMessages(messages);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.parts[0]?.type === "text" ? normalized[0].parts[0].text : "", "approve");
});

test("mergeRunChatMessages keeps server tool patches and appends new client turns", () => {
  const server = [
    { id: "seed", role: "user", parts: [{ type: "text", text: "Ticket body" }] },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-requestGate",
        toolCallId: "call-1",
        state: "output-available",
        input: { type: "review" },
        output: { ok: true, approved: true },
      }],
    },
  ] satisfies UIMessage[];
  const client = [
    ...server,
    { id: "continue-1", role: "user", parts: [{ type: "text", text: "Continue" }] },
  ] satisfies UIMessage[];

  const merged = mergeRunChatMessages(server, client);

  assert.equal(merged.length, 3);
  assert.equal(merged[1]?.parts[0]?.type, "tool-requestGate");
  assert.equal(merged[2]?.id, "continue-1");
});
