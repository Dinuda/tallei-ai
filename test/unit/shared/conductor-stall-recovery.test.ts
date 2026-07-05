import assert from "node:assert/strict";
import test from "node:test";

import {
  isBuildTerminalForStall,
  isPhaseOpenForStallRecovery,
  isPhaseProgressTerminal,
} from "../../../shared/conductor-stall-recovery.js";

test("isPhaseProgressTerminal is true when terminal or status complete", () => {
  assert.equal(isPhaseProgressTerminal({ terminal: true, status: "in_progress" }), true);
  assert.equal(isPhaseProgressTerminal({ status: "complete" }), true);
  assert.equal(isPhaseProgressTerminal({ terminal: false, status: "in_progress" }), false);
  assert.equal(isPhaseProgressTerminal(null), false);
});

test("isBuildTerminalForStall respects loop status and activation_complete", () => {
  assert.equal(isBuildTerminalForStall({ loopStatus: "active" }), true);
  assert.equal(isBuildTerminalForStall({
    loopStatus: "draft",
    phaseProgress: { reason: "activation_complete", terminal: true, status: "complete" },
  }), true);
  assert.equal(isBuildTerminalForStall({
    loopStatus: "draft",
    phaseProgress: { terminal: false, status: "in_progress" },
  }), false);
});

test("isBuildTerminalForStall treats activation_phase_inactive as terminal", () => {
  assert.equal(isBuildTerminalForStall({
    loopStatus: "draft",
    phaseProgress: {
      phase: "activation",
      status: "complete",
      terminal: true,
      reason: "activation_phase_inactive",
    },
  }), true);
});

test("isPhaseOpenForStallRecovery distinguishes open, closed, and unknown", () => {
  assert.equal(isPhaseOpenForStallRecovery({
    terminal: false,
    status: "in_progress",
  }), true);
  assert.equal(isPhaseOpenForStallRecovery({
    terminal: true,
    status: "complete",
    reason: "activation_complete",
  }), false);
  assert.equal(isPhaseOpenForStallRecovery(null), null);
  assert.equal(isPhaseOpenForStallRecovery({
    status: "pending",
    terminal: false,
  }), true);
});
