import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSIO_TRIGGER_SLUG_PATTERN,
  isComposioTriggerSlugFormat,
  isEventTriggerReadyForCompile,
  isToolkitSlugMasqueradingAsTrigger,
  resolveEventTriggerLocallyForCompile,
  validateEventTriggerShape,
} from "../../../src/loops/event-trigger.js";

test("COMPOSIO_TRIGGER_SLUG_PATTERN accepts real Composio slugs", () => {
  assert.equal(COMPOSIO_TRIGGER_SLUG_PATTERN.test("GMAIL_NEW_GMAIL_MESSAGE"), true);
  assert.equal(COMPOSIO_TRIGGER_SLUG_PATTERN.test("HUBSPOT_NEW_CONTACT"), true);
});

test("COMPOSIO_TRIGGER_SLUG_PATTERN rejects toolkit names", () => {
  assert.equal(COMPOSIO_TRIGGER_SLUG_PATTERN.test("gmail"), false);
  assert.equal(COMPOSIO_TRIGGER_SLUG_PATTERN.test("slack"), false);
});

test("isToolkitSlugMasqueradingAsTrigger detects connector name in composioSlug", () => {
  assert.equal(isToolkitSlugMasqueradingAsTrigger("gmail", "gmail"), true);
  assert.equal(isToolkitSlugMasqueradingAsTrigger("gmail", "GMAIL_NEW_GMAIL_MESSAGE"), false);
});

test("isEventTriggerReadyForCompile requires uppercase catalogue slug", () => {
  assert.equal(isEventTriggerReadyForCompile("gmail", "gmail"), false);
  assert.equal(isEventTriggerReadyForCompile("gmail", "GMAIL_NEW_GMAIL_MESSAGE"), true);
  assert.equal(isEventTriggerReadyForCompile("gmail", ""), false);
});

test("validateEventTriggerShape explains toolkit vs trigger confusion", () => {
  const message = validateEventTriggerShape("gmail", "gmail");
  assert.ok(message);
  assert.match(message, /connector toolkit/i);
  assert.match(message, /listTriggers/i);
});

test("isComposioTriggerSlugFormat is a thin guard", () => {
  assert.equal(isComposioTriggerSlugFormat("GMAIL_NEW_GMAIL_MESSAGE"), true);
  assert.equal(isComposioTriggerSlugFormat("gmail"), false);
});

test("resolveEventTriggerLocallyForCompile accepts known static gmail trigger slugs", () => {
  assert.equal(
    resolveEventTriggerLocallyForCompile("gmail", "GMAIL_NEW_GMAIL_MESSAGE", "new_message"),
    "GMAIL_NEW_GMAIL_MESSAGE",
  );
  assert.equal(resolveEventTriggerLocallyForCompile("gmail", "GMAIL_FETCH_EMAILS"), null);
});
