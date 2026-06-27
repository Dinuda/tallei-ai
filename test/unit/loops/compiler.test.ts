import assert from "node:assert/strict";
import test from "node:test";

import { scoreToolForCapability } from "../../../src/loops/binding-discovery.js";

test("scoreToolForCapability ranks matching action slugs by capability tokens", () => {
  const score = scoreToolForCapability(
    "message.send",
    "SLACK_SEND_MESSAGE",
    "Send message",
    "Post a message to a Slack channel",
  );
  assert.ok(score >= 2);
});

test("scoreToolForCapability returns zero for unrelated capabilities", () => {
  assert.equal(
    scoreToolForCapability("payment.charge", "GMAIL_FETCH_EMAILS", "Fetch emails", "List messages"),
    0,
  );
});
