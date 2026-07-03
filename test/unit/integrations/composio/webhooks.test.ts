import assert from "node:assert/strict";
import { createHmac } from "crypto";
import test from "node:test";

process.env.TALLEI_CONNECTORS__COMPOSIO_WEBHOOK_SECRET = "test-secret";

const { verifyComposioWebhookSignature, verifyComposioWebhookSignatureDetailed, normalizeComposioWebhookPayload } = await import(
  "../../../../src/integrations/composio/webhooks.js"
);

test("verifyComposioWebhookSignature accepts v1 prefixed subscription signature", () => {
  const rawBody = Buffer.from(JSON.stringify({ type: "composio.trigger.message" }), "utf8");
  const webhookId = "msg_123";
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const signingString = `${webhookId}.${webhookTimestamp}.${rawBody.toString("utf8")}`;
  const signature = createHmac("sha256", "test-secret").update(signingString).digest("base64");
  assert.equal(
    verifyComposioWebhookSignature(rawBody, {
      webhookId,
      webhookTimestamp,
      webhookSignature: `v1,${signature}`,
    }),
    true,
  );
});

test("ingestWebhookSubscriptionItems remembers subscription signing secrets", async () => {
  const mod = await import("../../../../src/integrations/composio/webhook-subscription.js");
  const added = mod.ingestWebhookSubscriptionItems([
    { webhook_url: "https://app.example/api/connectors/composio/webhook", secret: "api-subscription-secret" },
  ]);
  assert.equal(added, 1);
  assert.ok(mod.composioWebhookSecretsToTry().includes("api-subscription-secret"));
});

test("verifyComposioWebhookSignatureDetailed reports invalid signature", () => {
  const result = verifyComposioWebhookSignatureDetailed(Buffer.from("{}"), {
    webhookId: "a",
    webhookTimestamp: String(Math.floor(Date.now() / 1000)),
    webhookSignature: "v1,not-a-valid-signature",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_signature");
});

test("normalizeComposioWebhookPayload maps Composio V3 trigger envelope", () => {
  const normalized = normalizeComposioWebhookPayload({
    id: "msg_abc123",
    type: "composio.trigger.message",
    metadata: {
      trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
      user_id: "tallei:tenant-1:user-1:ws-9",
      connected_account_id: "ca_123",
    },
    data: {
      message_id: "m-1",
      subject: "Help",
    },
  });
  assert.equal(normalized.kind, "trigger_event");
  if (normalized.kind === "trigger_event") {
    assert.equal(normalized.triggerSlug, "GMAIL_NEW_GMAIL_MESSAGE");
    assert.equal(normalized.entityId, "tallei:tenant-1:user-1:ws-9");
    assert.equal(normalized.externalEventId, "msg_abc123");
  }
});
