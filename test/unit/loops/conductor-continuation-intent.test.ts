import assert from "node:assert/strict";
import test from "node:test";

import { createBuildState } from "../../../src/loops/build-state.js";
import { projectConductorClientAction } from "../../../src/loops/conductor-continuation-intent.js";
import type { LoopBuildEvent } from "../../../src/loops/build-events.js";

function baseProgress(overrides: Record<string, unknown> = {}) {
  return {
    phase: "activation",
    status: "in_progress",
    goal: "Activate",
    completionCriteria: [],
    nextTool: "presentReplyOptions",
    allowedTools: ["presentReplyOptions", "activateLoop"],
    maxSteps: 8,
    autoAdvance: true,
    instruction: "Confirm activation",
    handoffPending: false,
    terminal: false,
    ...overrides,
  };
}

test("projectConductorClientAction waits when loop is active", () => {
  const intent = projectConductorClientAction({
    loopStatus: "active",
    phaseProgress: baseProgress({ terminal: true, status: "complete", reason: "activation_complete" }),
    latestPhaseTurn: { phase: "activation", parentArtifactHash: "root", stepsUsed: 1, stepLimit: 8, outcome: "build_complete", continuation: "stop" },
    pendingUiTool: null,
    consumedHandoffIds: [],
    events: [],
  });
  assert.equal(intent.action, "wait");
  assert.equal(intent.reason, "build_terminal");
});

test("projectConductorClientAction waits for unanswered UI tool", () => {
  const intent = projectConductorClientAction({
    loopStatus: "draft",
    phaseProgress: baseProgress(),
    latestPhaseTurn: null,
    pendingUiTool: {
      toolCallId: "reply-1",
      toolName: "presentReplyOptions",
      input: { options: [] },
    },
    consumedHandoffIds: [],
    events: [],
  });
  assert.equal(intent.action, "wait_for_user");
});

test("projectConductorClientAction waits when latest phase turn is blocked", () => {
  const intent = projectConductorClientAction({
    loopStatus: "draft",
    phaseProgress: baseProgress({ phase: "intent", nextTool: "analyzeIntent" }),
    latestPhaseTurn: {
      phase: "intent",
      parentArtifactHash: "root",
      stepsUsed: 0,
      stepLimit: 6,
      outcome: "blocked",
      continuation: "stop",
      resolutionReason: "required_tool_not_called",
    },
    pendingUiTool: null,
    consumedHandoffIds: [],
    events: [],
  });
  assert.equal(intent.action, "wait");
  assert.equal(intent.reason, "required_tool_not_called");
});

test("projectConductorClientAction does not auto-continue zero-step continue_phase handoffs", () => {
  const intent = projectConductorClientAction({
    loopStatus: "draft",
    phaseProgress: baseProgress({ phase: "intent", nextTool: "analyzeIntent" }),
    latestPhaseTurn: {
      phase: "intent",
      parentArtifactHash: "root",
      stepsUsed: 0,
      stepLimit: 6,
      outcome: "progress",
      continuation: "continue_phase",
      handoffId: "stale-handoff",
    },
    pendingUiTool: null,
    consumedHandoffIds: [],
    events: [],
  });
  assert.equal(intent.action, "wait");
});

test("projectConductorClientAction auto-continues pending phase handoff", () => {
  const intent = projectConductorClientAction({
    loopStatus: "draft",
    phaseProgress: baseProgress({ phase: "test", nextTool: "testRunLoop" }),
    latestPhaseTurn: {
      phase: "compile",
      parentArtifactHash: "review-hash",
      stepsUsed: 1,
      stepLimit: 8,
      outcome: "phase_complete",
      continuation: "next_phase",
      nextPhase: "test",
      handoffId: "compile-to-test",
    },
    pendingUiTool: null,
    consumedHandoffIds: [],
    events: [],
  });
  assert.equal(intent.action, "auto_continue");
  assert.equal(intent.trigger, "phase_handoff");
  assert.equal(intent.handoffId, "compile-to-test");
});

test("projectConductorClientAction waits when phase handoff was consumed", () => {
  const intent = projectConductorClientAction({
    loopStatus: "draft",
    phaseProgress: baseProgress({ phase: "test", nextTool: "testRunLoop" }),
    latestPhaseTurn: {
      phase: "compile",
      parentArtifactHash: "review-hash",
      stepsUsed: 1,
      stepLimit: 8,
      outcome: "phase_complete",
      continuation: "next_phase",
      nextPhase: "test",
      handoffId: "compile-to-test",
    },
    pendingUiTool: null,
    consumedHandoffIds: ["compile-to-test"],
    events: [],
  });
  assert.equal(intent.action, "wait");
});

test("projectConductorClientAction auto-continues after activation confirmation", () => {
  const events = [
    {
      eventKey: "tool:reply-1:completed",
      type: "tool_call.completed",
      toolCallId: "reply-1",
      payload: {
        toolName: "presentReplyOptions",
        input: {
          options: [{ id: "activate", label: "Yes", message: "Yes, turn it on!" }],
        },
        output: {
          selectedOptionId: "activate",
          message: "Yes, turn it on!",
        },
      },
    },
  ] satisfies LoopBuildEvent[];

  const intent = projectConductorClientAction({
    loopStatus: "draft",
    phaseProgress: baseProgress({
      nextTool: "activateLoop",
      allowedTools: ["activateLoop"],
      reason: "activation_confirmed",
    }),
    latestPhaseTurn: null,
    pendingUiTool: null,
    consumedHandoffIds: [],
    events,
  });
  assert.equal(intent.action, "auto_continue");
  assert.equal(intent.trigger, "ui_tool_answered");
});

test("projectConductorClientAction waits after successful activateLoop", () => {
  const state = createBuildState();
  state.buildPhase = "activation";
  const events = [
    {
      eventKey: "tool:reply-1:completed",
      type: "tool_call.completed",
      toolCallId: "reply-1",
      payload: {
        toolName: "presentReplyOptions",
        input: { options: [{ id: "activate", label: "Yes", message: "Yes" }] },
        output: { selectedOptionId: "activate", message: "Yes" },
      },
    },
    {
      eventKey: "tool:activate-1:completed",
      type: "tool_call.completed",
      toolCallId: "activate-1",
      payload: {
        toolName: "activateLoop",
        input: { confirmedByUser: true },
        output: { ok: true, turnOutcome: "build_complete" },
      },
    },
  ] satisfies LoopBuildEvent[];

  const intent = projectConductorClientAction({
    loopStatus: "active",
    phaseProgress: baseProgress({
      terminal: true,
      status: "complete",
      reason: "activation_complete",
      allowedTools: [],
    }),
    latestPhaseTurn: {
      phase: "activation",
      parentArtifactHash: "test-hash",
      stepsUsed: 1,
      stepLimit: 8,
      outcome: "build_complete",
      continuation: "stop",
    },
    pendingUiTool: null,
    consumedHandoffIds: [],
    events,
  });
  assert.equal(intent.action, "wait");
  assert.equal(intent.reason, "build_terminal");
});
