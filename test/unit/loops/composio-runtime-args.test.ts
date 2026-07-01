import assert from "node:assert/strict";
import test from "node:test";

import { clampComposioArgsForRuntime } from "../../../src/loops/composio-runtime-args.js";

const listSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    max_results: { type: "integer" },
    include_payload: { type: "boolean" },
  },
};

const getSchema = {
  type: "object",
  required: ["message_id"],
  properties: {
    message_id: { type: "string" },
    include_payload: { type: "boolean" },
  },
};

test("clampComposioArgsForRuntime caps list-shaped schemas and disables payload fields", () => {
  const clamped = clampComposioArgsForRuntime({
    inputSchema: listSchema,
    args: { query: "is:unread", max_results: 10, include_payload: true },
  });
  assert.equal(clamped.max_results, 2);
  assert.equal(clamped.include_payload, false);
  assert.equal(clamped.query, "is:unread");
});

test("clampComposioArgsForRuntime disables payload fields on single-item schemas", () => {
  const clamped = clampComposioArgsForRuntime({
    inputSchema: getSchema,
    args: { message_id: "abc123", include_payload: true },
  });
  assert.equal(clamped.message_id, "abc123");
  assert.equal(clamped.include_payload, false);
  assert.equal(clamped.max_results, undefined);
});

test("clampComposioArgsForRuntime leaves schemas without list or payload fields unchanged", () => {
  const args = { channel: "#general", text: "hello" };
  const clamped = clampComposioArgsForRuntime({
    inputSchema: { properties: { channel: {}, text: {} } },
    args,
  });
  assert.deepEqual(clamped, args);
});
