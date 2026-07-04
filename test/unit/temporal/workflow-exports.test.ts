import assert from "node:assert/strict";
import test from "node:test";

import { loopRunWorkflow, specRunWorkflowV1 } from "../../../src/temporal/workflows/index.js";

test("keeps the legacy Temporal workflow type replayable", () => {
  assert.equal(specRunWorkflowV1, loopRunWorkflow);
});
