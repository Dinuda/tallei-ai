import assert from "node:assert/strict";
import test from "node:test";

import { scoreOutcomeRelevance } from "../../../src/loops/binding-discovery.js";

test("scoreOutcomeRelevance ranks matching action slugs by outcome word overlap", () => {
  const score = scoreOutcomeRelevance(
    "send message to slack channel",
    "SLACK_SEND_MESSAGE",
    "Send message",
    "Post a message to a Slack channel",
  );
  assert.ok(score >= 2);
});

test("scoreOutcomeRelevance returns zero for unrelated outcomes", () => {
  assert.equal(
    scoreOutcomeRelevance("payment charge", "GMAIL_FETCH_EMAILS", "Fetch emails", "List messages"),
    0,
  );
});
