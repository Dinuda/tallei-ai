import assert from "node:assert/strict";
import test from "node:test";

test("finalizeBuilderLiveUsage always sets total to prompt plus completion", async () => {
  const { finalizeBuilderLiveUsage, sumBuilderLiveUsage } = await import(
    "../../../dashboard/src/lib/loop-builder-usage.ts"
  );

  assert.deepEqual(
    finalizeBuilderLiveUsage({ promptTokens: 783, completionTokens: 2_295, totalTokens: 1_483_378, estimatedCostUsd: 0.0048 }),
    {
      promptTokens: 783,
      completionTokens: 2_295,
      totalTokens: 3_078,
      estimatedCostUsd: 0.0048,
    },
  );

  assert.deepEqual(
    sumBuilderLiveUsage(
      { promptTokens: 783, completionTokens: 2_295, totalTokens: 1_483_378, estimatedCostUsd: 0.004 },
      { promptTokens: 100, completionTokens: 50, totalTokens: 999_999, estimatedCostUsd: 0.0008 },
    ),
    {
      promptTokens: 883,
      completionTokens: 2_345,
      totalTokens: 3_228,
      estimatedCostUsd: 0.0048,
    },
  );
});
