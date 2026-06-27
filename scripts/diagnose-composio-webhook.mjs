import "dotenv/config";
import { createHmac } from "crypto";

const apiKey = process.env.TALLEI_CONNECTORS__COMPOSIO_API_KEY;
const baseUrl = process.env.TALLEI_CONNECTORS__COMPOSIO_BASE_URL || "https://backend.composio.dev";
const envSecret = (process.env.TALLEI_CONNECTORS__COMPOSIO_WEBHOOK_SECRET || "").trim();
const publicUrl = (process.env.TALLEI_HTTP__PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const expectedUrl = `${publicUrl}/api/connectors/composio/webhook`;

const res = await fetch(`${baseUrl}/api/v3.1/webhook_subscriptions`, {
  headers: { "x-api-key": apiKey },
});
const text = await res.text();
if (!res.ok) {
  console.log("list_failed", res.status, text.slice(0, 400));
  process.exit(1);
}

const data = JSON.parse(text);
const items = data.items || data.data || [];
console.log(JSON.stringify({
  expectedUrl,
  envSecretSet: Boolean(envSecret),
  envSecretLen: envSecret.length,
  subscriptionCount: items.length,
  subscriptions: items.map((item) => ({
    id: item.id,
    url: item.webhook_url || item.webhookUrl,
    version: item.version,
    events: item.enabled_events,
    urlMatchesExpected: (item.webhook_url || item.webhookUrl) === expectedUrl,
    apiSecretLen: String(item.secret || "").trim().length,
    envMatchesApiSecret: envSecret && String(item.secret || "").trim() === envSecret,
  })),
}, null, 2));

if (envSecret) {
  const body = JSON.stringify({ type: "composio.trigger.message", metadata: {}, data: {} });
  const webhookId = "msg_diag";
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const signingString = `${webhookId}.${webhookTimestamp}.${body}`;
  const sig = createHmac("sha256", envSecret).update(signingString).digest("base64");
  console.log("self_test_signature_ok", Boolean(sig));
}
