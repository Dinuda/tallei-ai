import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeChatMessages,
  runStatusToChatMessage,
  stepToChatMessages,
} from "../../../src/loops/loop-chat.js";

test("stepToChatMessages maps planner finish to assistant text", () => {
  const messages = stepToChatMessages({
    stepIndex: 2,
    kind: "plan",
    outputJson: { kind: "finish", summary: "Done." },
    status: "completed",
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "assistant");
  const textPart = messages[0]?.parts?.[0];
  assert.equal(textPart?.type, "text");
  assert.equal((textPart as { text?: string }).text, "Done.");
});

test("runStatusToChatMessage uses stable id per run and status", () => {
  const message = runStatusToChatMessage({
    runId: "run-1",
    status: "failed",
    error: "boom",
  });
  assert.equal(message.id, "run-run-1-failed");
  assert.match(String((message.parts[0] as { text?: string }).text), /boom/);
});

test("mergeChatMessages dedupes by message id", () => {
  const existing = [{ id: "a", role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }];
  const incoming = [
    { id: "a", role: "user" as const, parts: [{ type: "text" as const, text: "duplicate" }] },
    { id: "b", role: "assistant" as const, parts: [{ type: "text" as const, text: "ok" }] },
  ];
  const merged = mergeChatMessages(existing, incoming);
  assert.deepEqual(merged.map((m) => m.id), ["a", "b"]);
  assert.equal((merged[0]?.parts[0] as { text?: string }).text, "hi");
});
