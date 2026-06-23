import assert from "node:assert/strict";
import test from "node:test";

import { enrichDraftPayload, prepareConnectorActionPayload } from "../../../src/services/conductor/runtime/spec-run-write-payload.js";
import type { RunContext } from "../../../src/services/conductor/runtime/build-run-context.js";

const runContext: RunContext = {
  workflowId: "workflow-1",
  trigger: { source: "connector", slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: "gmail" },
  ticket: {
    subject: "site down",
    body: "The site seems down.",
    messageId: "msg-1",
    threadId: "thread-1",
  },
  customer: { name: "Claude", email: "claude@example.com" },
  policies: {
    ticketContentMode: "email_body",
    customerDetailsMode: "sender_name_email",
    reviewMode: "draft_only",
  },
  grounding: [],
  templates: [{
    id: "ack",
    name: "Acknowledgment",
    templateId: "acknowledgment",
    subject: "Re: {{ticket_subject}}",
    html: "<p>Hi {{customer_name}}, thanks.</p>",
    text: "Hi {{customer_name}}, thanks.",
  }],
  connectorActionSlugs: ["GMAIL_REPLY_TO_THREAD"],
  connectorAccountIds: { gmail: "account-1" },
  hasTriggerPayload: true,
};

test("enrichDraftPayload normalizes Gmail reply aliases for Composio", () => {
  const payload = enrichDraftPayload("GMAIL_REPLY_TO_THREAD", {
    to: "claude@example.com",
    subject: "Re: site down",
    body: "Thanks, we are investigating.",
    threadId: "thread-1",
  }, runContext);

  assert.equal(payload.recipient_email, "claude@example.com");
  assert.equal(payload.thread_id, "thread-1");
  assert.equal(payload.subject, "Re: site down");
  assert.equal(payload.body, "Thanks, we are investigating.");
  assert.equal("to" in payload, false);
  assert.equal("threadId" in payload, false);
});

test("enrichDraftPayload fills Gmail reply recipient and thread from trigger context", () => {
  const payload = enrichDraftPayload("GMAIL_REPLY_TO_THREAD", {
    subject: "Re: site down",
    body: "Thanks, we are investigating.",
  }, runContext);

  assert.equal(payload.recipient_email, "claude@example.com");
  assert.equal(payload.thread_id, "thread-1");
  assert.equal(payload.message_id, "msg-1");
});

test("enrichDraftPayload maps Gmail reply message field to body", () => {
  const payload = enrichDraftPayload("GMAIL_REPLY_TO_THREAD", {
    threadId: "thread-1",
    message: "Thanks, we are investigating.",
  }, runContext);

  assert.equal(payload.recipient_email, "claude@example.com");
  assert.equal(payload.thread_id, "thread-1");
  assert.equal(payload.body, "Thanks, we are investigating.");
  assert.equal("message" in payload, false);
});

test("prepareConnectorActionPayload enriches read-tool Gmail reply payloads before execution", () => {
  const inputSchema = {
    type: "object",
    properties: {
      recipient_email: { type: "string" },
      thread_id: { type: "string" },
      body: { type: "string" },
      userId: { type: "string" },
    },
    required: ["recipient_email", "thread_id", "body"],
    additionalProperties: true,
  };

  const prepared = prepareConnectorActionPayload({
    actionSlug: "GMAIL_REPLY_TO_THREAD",
    inputSchema,
    payload: {
      userId: "me",
      threadId: "thread-1",
      message: "Re: site down - We're on it!",
    },
    runContext,
  });

  assert.equal(prepared.recipient_email, "claude@example.com");
  assert.equal(prepared.thread_id, "thread-1");
  assert.equal(prepared.body, "Re: site down - We're on it!");
  assert.equal(prepared.userId, "me");
});

test("enrichDraftPayload still applies templates for Gmail draft creation", () => {
  const payload = enrichDraftPayload("GMAIL_CREATE_EMAIL_DRAFT", {}, runContext);

  assert.equal(payload.recipient_email, "claude@example.com");
  assert.equal(payload.thread_id, "thread-1");
  assert.equal(payload.subject, "Re: site down");
  assert.equal(payload.body, "Hi Claude, thanks.");
  assert.equal(payload.is_html, true);
});
