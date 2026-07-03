import assert from "node:assert/strict";
import test from "node:test";

import { buildIntentAnalysisSpecPatch } from "../../../src/loops/intent-analysis.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("buildIntentAnalysisSpecPatch persists canonical approval from analyzeIntent", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const executionOrder = [
    { role: "trigger", description: "When a new support ticket arrives" },
    { role: "transform", description: "Draft personalized replies" },
    { role: "destination", description: "Send replies after review" },
  ] as const;
  const result = buildIntentAnalysisSpecPatch(spec, {
    outcome: "Send personalized replies to incoming support tickets",
    trigger: "When a new support ticket arrives",
    executionOrder: [...executionOrder],
    approval: {
      mode: "mixed",
      sensitiveRoles: ["destination"],
      sensitiveCapabilities: [],
    },
    decisions: [{
      questionId: "approval-mode",
      question: "Should replies send automatically or wait for your review?",
      answer: "Review first",
    }],
  });

  assert.equal(result.patch.approval?.mode, "mixed");
  assert.deepEqual(result.patch.approval?.sensitiveRoles, ["destination"]);
  assert.deepEqual(result.patch.approval?.sensitiveCapabilities, []);
  assert.deepEqual(result.patch.intentDiscovery?.analysis?.executionOrder, [...executionOrder]);
});

test("buildIntentAnalysisSpecPatch preserves existing approval when analyzeIntent omits it", () => {
  const spec = createEmptyLoopSpec(workspaceId, {
    approval: {
      mode: "ask",
      sensitiveRoles: [],
      sensitiveCapabilities: [],
      defaultTimeoutHours: 24,
      onTimeout: "reject",
    },
  });
  const result = buildIntentAnalysisSpecPatch(spec, {
    outcome: "Draft personalized replies to incoming support tickets",
    trigger: "When a new support ticket arrives",
    decisions: [],
  });

  assert.equal(result.patch.approval, undefined);
  assert.equal(result.patch.intentDiscovery?.status, "ready");
});
