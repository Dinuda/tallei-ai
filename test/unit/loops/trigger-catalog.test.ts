import assert from "node:assert/strict";
import test from "node:test";

import {
  lookupStaticTriggerSlug,
  resolveComposioTriggerSlug,
  resolveTriggerFromComposioSlug,
} from "../../../src/loops/trigger-catalog.js";

test("resolveComposioTriggerSlug maps gmail new_message", () => {
  assert.equal(
    resolveComposioTriggerSlug("gmail", "new_message"),
    "GMAIL_NEW_GMAIL_MESSAGE",
  );
});

test("lookupStaticTriggerSlug maps gmail message.new", () => {
  assert.equal(
    lookupStaticTriggerSlug("gmail", "message.new"),
    "GMAIL_NEW_GMAIL_MESSAGE",
  );
});

test("lookupStaticTriggerSlug does not guess invalid gmail slug", () => {
  assert.equal(lookupStaticTriggerSlug("gmail", "totally_unknown_event"), null);
});

test("resolveTriggerFromComposioSlug maps gmail slug back", () => {
  assert.deepEqual(resolveTriggerFromComposioSlug("GMAIL_NEW_GMAIL_MESSAGE"), {
    source: "gmail",
    eventType: "new_message",
  });
});
