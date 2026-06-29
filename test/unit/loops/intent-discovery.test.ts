import assert from "node:assert/strict";
import test from "node:test";

import {
  intentAnalysisSchema,
  unresolvedIntentQuestions,
} from "../../../src/loops/intent-discovery.js";

function analysis() {
  return intentAnalysisSchema.parse({
    normalizedOutcome: "Draft replies for urgent support email",
    triggerOrCadence: "When a support email arrives",
    requiredActions: ["Read email", "Classify urgency", "Draft reply"],
    destinations: ["Support inbox"],
    successCriteria: ["Urgent messages are identified"],
    approvalAndSafety: ["Do not send without approval"],
    assumptions: [],
    decisions: [],
    questions: [
      {
        id: "success-threshold",
        question: "What counts as urgent?",
        reason: "Changes classification behavior",
        priority: "success",
        options: [
          { id: "strict", label: "Strict", value: "strict" },
          { id: "broad", label: "Broad", value: "broad" },
        ],
        recommendedOptionId: "strict",
      },
      {
        id: "send-policy",
        question: "Should replies be drafted or sent?",
        reason: "Changes external-write safety",
        priority: "safety",
        options: [
          { id: "draft", label: "Draft", value: "draft" },
          { id: "send", label: "Send", value: "send" },
        ],
        recommendedOptionId: "draft",
      },
    ],
  });
}

test("intent discovery permits zero questions for complete intent", () => {
  const complete = analysis();
  complete.questions = [];
  assert.deepEqual(unresolvedIntentQuestions(complete), []);
});

test("intent discovery prioritizes safety and suppresses asked questions", () => {
  const value = analysis();
  assert.equal(unresolvedIntentQuestions(value)[0]?.id, "send-policy");
  const remaining = unresolvedIntentQuestions(value, {
    status: "needs_input",
    decisions: [],
    assumptions: [],
    askedQuestionIds: ["send-policy"],
  });
  assert.deepEqual(remaining.map((question) => question.id), ["success-threshold"]);
});
