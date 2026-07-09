import assert from "node:assert/strict";
import test from "node:test";

import {
  CONDUCTOR_BUDGET_EXHAUSTED_QUESTION,
  CONDUCTOR_CONTINUE_SUGGESTIONS,
  CONDUCTOR_STALL_QUESTION,
  conductorStepLimitForPhase,
  evaluateConductorStall,
  isActionableConductorPhase,
  isBuildIncomplete,
  isRecoverableConductorExecution,
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

test("isActionableConductorPhase excludes blueprint waiting phase", () => {
  assert.equal(isActionableConductorPhase("bindings"), true);
  assert.equal(isActionableConductorPhase("blueprint"), false);
  assert.equal(isActionableConductorPhase(null), false);
});

test("evaluateConductorStall detects text-only mid-phase endings", () => {
  const stall = evaluateConductorStall({
    chatBusy: false,
    hasMessages: true,
    actionablePhase: true,
    hasUnansweredUiTools: false,
    buildIncomplete: true,
    lastRoleIsAssistant: true,
    hasTerminalExecution: false,
    textOnlyEnding: true,
    hasExecutions: false,
    wouldAutoContinue: false,
    hasAssistantParts: true,
  });

  assert.equal(stall.stalled, true);
  assert.equal(stall.reason, "text_only_mid_phase");
});

test("evaluateConductorStall ignores stalls while chat is busy", () => {
  assert.equal(evaluateConductorStall({
    chatBusy: true,
    hasMessages: true,
    actionablePhase: true,
    hasUnansweredUiTools: false,
    buildIncomplete: true,
    lastRoleIsAssistant: true,
    hasTerminalExecution: false,
    textOnlyEnding: true,
    hasExecutions: false,
    wouldAutoContinue: false,
    hasAssistantParts: true,
  }).stalled, false);
});

test("evaluateConductorStall does not stall when non-terminal tools would auto-continue", () => {
  assert.equal(evaluateConductorStall({
    chatBusy: false,
    hasMessages: true,
    actionablePhase: true,
    hasUnansweredUiTools: false,
    buildIncomplete: true,
    lastRoleIsAssistant: true,
    hasTerminalExecution: false,
    textOnlyEnding: false,
    hasExecutions: true,
    wouldAutoContinue: true,
    hasAssistantParts: true,
  }).stalled, false);
});

test("evaluateConductorStall does not stall text-only endings when phase handoff is pending", () => {
  assert.equal(evaluateConductorStall({
    chatBusy: false,
    hasMessages: true,
    actionablePhase: true,
    hasUnansweredUiTools: false,
    buildIncomplete: true,
    lastRoleIsAssistant: true,
    hasTerminalExecution: false,
    textOnlyEnding: true,
    hasExecutions: false,
    wouldAutoContinue: false,
    hasAssistantParts: true,
    phaseHandoffPending: true,
  }).stalled, false);
});

test("evaluateConductorStall does not stall text-only endings when review confirmation is pending", () => {
  assert.equal(evaluateConductorStall({
    chatBusy: false,
    hasMessages: true,
    actionablePhase: true,
    hasUnansweredUiTools: false,
    buildIncomplete: true,
    lastRoleIsAssistant: true,
    hasTerminalExecution: false,
    textOnlyEnding: true,
    hasExecutions: false,
    wouldAutoContinue: false,
    hasAssistantParts: true,
    reviewConfirmationHandoffPending: true,
  }).stalled, false);
});

test("evaluateConductorStall does not stall when a UI-only tool was answered and awaits continue", () => {
  assert.equal(evaluateConductorStall({
    chatBusy: false,
    hasMessages: true,
    actionablePhase: true,
    hasUnansweredUiTools: false,
    buildIncomplete: true,
    lastRoleIsAssistant: true,
    hasTerminalExecution: false,
    textOnlyEnding: false,
    hasExecutions: false,
    wouldAutoContinue: false,
    hasAssistantParts: true,
    answeredUiToolAwaitingContinue: true,
  }).stalled, false);
});

test("continue suggestion constants are stable", () => {
  assert.deepEqual(
    CONDUCTOR_CONTINUE_SUGGESTIONS.map((suggestion) => suggestion.id),
    ["continue", "okay"],
  );
  assert.match(CONDUCTOR_STALL_QUESTION, /Continue when you're ready/i);
});

test("isBuildIncomplete treats active loops as complete", () => {
  assert.equal(isBuildIncomplete("activation", [], "active"), false);
  assert.equal(isBuildIncomplete("bindings", ["trigger"], "draft"), true);
});

test("isRecoverableConductorExecution detects phase redirect metadata", () => {
  assert.equal(isRecoverableConductorExecution({
    ok: false,
    retryAllowed: true,
    recoverToPhase: "review",
  }), true);
  assert.equal(isRecoverableConductorExecution({
    ok: false,
    retryAllowed: false,
    recoverToPhase: "review",
  }), false);
});

test("evaluateConductorStall does not stall after budget exhaustion", () => {
  const result = evaluateConductorStall({
    chatBusy: false,
    hasMessages: true,
    actionablePhase: true,
    hasUnansweredUiTools: false,
    buildIncomplete: true,
    lastRoleIsAssistant: true,
    hasTerminalExecution: false,
    textOnlyEnding: true,
    wouldAutoContinue: false,
    hasExecutions: false,
    hasAssistantParts: true,
    budgetExhausted: true,
  });
  assert.equal(result.stalled, false);
  assert.match(CONDUCTOR_BUDGET_EXHAUSTED_QUESTION, /step budget/i);
});
