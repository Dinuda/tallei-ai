import "dotenv/config";
import { createHmac } from "crypto";

const secret = process.env.TALLEI_CONNECTORS__COMPOSIO_WEBHOOK_SECRET.trim();
const tenant = "58e4686e-3e91-4204-881b-3ebfe70a822a";
const user = "ed6c9a78-bf96-415a-bf06-6a964c9d3b65";
const ws = "2bd8ac59-133f-4580-bda5-0a888ac818dd";
const body = JSON.stringify({
  id: `msg_diag_${Date.now()}`,
  type: "composio.trigger.message",
  metadata: {
    trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
    user_id: `tallei:${tenant}:${user}:${ws}`,
    connected_account_id: "ca_jIns02h652pH",
  },
  data: { message_id: "m-diag", subject: "Test" },
});
const webhookId = `msg_diag_${Date.now()}`;
const ts = String(Math.floor(Date.now() / 1000));
const sig = createHmac("sha256", secret).update(`${webhookId}.${ts}.${body}`).digest("base64");

const res = await fetch("http://127.0.0.1:3000/api/connectors/composio/webhook", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "webhook-id": webhookId,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
  },
  body,
});
console.log("status", res.status);
console.log("body", await res.text());
