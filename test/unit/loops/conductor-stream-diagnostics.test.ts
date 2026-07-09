import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConductorStreamError,
  summarizeAssistantMessageParts,
} from "../../../src/loops/conductor-stream-diagnostics.js";

test("formatConductorStreamError extracts nested OpenAI rate limit message", () => {
  const formatted = formatConductorStreamError({
    type: "error",
    error: {
      type: "tokens",
      code: "rate_limit_exceeded",
      message: "Rate limit reached for gpt-5-nano",
    },
  });
  assert.match(formatted, /rate_limit_exceeded/);
  assert.match(formatted, /Rate limit reached/);
});

test("summarizeAssistantMessageParts flags empty reasoning-only turns", () => {
  const parts = summarizeAssistantMessageParts({
    id: "a1",
    role: "assistant",
    parts: [{ type: "reasoning", text: "", state: "done" }],
  });
  assert.deepEqual(parts, [{ type: "reasoning", textLength: 0, empty: true }]);
});

test("detectLastVisiblePartType ignores hidden reasoning-only turns", async () => {
  const {
    detectLastVisiblePartType,
    detectPendingToolState,
  } = await import("../../../src/loops/conductor-stream-diagnostics.js");

  assert.equal(detectLastVisiblePartType({
    id: "a1",
    role: "assistant",
    parts: [
      { type: "reasoning", text: "thinking", state: "done" },
      { type: "tool-analyzeIntent", toolCallId: "call-1", state: "output-available" },
    ],
  }), "tool:analyzeIntent");

  assert.equal(detectPendingToolState({
    id: "a1",
    role: "assistant",
    parts: [{
      type: "tool-askQuestion",
      toolCallId: "call-2",
      state: "input-available",
    }],
  }), "askQuestion:input-available");
});
