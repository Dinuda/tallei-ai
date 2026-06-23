import assert from "node:assert/strict";
import test from "node:test";

import { loopIntentAnalysisSchema } from "../../../src/services/conductor/contracts/intent-context.js";

test("intent analysis schema accepts normalized intent defaults", () => {
  const analysis = loopIntentAnalysisSchema.parse({
    normalizedIntent: {
      outcome: "Create a weekly newsletter.",
      toolCategories: [],
      cadence: "Weekly",
      approvalModel: "Operator approval before execution",
      runtimeInputs: [],
    },
    questions: [],
    assumptions: [],
    connectorFeasibility: [],
    analyzedAt: "2026-06-14T00:00:00.000Z",
  });
  assert.equal(analysis.normalizedIntent.cadence, "Weekly");
});
