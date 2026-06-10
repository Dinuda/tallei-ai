import assert from "node:assert/strict";
import test from "node:test";

import { connectedAppToolkits, isForeignToolkitComposioAction, scoreComposioActionForDelivery } from "../../../src/services/connectors/composio.js";

test("foreign toolkit Composio slugs are detected and excluded from delivery scoring", () => {
  assert.equal(isForeignToolkitComposioAction("resend", "_1password_create_item"), true);
  assert.equal(isForeignToolkitComposioAction("resend", "_2chat_create_contact"), true);
  assert.equal(isForeignToolkitComposioAction("resend", "RESEND_SEND_EMAIL"), false);
  assert.equal(isForeignToolkitComposioAction("1password", "_1password_create_item"), false);
});

test("contact-only Composio discovery scores zero; connector send catalog scores for subscriber delivery", () => {
  const contactOnly = scoreComposioActionForDelivery({
    action: {
      toolkit: "resend",
      actionSlug: "_2chat_create_contact",
      name: "Create Contact",
      description: "Create a contact",
      risk: "send",
      inputSchema: { type: "object" },
    },
    target: "subscriber_list",
  });
  const sendEmail = scoreComposioActionForDelivery({
    action: {
      toolkit: "resend",
      actionSlug: "RESEND_SEND_EMAIL",
      name: "Send Email",
      description: "Send an email using Resend.",
      risk: "send",
      inputSchema: { type: "object" },
    },
    target: "subscriber_list",
  });
  assert.equal(contactOnly, null);
  assert.ok(sendEmail && sendEmail.score > 0);
});

test("connected app toolkit extraction ignores generic Composio provider placeholders", () => {
  assert.deepEqual(connectedAppToolkits([
    {
      id: "acct_1",
      provider: "composio",
      appKey: null,
      externalAccountId: "external_1",
      status: "connected",
      scopes: [],
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
    },
    {
      id: "acct_2",
      provider: "composio",
      appKey: "1password",
      externalAccountId: "external_2",
      status: "connected",
      scopes: [],
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
    },
  ]), ["1password"]);
});
