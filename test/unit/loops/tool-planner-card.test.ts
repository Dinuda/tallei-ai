import assert from "node:assert/strict";
import test from "node:test";

import { buildPlannerCardFromSchemas } from "../../../src/loops/tool-planner-card.js";

test("buildPlannerCardFromSchemas adds Gmail list anti-patterns", () => {
  const card = buildPlannerCardFromSchemas({
    actionSlug: "GMAIL_FETCH_EMAILS",
    capability: "email.read",
    description: "Fetch emails",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Gmail search" } },
    },
  });
  assert.match(card.whenNotToUse ?? "", /fetch-by-id/i);
  assert.ok(card.antiPatterns?.some((p) => p.includes("id:")));
  assert.ok(card.argGuides.query?.description);
});

test("buildPlannerCardFromSchemas guides get-by-id message_id", () => {
  const card = buildPlannerCardFromSchemas({
    actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    capability: "email.get",
    description: "Get message",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: { message_id: { type: "string" } },
    },
  });
  assert.match(card.whenToUse ?? "", /message_id/i);
  assert.ok(card.argGuides.message_id?.description);
});
