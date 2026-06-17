import test from "node:test";
import assert from "node:assert/strict";

import {
  loopRunWorkflowId,
  loopScheduleId,
  parseLoopRunWorkflowId,
  parseLoopScheduleId,
  tenantLoopRunSearchQuery,
  tenantLoopScheduleSearchQuery,
} from "../../../src/temporal/ids.js";

test("loop run workflow ids are tenant-scoped and reversible", () => {
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const workflowId = "22222222-2222-2222-2222-222222222222";
  const runId = "33333333-3333-3333-3333-333333333333";
  const temporalId = loopRunWorkflowId(tenantId, workflowId, runId);
  assert.equal(temporalId, `loop-run:${tenantId}:${workflowId}:${runId}`);
  assert.deepEqual(parseLoopRunWorkflowId(temporalId), { tenantId, workflowId, runId });
  assert.equal(tenantLoopRunSearchQuery(tenantId), `loop-run:${tenantId}:`);
});

test("loop schedule ids are tenant-scoped and reversible", () => {
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const workflowId = "22222222-2222-2222-2222-222222222222";
  const scheduleId = loopScheduleId(tenantId, workflowId);
  assert.equal(scheduleId, `loop-schedule:${tenantId}:${workflowId}`);
  assert.deepEqual(parseLoopScheduleId(scheduleId), { tenantId, workflowId });
  assert.equal(tenantLoopScheduleSearchQuery(tenantId), `loop-schedule:${tenantId}:`);
});

test("parse helpers reject malformed ids", () => {
  assert.equal(parseLoopRunWorkflowId("bad-id"), null);
  assert.equal(parseLoopScheduleId("loop-run:tenant:workflow:run"), null);
});
