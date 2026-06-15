import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

process.env.TALLEI_CONNECTORS__COMPOSIO_WEBHOOK_SECRET = "test-composio-secret";

const { verifyComposioWebhookSignature } = await import("../../../src/services/connectors/composio.js");

test("verifyComposioWebhookSignature accepts Composio subscription webhook headers", () => {
  const secret = "test-composio-secret";
  const webhookId = "msg_123";
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id: "evt_1",
    type: "composio.trigger.message",
    metadata: { trigger_id: "ti_1", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
    data: { subject: "hello" },
  });
  const rawBody = Buffer.from(body, "utf8");
  const signingString = `${webhookId}.${webhookTimestamp}.${body}`;
  const digest = createHmac("sha256", secret).update(signingString).digest("base64");
  const webhookSignature = `v1,${digest}`;

  assert.equal(
    verifyComposioWebhookSignature(rawBody, { webhookId, webhookTimestamp, webhookSignature }),
    true,
  );
});

test("verifyComposioWebhookSignature rejects tampered subscription webhook payloads", () => {
  const secret = "test-composio-secret";
  const webhookId = "msg_456";
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ id: "evt_2", type: "composio.trigger.message" });
  const rawBody = Buffer.from(body, "utf8");
  const signingString = `${webhookId}.${webhookTimestamp}.${body}`;
  const digest = createHmac("sha256", secret).update(signingString).digest("base64");

  assert.equal(
    verifyComposioWebhookSignature(rawBody, {
      webhookId,
      webhookTimestamp,
      webhookSignature: `v1,${digest}`,
    }),
    true,
  );
  assert.equal(
    verifyComposioWebhookSignature(Buffer.from(`${body}x`, "utf8"), {
      webhookId,
      webhookTimestamp,
      webhookSignature: `v1,${digest}`,
    }),
    false,
  );
});

test("verifyComposioWebhookSignature still supports legacy x-composio-signature", () => {
  const secret = "test-composio-secret";
  const rawBody = Buffer.from(JSON.stringify({ type: "connected_account.connected" }), "utf8");
  const legacySignature = createHmac("sha256", secret).update(rawBody).digest("hex");

  assert.equal(
    verifyComposioWebhookSignature(rawBody, { legacySignature }),
    true,
  );
});
