import assert from "node:assert/strict";
import { createHmac } from "crypto";
import test from "node:test";

process.env.TALLEI_CONNECTORS__COMPOSIO_WEBHOOK_SECRET = "test-secret";

const { verifyComposioWebhookSignature, normalizeComposioWebhookPayload } = await import(
  "../../../../src/integrations/composio/webhooks.js"
);

test("verifyComposioWebhookSignature accepts legacy HMAC signature", () => {
  const rawBody = Buffer.from(JSON.stringify({ type: "trigger" }), "utf8");
  const legacy = createHmac("sha256", "test-secret").update(rawBody).digest("hex");
  assert.equal(
    verifyComposioWebhookSignature(rawBody, { legacySignature: legacy }),
    true,
  );
});

test("normalizeComposioWebhookPayload maps trigger envelope", () => {
  const normalized = normalizeComposioWebhookPayload({
    type: "trigger",
    data: {
      entityId: "tallei:tenant-1:user-1:ws-9",
      metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
      id: "evt-1",
    },
  });
  assert.equal(normalized.kind, "trigger_event");
  if (normalized.kind === "trigger_event") {
    assert.equal(normalized.triggerSlug, "GMAIL_NEW_GMAIL_MESSAGE");
    assert.equal(normalized.entityId, "tallei:tenant-1:user-1:ws-9");
    assert.equal(normalized.externalEventId, "evt-1");
  }
});
