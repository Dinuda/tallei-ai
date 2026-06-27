import assert from "node:assert/strict";
import test from "node:test";

import { parseSearchResponse } from "../../../../src/integrations/composio/playbook.js";

test("parseSearchResponse extracts tool schemas, related slugs, and pitfalls", () => {
  const parsed = parseSearchResponse({
    success: true,
    results: [{
      primaryToolSlugs: ["GMAIL_FETCH_EMAILS"],
      relatedToolSlugs: ["GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"],
    }],
    toolSchemas: {
      GMAIL_FETCH_EMAILS: {
        toolkit: "gmail",
        description: "List Gmail messages",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    },
    data: {
      pitfalls: ["Do not use id: in Gmail search query"],
      workflow_steps: ["List unread", "Draft reply"],
      session_id: "sess_abc",
    },
  });

  assert.equal(parsed.relatedSlugs.includes("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"), true);
  assert.equal(parsed.toolSchemas.GMAIL_FETCH_EMAILS?.description, "List Gmail messages");
  assert.match(parsed.pitfalls[0] ?? "", /id:/);
  assert.equal(parsed.workflowSteps.length, 2);
  assert.equal(parsed.sessionId, "sess_abc");
});
