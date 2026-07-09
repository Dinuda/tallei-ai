import assert from "node:assert/strict";
import test from "node:test";

import { createBuildState } from "../../../src/loops/build-state.js";
import {
  buildNoProgressFingerprint,
  resolveConductorTurnResolution,
} from "../../../src/loops/conductor-turn-resolution.js";

function baseResolutionInput(overrides: Record<string, unknown> = {}) {
  return {
    contract: {
      phase: "intent" as const,
      parentArtifactHash: "root",
      allowedTools: ["analyzeIntent", "askQuestion"] as const,
      nextTool: "analyzeIntent",
      compiledPlanId: null,
      revision: "intent:root",
    },
    currentState: createBuildState(),
    phaseProgress: {
      phase: "intent" as const,
      status: "pending" as const,
      goal: "Capture intent",
      completionCriteria: ["Intent recorded"],
      nextTool: "analyzeIntent" as const,
      allowedTools: ["analyzeIntent"] as const,
      maxSteps: 6,
      autoAdvance: true,
      instruction: "Call analyzeIntent",
      handoffPending: false,
      terminal: false,
    },
    latestPhaseTurn: null,
    pendingUiTool: null,
    loopStatus: "draft",
    stepsUsed: 0,
    stepLimit: 6,
    ...overrides,
  };
}

test("pending UI input overrides a preceding non-terminal tool result", () => {
  const resolution = resolveConductorTurnResolution({
    contract: {
      phase: "intent",
      parentArtifactHash: "root",
      allowedTools: ["analyzeIntent", "askQuestion"],
      nextTool: "analyzeIntent",
      compiledPlanId: null,
      revision: "intent:root",
    },
    currentState: createBuildState(),
    phaseProgress: {
      phase: "intent",
      status: "in_progress",
      goal: "Capture intent",
      completionCriteria: ["Questions answered"],
      nextTool: "askQuestion",
      allowedTools: ["askQuestion"],
      maxSteps: 6,
      autoAdvance: true,
      instruction: "Wait for the answer",
      handoffPending: false,
      terminal: false,
      pendingUiTool: {
        toolCallId: "question-1",
        toolName: "askQuestion",
        input: { questionId: "review-policy" },
      },
    },
    latestPhaseTurn: null,
    pendingUiTool: {
      toolCallId: "question-1",
      toolName: "askQuestion",
      input: { questionId: "review-policy" },
    },
    loopStatus: "draft",
    stepsUsed: 1,
    stepLimit: 6,
  });

  assert.deepEqual(resolution, {
    outcome: "waiting_for_user",
    continuation: "wait_for_user",
    reason: "pending_user_input",
    pendingToolCallId: "question-1",
    resumeAfterAnswer: true,
  });
});

test("resolveConductorTurnResolution blocks zero-tool turns that skip the required tool", () => {
  const resolution = resolveConductorTurnResolution(baseResolutionInput());
  assert.equal(resolution?.outcome, "blocked");
  assert.equal(resolution?.continuation, "stop");
  assert.equal(resolution?.reason, "required_tool_not_called");
});

test("resolveConductorTurnResolution continues same phase after a real tool step", () => {
  const resolution = resolveConductorTurnResolution(baseResolutionInput({
    stepsUsed: 1,
    phaseProgress: {
      phase: "intent",
      status: "in_progress",
      goal: "Capture intent",
      completionCriteria: ["Questions answered"],
      nextTool: "askQuestion",
      allowedTools: ["askQuestion"],
      maxSteps: 6,
      autoAdvance: true,
      instruction: "Ask remaining question",
      handoffPending: false,
      terminal: false,
    },
  }));

  assert.equal(resolution?.outcome, "progress");
  assert.equal(resolution?.continuation, "continue_phase");
});

test("resolveConductorTurnResolution blocks repeated no-progress on the same fingerprint", () => {
  const base = baseResolutionInput();
  const fingerprint = buildNoProgressFingerprint({
    contract: base.contract,
    phaseProgress: base.phaseProgress,
  });

  const repeated = resolveConductorTurnResolution(baseResolutionInput({
    stepsUsed: 0,
    latestPhaseTurn: {
      phase: "intent",
      parentArtifactHash: "root",
      stepsUsed: 1,
      stepLimit: 6,
      outcome: "progress",
      continuation: "continue_phase",
      noProgressFingerprint: fingerprint,
    },
  }));
  assert.equal(repeated?.outcome, "blocked");
  assert.equal(repeated?.reason, "repeated_no_progress");
});
