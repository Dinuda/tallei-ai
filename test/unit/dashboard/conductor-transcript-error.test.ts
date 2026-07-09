import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveConductorTranscriptError,
  isReasoningOnlyAssistantMessage,
} from "../../../dashboard/src/lib/conductor-transcript-error.ts";

test("isReasoningOnlyAssistantMessage detects reasoning-only assistant turns", async () => {
  assert.equal(
    isReasoningOnlyAssistantMessage({
      id: "a1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "Planning next step.", state: "done" }],
    }),
    true,
  );
  assert.equal(
    isReasoningOnlyAssistantMessage({
      id: "a2",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Planning next step.", state: "done" },
        { type: "text", text: "How often should this run?" },
      ],
    }),
    false,
  );
});

test("deriveConductorTranscriptError surfaces blocked required-tool stalls", async () => {
  const error = deriveConductorTranscriptError({
    messages: [{
      id: "a1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "Need to analyze intent.", state: "done" }],
    }],
    chatStatus: "ready",
    phaseProgress: {
      phase: "intent",
      status: "in_progress",
      nextTool: "analyzeIntent",
      terminal: false,
    },
    loopStatus: "draft",
    latestPhaseTurn: {
      outcome: "blocked",
      resolutionReason: "required_tool_not_called",
      stepsUsed: 0,
    },
    continuationIntent: {
      action: "wait",
      reason: "required_tool_not_called",
      trigger: null,
    },
  });

  assert.ok(error);
  assert.match(error!.title, /Required tool was not called/i);
  assert.match(error!.message, /intent/i);
  assert.match(error!.message, /analyze Intent/i);
  assert.match(error!.message, /Continue or use Retry/i);
});

test("deriveConductorTranscriptError prefers stream errors", async () => {
  const error = deriveConductorTranscriptError({
    messages: [],
    chatStatus: "ready",
    streamError: "Rate limit exceeded",
    phaseProgress: null,
  });

  assert.equal(error?.message, "Rate limit exceeded");
});
