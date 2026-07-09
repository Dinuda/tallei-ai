import assert from "node:assert/strict";
import test from "node:test";

import {
  CONDUCTOR_BUDGET_EXHAUSTED_QUESTION,
  conductorStepLimitForPhase,
} from "@tallei/shared/conductor-turn-budget.js";

test("conductorStepLimitForPhase raises bindings budget above legacy cap", () => {
  assert.equal(conductorStepLimitForPhase("bindings"), 12);
  assert.equal(conductorStepLimitForPhase("intent"), 6);
  assert.equal(conductorStepLimitForPhase("connectors"), 8);
  assert.equal(conductorStepLimitForPhase("compile"), 8);
  assert.equal(conductorStepLimitForPhase("blueprint"), 4);
});

test("bindings phase budget fits multi-tool binding flow", () => {
  const steps = [
    "listTriggers",
    "discoverBindings",
    "resolveBindings",
    "askQuestion",
    "resolveBindings",
  ];
  assert.ok(steps.length <= conductorStepLimitForPhase("bindings"));
});

test("CONDUCTOR_BUDGET_EXHAUSTED_QUESTION mentions step budget", () => {
  assert.match(CONDUCTOR_BUDGET_EXHAUSTED_QUESTION, /step budget/i);
});
