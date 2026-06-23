import assert from "node:assert/strict";
import test from "node:test";

test("mergeLoopBuilderUsageTotals derives total from prompt and completion", async () => {
  const { mergeLoopBuilderUsageTotals } = await import("../../../src/services/conductor/utils/progress.js");

  const merged = mergeLoopBuilderUsageTotals(
    {
      calls: 1,
      promptTokens: 783,
      completionTokens: 2_295,
      totalTokens: 9_999_999,
      estimatedCostUsd: 0.002,
      models: { "gpt-5.1": 1 },
    },
    {
      calls: 1,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 1_000_000,
      estimatedCostUsd: 0.001,
      models: { "gpt-4o": 1 },
    },
  );

  assert.equal(merged.promptTokens, 883);
  assert.equal(merged.completionTokens, 2_345);
  assert.equal(merged.totalTokens, 883 + 2_345);
  assert.equal(merged.estimatedCostUsd, 0.003);
});

test("usageFromLanguageModelStep ignores inflated provider totalTokens", async () => {
  const { usageFromLanguageModelStep } = await import("../../../src/services/conductor/utils/progress.js");

  const usage = usageFromLanguageModelStep(
    { promptTokens: 500, completionTokens: 250, totalTokens: 1_483_378 },
    "gpt-5.1",
  );

  assert.equal(usage.totalTokens, 750);
  assert.equal(usage.promptTokens, 500);
  assert.equal(usage.completionTokens, 250);
});
