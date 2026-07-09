import assert from "node:assert/strict";
import test from "node:test";

test("usageFromLanguageModelStep reads AI SDK v6 inputTokens and outputTokens", async () => {
  const { usageFromLanguageModelStep } = await import("../../../src/loops/conductor-usage.js");

  const usage = usageFromLanguageModelStep(
    { inputTokens: 1_200, outputTokens: 340, totalTokens: 9_999 },
    "gpt-5-mini",
  );

  assert.equal(usage.promptTokens, 1_200);
  assert.equal(usage.completionTokens, 340);
  assert.equal(usage.totalTokens, 1_540);
  assert.ok(usage.estimatedCostUsd > 0);
});

test("usageFromLanguageModelStep still supports legacy promptTokens and completionTokens", async () => {
  const { usageFromLanguageModelStep } = await import("../../../src/loops/conductor-usage.js");

  const usage = usageFromLanguageModelStep(
    { promptTokens: 500, completionTokens: 250, totalTokens: 1_483_378 },
    "gpt-5.1",
  );

  assert.equal(usage.promptTokens, 500);
  assert.equal(usage.completionTokens, 250);
  assert.equal(usage.totalTokens, 750);
});

test("sumConductorUsageFromMessages reads usage metadata from persisted messages", async () => {
  const { sumConductorUsageFromMessages } = await import("../../../src/loops/conductor-usage.js");

  const total = sumConductorUsageFromMessages([
    {
      role: "assistant",
      metadata: {
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          estimatedCostUsd: 0.0001,
        },
      },
    },
    {
      role: "assistant",
      metadata: {
        usage: {
          inputTokens: 200,
          outputTokens: 80,
          estimatedCostUsd: 0.0002,
        },
      },
    },
  ]);

  assert.equal(total.promptTokens, 300);
  assert.equal(total.completionTokens, 130);
  assert.equal(total.totalTokens, 430);
});

test("deriveConductorSessionUsage prefers latest assistant sessionUsage snapshot", async () => {
  const { deriveConductorSessionUsage } = await import("../../../src/loops/conductor-usage.js");

  const total = deriveConductorSessionUsage([
    {
      role: "assistant",
      metadata: {
        usage: { promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.0001 },
        sessionUsage: { promptTokens: 100, completionTokens: 50, estimatedCostUsd: 0.0001 },
      },
    },
    {
      role: "assistant",
      metadata: {
        usage: { promptTokens: 200, completionTokens: 80, estimatedCostUsd: 0.0002 },
        sessionUsage: { promptTokens: 300, completionTokens: 130, estimatedCostUsd: 0.0003 },
      },
    },
  ]);

  assert.equal(total.promptTokens, 300);
  assert.equal(total.completionTokens, 130);
  assert.equal(total.totalTokens, 430);
});

test("buildConductorSessionUsage tracks cumulative session totals", async () => {
  const { buildConductorSessionUsage } = await import("../../../src/loops/conductor-usage.js");

  const total = buildConductorSessionUsage(
    { promptTokens: 300, completionTokens: 130, totalTokens: 430, estimatedCostUsd: 0.0003 },
    { promptTokens: 50, completionTokens: 20, totalTokens: 70, estimatedCostUsd: 0.0001 },
  );

  assert.equal(total.promptTokens, 350);
  assert.equal(total.completionTokens, 150);
  assert.equal(total.totalTokens, 500);
});
