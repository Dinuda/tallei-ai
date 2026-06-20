import assert from "node:assert/strict";
import test from "node:test";

import {
  SpecRunApprovalRequiredError,
  toolDisplayName,
} from "../../../src/services/loop-runtime/spec-run-tool-tracker.js";

test("toolDisplayName maps spec-run tools to operator-facing labels", () => {
  assert.equal(toolDisplayName("getTriggerTicket"), "Ticket Intake");
  assert.equal(toolDisplayName("searchMemory"), "Memory Search");
  assert.equal(toolDisplayName("searchWeb"), "Web Search");
  assert.equal(toolDisplayName("finalizeRun"), "Complete Run");
  assert.equal(toolDisplayName("search_gmail"), "Gmail Search");
  assert.match(toolDisplayName("action_gmail_GMAIL_CREATE_EMAIL_DRAFT"), /Create Email Draft/i);
});

test("SpecRunApprovalRequiredError carries pause metadata", () => {
  const error = new SpecRunApprovalRequiredError("step-1", "interaction-1");
  assert.equal(error.name, "SpecRunApprovalRequiredError");
  assert.equal(error.stepAttemptId, "step-1");
  assert.equal(error.interactionId, "interaction-1");
  assert.match(error.message, /approval/i);
});
