import assert from "node:assert/strict";
import test from "node:test";

import { normalizeToolkitSlug } from "../../../../src/integrations/composio/auth.js";

test("normalizeToolkitSlug lowercases and collapses separators", () => {
  assert.equal(normalizeToolkitSlug("google_calendar"), "googlecalendar");
  assert.equal(normalizeToolkitSlug("google-mail"), "googlemail");
  assert.equal(normalizeToolkitSlug("resend_email"), "resendemail");
  assert.equal(normalizeToolkitSlug("GitHub"), "github");
});
