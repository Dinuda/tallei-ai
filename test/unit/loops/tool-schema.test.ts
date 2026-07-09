import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityForAction,
  filterArgsToSchemaProperties,
  scoreSchemaFieldRelevance,
  scoreTriggerFieldOverlap,
  summarizeInputSchema,
  toolIdForAction,
  validateToolArgsAgainstSchema,
} from "@tallei/composio-tools/tool-schema.js";

test("toolIdForAction derives stable ids from Composio slugs", () => {
  assert.equal(toolIdForAction("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"), "tool_gmail_fetch_message_by_message_id");
});

test("capabilityForAction returns the action slug", () => {
  assert.equal(capabilityForAction("gmail_fetch_message_by_message_id"), "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
});

test("scoreSchemaFieldRelevance scores overlap between outcome and schema fields", () => {
  const score = scoreSchemaFieldRelevance("fetch message by message id", {
    type: "object",
    required: ["message_id"],
    properties: {
      message_id: { type: "string", description: "Gmail message resource id" },
    },
  });
  assert.ok(score > 0);
});

test("scoreTriggerFieldOverlap prefers schemas that accept trigger keys", () => {
  const messageSchema = {
    type: "object",
    required: ["message_id"],
    properties: { message_id: { type: "string" } },
  };
  const filterSchema = {
    type: "object",
    required: ["filter_id"],
    properties: { filter_id: { type: "string" } },
  };
  const trigger = { message_id: "abc" };
  assert.ok(scoreTriggerFieldOverlap(trigger, messageSchema) > scoreTriggerFieldOverlap(trigger, filterSchema));
});

test("filterArgsToSchemaProperties drops planner args not in schema", () => {
  const filtered = filterArgsToSchemaProperties(
    { message_id: "abc", format: "metadata", user_id: "me" },
    {
      type: "object",
      properties: {
        message_id: { type: "string" },
      },
    },
  );
  assert.deepEqual(filtered, { message_id: "abc" });
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

test("validateToolArgsAgainstSchema fails when anyOf is not satisfied", () => {
  const schema = {
    type: "object",
    required: ["message_id"],
    properties: {
      message_id: { type: "string" },
      add_label_ids: { type: "array" },
      remove_label_ids: { type: "array" },
    },
    anyOf: [
      { required: ["add_label_ids"] },
      { required: ["remove_label_ids"] },
    ],
  };
  const result = validateToolArgsAgainstSchema({ message_id: "abc" }, schema);
  assert.equal(result.ok, false);
});

test("validateToolArgsAgainstSchema passes when one anyOf branch is satisfied", () => {
  const schema = {
    type: "object",
    required: ["message_id"],
    properties: {
      message_id: { type: "string" },
      add_label_ids: { type: "array" },
      remove_label_ids: { type: "array" },
    },
    anyOf: [
      { required: ["add_label_ids"] },
      { required: ["remove_label_ids"] },
    ],
  };
  const result = validateToolArgsAgainstSchema(
    { message_id: "abc", add_label_ids: ["INBOX"] },
    schema,
  );
  assert.equal(result.ok, true);
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
