import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveConfirmOutcomeBriefActionFromSelection,
} from "@tallei/shared/confirm-outcome-brief-action.js";
import { confirmOutcomeBriefInputSchema } from "../../../src/loops/conductor-tools.js";

test("confirmOutcomeBriefInputSchema requires action tokens on option id and value", () => {
  assert.throws(() => confirmOutcomeBriefInputSchema.parse({
    briefHash: "a".repeat(64),
    question: "Ready to build this?",
    options: [
      { id: "confirm", label: "This is good", value: "This is good" },
      { id: "other", label: "Change something", value: "other" },
    ],
  }));
});

test("resolveConfirmOutcomeBriefActionFromSelection uses selected option id before label text", () => {
  assert.equal(
    resolveConfirmOutcomeBriefActionFromSelection({
      selectedOptionIds: ["confirm"],
      selectedValues: ["This is good"],
      options: [
        { id: "confirm", value: "This is good" },
        { id: "other", value: "other" },
      ],
    }),
    "confirm",
  );
});

test("resolveConfirmOutcomeBriefActionFromSelection falls back to option value token", () => {
  assert.equal(
    resolveConfirmOutcomeBriefActionFromSelection({
      selectedOptionIds: ["approve"],
      selectedValues: ["confirm"],
      options: [
        { id: "approve", value: "confirm" },
        { id: "other", value: "other" },
      ],
    }),
    "confirm",
  );
});

test("resolveConfirmOutcomeBriefActionFromSelection returns other when no action token matches", () => {
  assert.equal(
    resolveConfirmOutcomeBriefActionFromSelection({
      selectedOptionIds: ["approve"],
      selectedValues: ["This is good"],
      options: [
        { id: "approve", value: "This is good" },
        { id: "reject", value: "Change something" },
      ],
    }),
    "other",
  );
});
