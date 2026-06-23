import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredAgentGateRequired,
} from "../../../src/services/conductor/runtime/spec-run-gate-policy.js";

test("configuredAgentGateRequired only honors canonical active gate types", () => {
  assert.equal(configuredAgentGateRequired("input"), true);
  assert.equal(configuredAgentGateRequired("approval"), true);
  assert.equal(configuredAgentGateRequired("draft_review"), false);
  assert.equal(configuredAgentGateRequired("preview_review"), false);
  assert.equal(configuredAgentGateRequired("pre_send"), false);
  assert.equal(configuredAgentGateRequired("source_confirmation"), false);
  assert.equal(configuredAgentGateRequired("memory_confirmation"), false);
  assert.equal(configuredAgentGateRequired("missing_input"), false);
  assert.equal(configuredAgentGateRequired("none"), false);
});
