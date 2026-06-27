import assert from "node:assert/strict";
import test from "node:test";

import { scoreTriggerSlugMatch } from "../../../src/integrations/composio/triggers.js";

test("scoreTriggerSlugMatch prefers slugs that share event tokens", () => {
  const score = scoreTriggerSlugMatch(
    "new_message",
    "GMAIL_NEW_GMAIL_MESSAGE",
    "New Gmail Message",
  );
  assert.ok(score >= 4);
});

test("scoreTriggerSlugMatch returns low score for unrelated events", () => {
  const score = scoreTriggerSlugMatch(
    "totally_unknown_event",
    "GMAIL_NEW_GMAIL_MESSAGE",
    "New Gmail Message",
  );
  assert.ok(score < 4);
});
