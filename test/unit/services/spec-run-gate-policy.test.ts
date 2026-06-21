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

test("configuredAgentGateRequired skips draft and pre_send gates for automatic runs", () => {
  assert.equal(configuredAgentGateRequired("draft_review", null), false);
  assert.equal(configuredAgentGateRequired("draft_review", "draft_only"), false);
  assert.equal(configuredAgentGateRequired("pre_send", "draft_only"), false);
  assert.equal(configuredAgentGateRequired("pre_send", "approve_batch"), false);
  assert.equal(configuredAgentGateRequired("missing_input", "draft_only"), true);
});

test("configuredAgentGateRequired honors review policy when operator review is enabled", () => {
  assert.equal(configuredAgentGateRequired("draft_review", "approve_each_action"), true);
  assert.equal(configuredAgentGateRequired("pre_send", "approve_each_action"), true);
  assert.equal(configuredAgentGateRequired("draft_review", "approve_batch"), true);
});
