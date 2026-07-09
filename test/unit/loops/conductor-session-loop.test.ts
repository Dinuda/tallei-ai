import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyUiToolAnswerToMessages,
  CONDUCTOR_SESSION_MAX_AUTO_CONTINUATIONS,
  makePhaseHandoffConsumedEvent,
  mapContinuationIntentToStopReason,
  phaseHandoffConsumePayloadFromTurn,
  shouldAutoContinueConductorSession,
} from "../../../src/loops/conductor-session-loop.js";
import type { UIMessage } from "ai";

describe("conductor-session-loop", () => {
  it("shouldAutoContinueConductorSession allows phase handoff and ui_tool_answered", () => {
    assert.equal(shouldAutoContinueConductorSession({
      action: "auto_continue",
      reason: "phase_handoff_pending",
      trigger: "phase_handoff",
      handoffId: "h1",
    }), true);
    assert.equal(shouldAutoContinueConductorSession({
      action: "auto_continue",
      reason: "ui_tool_answered",
      trigger: "ui_tool_answered",
    }), true);
    assert.equal(shouldAutoContinueConductorSession({
      action: "wait_for_user",
      reason: "pending_user_input",
      trigger: null,
    }), false);
    assert.equal(shouldAutoContinueConductorSession({
      action: "auto_continue",
      reason: "required_tool_not_called",
      trigger: "phase_handoff",
    }), false);
  });

  it("mapContinuationIntentToStopReason covers wait and blocked", () => {
    assert.equal(mapContinuationIntentToStopReason({
      action: "wait_for_user",
      reason: "pending_user_input",
      trigger: null,
    }), "wait_for_user");
    assert.equal(mapContinuationIntentToStopReason({
      action: "wait",
      reason: "required_tool_not_called",
      trigger: null,
    }), "blocked");
    assert.equal(mapContinuationIntentToStopReason({
      action: "wait",
      reason: "budget_exhausted",
      trigger: "budget_exhausted",
    }), "budget_exhausted");
  });

  it("phaseHandoffConsumePayloadFromTurn requires full turn payload", () => {
    assert.deepEqual(phaseHandoffConsumePayloadFromTurn({
      action: "auto_continue",
      reason: "phase_handoff_pending",
      trigger: "phase_handoff",
      handoffId: "h1",
    }, {
      phase: "intent",
      parentArtifactHash: "root",
      stepsUsed: 1,
      stepLimit: 8,
      outcome: "phase_complete",
      continuation: "next_phase",
      nextPhase: "blueprint",
      handoffId: "h1",
    }), {
      handoffId: "h1",
      phase: "intent",
      nextPhase: "blueprint",
      parentArtifactHash: "root",
    });
    assert.equal(phaseHandoffConsumePayloadFromTurn({
      action: "auto_continue",
      reason: "handoff_pending",
      trigger: "phase_handoff",
    }, null), null);
  });

  it("makePhaseHandoffConsumedEvent is idempotent by handoffId", () => {
    const event = makePhaseHandoffConsumedEvent({
      handoffId: "h1",
      phase: "intent",
      nextPhase: "blueprint",
      parentArtifactHash: "root",
    });
    assert.equal(event.eventKey, "phase-handoff-consumed:h1");
    assert.equal(event.type, "phase_handoff.consumed");
  });

  it("applyUiToolAnswerToMessages patches output and truncates after tool message", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [{
          type: "tool-askQuestion",
          toolCallId: "q1",
          state: "input-available",
          input: { questionId: "x", question: "Q?", options: [] },
        }],
      },
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "trailing" }],
      },
    ] as UIMessage[];

    const patched = applyUiToolAnswerToMessages(messages, "q1", {
      questionId: "x",
      answerText: "Yes",
      selectedOptionIds: ["yes"],
      selectedValues: ["yes"],
    });
    assert.equal(patched.length, 1);
    const part = patched[0]!.parts![0] as { state?: string; output?: { answerText?: string } };
    assert.equal(part.state, "output-available");
    assert.equal(part.output?.answerText, "Yes");
  });

  it("caps auto-continuations", () => {
    assert.ok(CONDUCTOR_SESSION_MAX_AUTO_CONTINUATIONS >= 8);
  });
});
