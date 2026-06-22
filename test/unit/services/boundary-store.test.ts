import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { projectOutputWithBoundary } from "../../../src/services/loop-runtime/boundary-store.js";
import {
  projectStepOutputFromBoundary,
  RUNNER_BOUNDARY_PROTOCOL_VERSION,
  type AgentBoundaryEnvelope,
} from "../../../src/services/loop-runtime/runner-boundary.js";

const dbIndexPath = new URL("../../../src/infrastructure/db/index.ts", import.meta.url);

function envelope(): AgentBoundaryEnvelope {
  return {
    protocolVersion: RUNNER_BOUNDARY_PROTOCOL_VERSION,
    rawOutput: { text: "raw" },
    structuredOutput: { status: "done", summary: "Structured summary" },
    normalizedOutput: { status: "done", summary: "Normalized summary" },
    normalizedHandoff: { ready: true, summary: "Ready" },
    goalEval: {
      status: "pass",
      reason: "Output satisfies the contract.",
      blockers: [],
      normalizedOutput: { status: "done", summary: "Normalized summary" },
      normalizedHandoff: { ready: true, summary: "Ready" },
    },
  };
}

test("projectStepOutputFromBoundary keeps step_attempts compatibility projection", () => {
  const projected = projectStepOutputFromBoundary({ envelope: envelope(), text: "Visible output" });

  assert.equal(projected.text, "Visible output");
  assert.deepEqual(projected.data, {
    structuredOutput: { status: "done", summary: "Structured summary" },
    data: { status: "done", summary: "Structured summary" },
    normalizedOutput: { status: "done", summary: "Normalized summary" },
    normalizedHandoff: { ready: true, summary: "Ready" },
    goalEval: envelope().goalEval,
    boundaryEnvelope: envelope(),
  });
});

test("projectOutputWithBoundary derives projection without boundary legacy output", () => {
  const projected = projectOutputWithBoundary({
    outputJson: { text: "Existing visible text" },
    boundary: {
      protocol_version: RUNNER_BOUNDARY_PROTOCOL_VERSION,
      raw_output_json: envelope().rawOutput,
      structured_output_json: envelope().structuredOutput,
      normalized_output_json: envelope().normalizedOutput,
      normalized_handoff_json: envelope().normalizedHandoff,
      goal_eval_json: envelope().goalEval,
      router_decision: "continue",
    },
  }) as Record<string, unknown>;

  assert.equal(projected.text, "Existing visible text");
  assert.deepEqual(projected.normalizedHandoff, { ready: true, summary: "Ready" });
});

test("boot migration drops legacy_output_json from loop_engine_boundaries", async () => {
  const source = await readFile(dbIndexPath, "utf8");

  assert.match(source, /DROP COLUMN IF EXISTS legacy_output_json/);
  assert.doesNotMatch(source, /legacy_output_json JSONB NOT NULL DEFAULT/);
});
