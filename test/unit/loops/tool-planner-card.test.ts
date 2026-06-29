import assert from "node:assert/strict";
import test from "node:test";

import { buildPlannerCardFromSchemas } from "../../../src/loops/tool-planner-card.js";

test("buildPlannerCardFromSchemas uses description as summary", () => {
  const card = buildPlannerCardFromSchemas({
    actionSlug: "GMAIL_FETCH_EMAILS",
    capability: "email.read",
    description: "Fetch emails matching a query",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Gmail search query" } },
    },
  });
  assert.equal(card.summary, "Fetch emails matching a query");
  assert.ok(card.argGuides.query?.description);
});

test("buildPlannerCardFromSchemas builds argGuides from schema descriptions", () => {
  const card = buildPlannerCardFromSchemas({
    actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    capability: "email.get",
    description: "Get a Gmail message by its ID",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string", description: "The Gmail message resource ID" },
      },
    },
  });
  assert.ok(card.argGuides.message_id?.description?.includes("Gmail message resource ID"));
});

test("buildPlannerCardFromSchemas surfaces anyOf constraints in argGuides", () => {
  const card = buildPlannerCardFromSchemas({
    actionSlug: "GMAIL_MODIFY_LABELS_OF_EMAIL",
    capability: "email.labels",
    description: "Add or remove labels from a Gmail message",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        message_id: { type: "string", description: "The Gmail message ID" },
        add_label_ids: { type: "array", description: "Label IDs to add" },
        remove_label_ids: { type: "array", description: "Label IDs to remove" },
      },
      anyOf: [
        { required: ["add_label_ids"] },
        { required: ["remove_label_ids"] },
      ],
    },
  });
  // Both label fields should have the anyOf note in their description.
  assert.ok(card.argGuides.add_label_ids?.description?.toLowerCase().includes("required"));
  assert.ok(card.argGuides.remove_label_ids?.description?.toLowerCase().includes("required"));
});

test("buildPlannerCardFromSchemas includes pitfalls as antiPatterns", () => {
  const card = buildPlannerCardFromSchemas({
    actionSlug: "SLACK_SEND_MESSAGE",
    capability: "chat.send",
    description: "Send a Slack message",
    inputSchema: {
      type: "object",
      required: ["channel", "text"],
      properties: {
        channel: { type: "string" },
        text: { type: "string" },
      },
    },
    pitfalls: ["Do not use channel names — use channel IDs only"],
  });
  assert.ok(card.antiPatterns?.some((p) => p.includes("channel IDs")));
});
