import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBoundaryEnvelope,
  normalizedHandoffFromStepOutput,
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
