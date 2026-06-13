import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDesignCron, nextCronRunAt, validateFiveFieldCron } from "../../../src/services/loop-executor/cron.js";

test("validateFiveFieldCron normalizes day-of-week names", () => {
  assert.equal(validateFiveFieldCron("0 9 * * FRI"), "0 9 * * 5");
  assert.equal(validateFiveFieldCron("0 9 * * friday"), "0 9 * * 5");
  assert.equal(validateFiveFieldCron("0 9 * * MON-FRI"), "0 9 * * 1-5");
});

test("normalizeDesignCron coerces named day schedules", () => {
  assert.equal(normalizeDesignCron("0 9 * * FRI"), "0 9 * * 5");
  assert.equal(normalizeDesignCron("every friday at 9", "weekly on friday morning"), "0 9 * * 5");
});

test("nextCronRunAt accepts named day-of-week cron", () => {
  const next = nextCronRunAt("0 9 * * FRI");
  assert.ok(next instanceof Date);
  assert.equal(next.getUTCDay(), 5);
});
