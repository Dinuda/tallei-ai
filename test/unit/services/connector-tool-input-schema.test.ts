import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConnectorToolInputSchema,
  extractConnectorActionPayload,
  summarizeConnectorInputSchema,
} from "../../../src/services/loop-runtime/connector-tool-input-schema.js";
import { prepareConnectorActionPayload } from "../../../src/services/loop-runtime/spec-run-write-payload.js";
import type { RunContext } from "../../../src/services/loop-runtime/build-run-context.js";

const gmailFetchSchema = {
  type: "object",
  properties: {
    thread_id: { type: "string", description: "Gmail thread id" },
    userId: { type: "string", description: "Mailbox user id" },
  },
  required: ["thread_id"],
  additionalProperties: false,
};

test("buildConnectorToolInputSchema rejects camelCase threadId before execution", () => {
  const schema = buildConnectorToolInputSchema(gmailFetchSchema);
  const invalid = schema.safeParse({ threadId: "thread-1", userId: "me" });
  assert.equal(invalid.success, false);

  const valid = schema.safeParse({ thread_id: "thread-1", userId: "me" });
  assert.equal(valid.success, true);
});

test("summarizeConnectorInputSchema lists required connector fields", () => {
  const summary = summarizeConnectorInputSchema(gmailFetchSchema);
  assert.match(summary, /thread_id/);
  assert.match(summary, /top level/);
});

test("extractConnectorActionPayload unwraps legacy payload nesting", () => {
  assert.deepEqual(
    extractConnectorActionPayload({
      payload: { thread_id: "thread-1", userId: "me" },
      rationale: "fetch thread",
    }),
    { thread_id: "thread-1", userId: "me" },
  );
});

test("prepareConnectorActionPayload normalizes Gmail fetch thread aliases", () => {
  const runContext: RunContext = {
    workflowId: "workflow-1",
    trigger: { source: "connector", slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: "gmail" },
    ticket: {
      subject: "site down",
      body: "The site seems down.",
      threadId: "thread-from-trigger",
      messageId: "msg-1",
    },
    customer: { name: "Dinuda", email: "claude@example.com" },
    policies: {
      ticketContentMode: "email_body",
      customerDetailsMode: "sender_name_email",
      reviewMode: "draft_only",
    },
    grounding: [],
    templates: [],
    connectorActionSlugs: [],
    connectorAccountIds: {},
    hasTriggerPayload: true,
  };

  const prepared = prepareConnectorActionPayload({
    actionSlug: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    inputSchema: gmailFetchSchema,
    payload: { threadId: "thread-1", userId: "me" },
    runContext,
  });

  assert.equal(prepared.thread_id, "thread-1");
  assert.equal(prepared.userId, "me");
});
