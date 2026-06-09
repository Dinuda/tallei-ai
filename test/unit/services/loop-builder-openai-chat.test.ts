import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.OPENAI_API_KEY ??= "test-openai-key";

test("isLoopBuilderReasoningModel detects gpt-5 and o-series models", async () => {
  const { isLoopBuilderReasoningModel } = await import("../../../src/services/loop-builder/openai-chat.js");
  assert.equal(isLoopBuilderReasoningModel("gpt-5.1"), true);
  assert.equal(isLoopBuilderReasoningModel("gpt-5-mini"), true);
  assert.equal(isLoopBuilderReasoningModel("o3-mini"), true);
  assert.equal(isLoopBuilderReasoningModel("gpt-4o"), false);
});

test("loopBuilderOpenAiReasoningEffort defaults to minimal and can be disabled", async () => {
  const previous = process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT;
  delete process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT;

  try {
    const mod = await import("../../../src/services/loop-builder/openai-chat.js?t=default");
    assert.equal(mod.loopBuilderOpenAiReasoningEffort(), "minimal");

    process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT = "high";
    const modHigh = await import("../../../src/services/loop-builder/openai-chat.js?t=high");
    assert.equal(modHigh.loopBuilderOpenAiReasoningEffort(), "high");

    process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT = "none";
    const modNone = await import("../../../src/services/loop-builder/openai-chat.js?t=none");
    assert.equal(modNone.loopBuilderOpenAiReasoningEffort(), null);
  } finally {
    if (previous === undefined) delete process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT;
    else process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT = previous;
  }
});
