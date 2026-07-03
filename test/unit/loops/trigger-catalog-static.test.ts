import assert from "node:assert/strict";
import test from "node:test";

import { isKnownTriggerSlugForSource, lookupStaticTriggerSlug } from "../../../src/loops/trigger-catalog.js";

test("lookupStaticTriggerSlug maps gmail new_message to GMAIL_NEW_GMAIL_MESSAGE", () => {
  assert.equal(lookupStaticTriggerSlug("gmail", "new_message"), "GMAIL_NEW_GMAIL_MESSAGE");
  assert.equal(lookupStaticTriggerSlug("GMAIL", "new_email"), "GMAIL_NEW_GMAIL_MESSAGE");
});

test("lookupStaticTriggerSlug returns uppercase slug when hint is already canonical", () => {
  assert.equal(
    lookupStaticTriggerSlug("gmail", "GMAIL_NEW_GMAIL_MESSAGE"),
    "GMAIL_NEW_GMAIL_MESSAGE",
  );
});

test("lookupStaticTriggerSlug returns null for unknown hints", () => {
  assert.equal(lookupStaticTriggerSlug("gmail", "totally_unknown"), null);
});

test("isKnownTriggerSlugForSource recognizes static gmail trigger slugs", () => {
  assert.equal(isKnownTriggerSlugForSource("gmail", "GMAIL_NEW_GMAIL_MESSAGE"), true);
  assert.equal(isKnownTriggerSlugForSource("gmail", "GMAIL_FETCH_EMAILS"), false);
});
