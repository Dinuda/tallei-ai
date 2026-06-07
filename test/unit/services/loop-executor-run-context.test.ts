import assert from "node:assert/strict";
import test from "node:test";

import { readLoopExecutorMeta } from "../../../src/services/loop-executor/run-context.js";

test("readLoopExecutorMeta accepts approvalRequest reserved before send", () => {
  const meta = readLoopExecutorMeta({
    loop_executor: {
      approvalRequest: {
        to: "user@example.com",
        approvalUrl: "https://example.com/approve",
        token: "token-1",
        reservedAt: "2026-06-06T12:00:00.000Z",
      },
    },
  });

  assert.equal(meta.approvalRequest?.to, "user@example.com");
  assert.equal(meta.approvalRequest?.sentAt, "2026-06-06T12:00:00.000Z");
  assert.equal(meta.approvalRequest?.reservedAt, "2026-06-06T12:00:00.000Z");
});
