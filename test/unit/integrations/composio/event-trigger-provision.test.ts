import assert from "node:assert/strict";
import test from "node:test";

test("resolveTriggerSlugWithCatalog uses static alias without Composio API", async () => {
  const { resolveTriggerSlugWithCatalog } = await import(
    "../../../../src/integrations/composio/triggers.js"
  );
  const slug = await resolveTriggerSlugWithCatalog("gmail", "new_message");
  assert.equal(slug, "GMAIL_NEW_GMAIL_MESSAGE");
});

test("resolveCanonicalTriggerSlug accepts eventType hints through static map", async () => {
  const { lookupStaticTriggerSlug } = await import("../../../../src/loops/trigger-catalog.js");
  const { isComposioTriggerSlugFormat } = await import("../../../../src/loops/event-trigger.js");

  const hint = "new_message";
  const staticSlug = lookupStaticTriggerSlug("gmail", hint);
  assert.equal(staticSlug, "GMAIL_NEW_GMAIL_MESSAGE");
  assert.equal(isComposioTriggerSlugFormat(staticSlug!), true);
});
