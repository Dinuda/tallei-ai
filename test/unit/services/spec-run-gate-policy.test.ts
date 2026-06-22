import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredAgentGateRequired,
  operatorReviewRequired,
} from "../../../src/services/loop-runtime/spec-run-gate-policy.js";

test("operatorReviewRequired is false for draft_only and null", () => {
  assert.equal(operatorReviewRequired(null), false);
  assert.equal(operatorReviewRequired("draft_only"), false);
  assert.equal(operatorReviewRequired("approve_each_action"), true);
  assert.equal(operatorReviewRequired("approve_batch"), true);
});

test("configuredAgentGateRequired honors spec-defined gates", () => {
  assert.equal(configuredAgentGateRequired("draft_review"), true);
  assert.equal(configuredAgentGateRequired("preview_review"), true);
  assert.equal(configuredAgentGateRequired("pre_send"), true);
  assert.equal(configuredAgentGateRequired("source_confirmation"), true);
  assert.equal(configuredAgentGateRequired("memory_confirmation"), true);
  assert.equal(configuredAgentGateRequired("missing_input"), true);
  assert.equal(configuredAgentGateRequired("none"), false);
});
