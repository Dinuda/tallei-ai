import assert from "node:assert/strict";
import test from "node:test";

import {
  clampComposioArgsForRuntime,
  isEmailGetAction,
  isEmailListAction,
} from "../../../src/loops/composio-runtime-args.js";

const gmailListSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    max_results: { type: "integer" },
    include_payload: { type: "boolean" },
  },
};

const gmailGetSchema = {
  type: "object",
  required: ["message_id"],
  properties: {
    message_id: { type: "string" },
    include_payload: { type: "boolean" },
  },
};

test("isEmailListAction detects fetch/list slugs and email.read capability", () => {
  assert.equal(isEmailListAction("GMAIL_FETCH_EMAILS", "email.read"), true);
  assert.equal(isEmailListAction("GMAIL_FETCH_EMAILS_WITH_FILTERS", "tool.action"), true);
  assert.equal(isEmailListAction("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "email.get"), false);
});

test("isEmailGetAction detects by-id fetch slugs", () => {
  assert.equal(isEmailGetAction("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "email.get"), true);
  assert.equal(isEmailGetAction("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "email.get"), true);
  assert.equal(isEmailGetAction("GMAIL_FETCH_EMAILS", "email.read"), false);
});

test("clampComposioArgsForRuntime caps list fetch and disables payload", () => {
  const clamped = clampComposioArgsForRuntime({
    actionSlug: "GMAIL_FETCH_EMAILS",
    capability: "email.read",
    inputSchema: gmailListSchema,
    args: { query: "is:unread", max_results: 10, include_payload: true },
  });
  assert.equal(clamped.max_results, 2);
  assert.equal(clamped.include_payload, false);
  assert.equal(clamped.query, "is:unread");
});

test("clampComposioArgsForRuntime preserves max_results when already within cap", () => {
  const clamped = clampComposioArgsForRuntime({
    actionSlug: "GMAIL_FETCH_EMAILS",
    capability: "email.read",
    inputSchema: gmailListSchema,
    args: { query: "is:unread", max_results: 1, include_payload: true },
  });
  assert.equal(clamped.max_results, 1);
});

test("clampComposioArgsForRuntime disables payload on get-by-id", () => {
  const clamped = clampComposioArgsForRuntime({
    actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    capability: "email.get",
    inputSchema: gmailGetSchema,
    args: { message_id: "abc123", include_payload: true },
  });
  assert.equal(clamped.message_id, "abc123");
  assert.equal(clamped.include_payload, false);
  assert.equal(clamped.max_results, undefined);
});

test("clampComposioArgsForRuntime leaves non-email tools unchanged", () => {
  const args = { channel: "#general", text: "hello" };
  const clamped = clampComposioArgsForRuntime({
    actionSlug: "SLACK_SEND_MESSAGE",
    capability: "chat.send",
    inputSchema: { properties: { channel: {}, text: {} } },
    args,
  });
  assert.deepEqual(clamped, args);
});
