import assert from "node:assert/strict";
import test from "node:test";

import {
  scoreSchemaFitForCapability,
  semanticCapabilityForAction,
  summarizeInputSchema,
  validateToolArgsAgainstSchema,
} from "../../../src/loops/tool-schema.js";

test("scoreSchemaFitForCapability penalizes id-only fetch for inbox poll capabilities", () => {
  const score = scoreSchemaFitForCapability("email.receive", {
    type: "object",
    required: ["message_id"],
    properties: { message_id: { type: "string" } },
  });
  assert.ok(score < 0);
});

test("scoreSchemaFitForCapability prefers list/query schemas for email.read", () => {
  const score = scoreSchemaFitForCapability("email.read", {
    type: "object",
    properties: {
      query: { type: "string" },
      maxResults: { type: "number" },
    },
  });
  assert.ok(score > 0);
});

test("scoreSchemaFitForCapability accepts email.get for message_id actions", () => {
  const schema = {
    type: "object",
    required: ["message_id"],
    properties: { message_id: { type: "string" } },
  };
  assert.ok(scoreSchemaFitForCapability("email.get", schema, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID") > 0);
});

test("scoreSchemaFitForCapability does not penalize raw action slugs used as capability", () => {
  const schema = {
    type: "object",
    required: ["message_id"],
    properties: { message_id: { type: "string" } },
  };
  const score = scoreSchemaFitForCapability(
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    schema,
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  );
  assert.ok(score >= 0);
});

test("semanticCapabilityForAction maps fetch-by-id to email.get", () => {
  assert.equal(
    semanticCapabilityForAction("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
      type: "object",
      required: ["message_id"],
      properties: { message_id: { type: "string" } },
    }, "email"),
    "email.get",
  );
});

test("validateToolArgsAgainstSchema reports missing required fields", () => {
  const result = validateToolArgsAgainstSchema(
    { query: "is:unread" },
    {
      type: "object",
      required: ["message_id"],
      properties: { message_id: { type: "string" } },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.missing, ["message_id"]);
  }
});

test("summarizeInputSchema extracts required and property names", () => {
  const summary = summarizeInputSchema({
    type: "object",
    required: ["message_id"],
    properties: {
      message_id: { type: "string" },
      query: { type: "string" },
    },
  });
  assert.deepEqual(summary.required, ["message_id"]);
  assert.ok(summary.properties.includes("query"));
});
