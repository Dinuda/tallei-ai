import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBoundaryEnvelope,
  normalizedHandoffFromStepOutput,
  routeBoundary,
  RUNNER_BOUNDARY_PROTOCOL_VERSION,
} from "../../../src/services/loop-runtime/runner-boundary.js";

test("normalizedHandoffFromStepOutput prefers boundary envelope handoff", () => {
  const envelope = buildBoundaryEnvelope({
    rawOutput: { summary: "Raw" },
    structuredOutput: { summary: "Structured" },
    normalizedOutput: { summary: "Normalized output" },
    normalizedHandoff: { summary: "Normalized handoff" },
    goalEval: { status: "pass", reason: "ok", blockers: [] },
  });

  assert.equal(envelope.protocolVersion, RUNNER_BOUNDARY_PROTOCOL_VERSION);
  assert.deepEqual(normalizedHandoffFromStepOutput(envelope), { summary: "Normalized handoff" });
});

test("normalizedHandoffFromStepOutput keeps legacy structured output compatibility", () => {
  const legacy = {
    data: {
      structuredOutput: { subject: "Launch", body: "Shipped." },
      data: { subject: "Launch", body: "Shipped." },
    },
    text: "Shipped.",
  };

  assert.deepEqual(normalizedHandoffFromStepOutput(legacy), { subject: "Launch", body: "Shipped." });
});

test("routeBoundary maps evaluator status and no-action output deterministically", () => {
  assert.equal(routeBoundary({
    goalEval: { status: "pass", reason: "ok", blockers: [] },
    normalizedOutput: { status: "ready" },
  }), "continue");
  assert.equal(routeBoundary({
    goalEval: { status: "pass", reason: "ok", blockers: [] },
    normalizedOutput: { status: "no_action_required" },
  }), "finish_no_action");
  assert.equal(routeBoundary({
    goalEval: { status: "needs_input", reason: "missing", blockers: [] },
    normalizedOutput: {},
  }), "pause_for_input");
  assert.equal(routeBoundary({
    goalEval: { status: "retry", reason: "malformed", blockers: [] },
    normalizedOutput: {},
  }), "retry_step");
  assert.equal(routeBoundary({
    goalEval: { status: "fail", reason: "wrong output", blockers: [] },
    normalizedOutput: {},
  }), "fail_run");
});
