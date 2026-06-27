import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTriggerKnownFields,
  formatTriggerKnownFields,
} from "../../../../src/integrations/composio/trigger-known-fields.js";

test("extractTriggerKnownFields pulls message ids from nested payload", () => {
  const fields = extractTriggerKnownFields({
    payload: {
      message_id: "19f0a47ed24a41f6",
      subject: "site down",
      from: "user@example.com",
    },
  }, "GMAIL_NEW_GMAIL_MESSAGE");
  assert.equal(fields.message_id, "19f0a47ed24a41f6");
  assert.equal(fields.subject, "site down");
  assert.equal(fields.trigger_slug, "GMAIL_NEW_GMAIL_MESSAGE");
});

test("formatTriggerKnownFields renders key value lines", () => {
  const text = formatTriggerKnownFields({ message_id: "abc", subject: "hi" });
  assert.match(text, /message_id: abc/);
  assert.match(text, /subject: hi/);
});
