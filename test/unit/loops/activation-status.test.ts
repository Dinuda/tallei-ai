import assert from "node:assert/strict";
import test from "node:test";

import { resolveActivationGap } from "../../../src/loops/activation-status.js";

test("verification failure takes precedence after activation is paused", () => {
  assert.equal(resolveActivationGap({
    triggerKind: "event",
    loopStatus: "paused",
    hasCompiledPlan: true,
    eventTrigger: { subscribed: false, verificationError: "missing_instance:not found" },
  }), "composio_trigger_verification_failed");
});

test("active unverified registration reports not registered without a verification error", () => {
  assert.equal(resolveActivationGap({
    triggerKind: "event",
    loopStatus: "active",
    hasCompiledPlan: true,
    eventTrigger: { subscribed: false, verificationError: null },
  }), "composio_trigger_not_registered");
});
