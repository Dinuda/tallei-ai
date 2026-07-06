import assert from "node:assert/strict";
import test from "node:test";

import { createBuildState } from "../../../src/loops/build-state.js";
import { resolveConductorTurnResolution } from "../../../src/loops/conductor-turn-resolution.js";

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
