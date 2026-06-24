import assert from "node:assert/strict";
import test from "node:test";

import { buildMonitorAlertMessage, evaluateMonitorRule } from "../../../src/loops/monitor.js";

test("evaluateMonitorRule gt numeric", () => {
  assert.equal(
    evaluateMonitorRule({ cpu: 90 }, { op: "gt", field: "cpu", value: 85 }),
    true,
  );
  assert.equal(
    evaluateMonitorRule({ cpu: 80 }, { op: "gt", field: "cpu", value: 85 }),
    false,
  );
});

test("evaluateMonitorRule eq string", () => {
  assert.equal(
    evaluateMonitorRule({ status: "error" }, { op: "eq", field: "status", value: "error" }),
    true,
  );
});

test("buildMonitorAlertMessage includes breach state", () => {
  const message = buildMonitorAlertMessage(
    { source: "cpu", rule: { op: "gt", field: "cpu", value: 85 }, cooldownMinutes: 15 },
    { cpu: 90 },
    true,
  );
  assert.match(message, /Alert:/);
});
