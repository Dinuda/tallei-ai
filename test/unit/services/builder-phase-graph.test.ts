import assert from "node:assert/strict";
import test from "node:test";

import {
  canAdvancePhase,
  canRegressPhase,
  downstreamPhases,
  phaseOrder,
} from "../../../src/services/conductor/builder/phases/graph.js";

test("canAdvancePhase follows forward edges only", () => {
  assert.equal(canAdvancePhase("discovery", "requirements"), true);
  assert.equal(canAdvancePhase("requirements", "discovery"), false);
  assert.equal(canAdvancePhase("compile", "verification"), true);
});

test("canRegressPhase allows transitive backward moves", () => {
  assert.equal(canRegressPhase("verification", "compile"), true);
  assert.equal(canRegressPhase("compile", "discovery"), true);
  assert.equal(canRegressPhase("discovery", "requirements"), false);
  assert.equal(canRegressPhase("requirements", "requirements"), false);
});

test("downstreamPhases returns later phases only", () => {
  assert.deepEqual(downstreamPhases("requirements"), ["compile", "verification"]);
  assert.deepEqual(downstreamPhases("verification"), []);
  assert.deepEqual(phaseOrder(), ["discovery", "requirements", "compile", "verification"]);
});
