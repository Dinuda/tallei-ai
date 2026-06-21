import assert from "node:assert/strict";
import test from "node:test";

import type { RunContext } from "../../../src/services/loop-runtime/build-run-context.js";
import {
  enrichEvidenceStructuredOutput,
  enrichResolvedHandoffValue,
} from "../../../src/services/loop-runtime/spec-run-handoff-enrichment.js";

const runContext: RunContext = {
  workflowId: "workflow-1",
  trigger: { source: "connector", slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: "gmail" },
  ticket: {
    subject: "site down",
    body: "The site seems down.",
    threadId: "thread-1",
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

test("enrichEvidenceStructuredOutput fills ticket and customer from trigger context", () => {
  const enriched = enrichEvidenceStructuredOutput(runContext, {
    summary: "Customer reports site outage.",
    priority: "high",
  });

  assert.equal(enriched.summary, "Customer reports site outage.");
  assert.deepEqual(enriched.ticket, {
    subject: "site down",
    body: "The site seems down.",
    threadId: "thread-1",
    messageId: "msg-1",
  });
  assert.deepEqual(enriched.customer, { name: "Dinuda", email: "claude@example.com" });
});

test("enrichResolvedHandoffValue upgrades summary-only upstream evidence", () => {
  const enriched = enrichResolvedHandoffValue(runContext, {
    summary: "Only a summary was finalized.",
  });

  assert.equal(enriched.summary, "Only a summary was finalized.");
  assert.equal((enriched.ticket as { subject: string }).subject, "site down");
  assert.equal((enriched.customer as { email: string }).email, "claude@example.com");
});
