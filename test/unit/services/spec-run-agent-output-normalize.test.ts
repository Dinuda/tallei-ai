import assert from "node:assert/strict";
import test from "node:test";

import {
  stripToSchema,
  validateContractData,
} from "../../../src/services/conductor/contracts/data-contract.js";
import {
  fallbackSourceEvidenceOutput,
  normalizeAgentStepOutput,
} from "../../../src/services/conductor/runtime/spec-run-agent-runner.js";

const evidenceSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ticket_found", "no_tickets_found"] },
    summary: { type: "string" },
    priority: { type: "string", enum: ["high", "medium", "low"] },
    ticket: {
      type: "object",
      properties: {
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["subject", "body"],
      additionalProperties: true,
    },
    customer: { type: "object", additionalProperties: true },
    findings: { type: "array", items: { type: "string" } },
    context: { type: "object", additionalProperties: true },
  },
  required: ["summary", "status"],
  allOf: [{
    if: {
      properties: { status: { const: "ticket_found" } },
      required: ["status"],
    },
    then: { required: ["ticket"] },
  }],
  additionalProperties: true,
};

function validateEvidence(output: unknown) {
  const normalized = normalizeAgentStepOutput(output, { artifactRole: "source_evidence" });
  const stripped = stripToSchema(evidenceSchema, normalized);
  return validateContractData(evidenceSchema, stripped);
}

test("normalizeAgentStepOutput unwraps JSON text fallback when finalizeAgent was skipped", () => {
  const payload = {
    summary: "Found a support ticket.",
    status: "ticket_found",
    ticket: { subject: "site down", body: "The site is unavailable." },
  };
  const result = validateEvidence({ text: JSON.stringify(payload) });
  assert.deepEqual(result, { valid: true });
});

test("normalizeAgentStepOutput unwraps double-nested output payloads", () => {
  const result = validateEvidence({
    output: {
      summary: "Found a support ticket.",
      status: "ticket_found",
      ticket: { subject: "site down", body: "The site is unavailable." },
    },
  });
  assert.deepEqual(result, { valid: true });
});

test("normalizeAgentStepOutput promotes ticket evidence from context", () => {
  const result = validateEvidence({
    summary: "Found a support ticket.",
    status: "ticket_found",
    context: {
      ticket: { subject: "site down", body: "The site is unavailable." },
      customer: { email: "customer@example.com" },
      priority: "high",
    },
  });
  assert.deepEqual(result, { valid: true });
});

test("fallbackSourceEvidenceOutput builds valid evidence from trigger context", () => {
  const output = fallbackSourceEvidenceOutput({
    workflowId: "workflow-1",
    trigger: { source: "connector", slug: "GMAIL_NEW_GMAIL_MESSAGE", toolkit: "gmail" },
    ticket: {
      subject: "site down",
      body: "Production site is unavailable.",
      threadId: "thread-1",
      messageId: "message-1",
    },
    customer: { email: "customer@example.com" },
    policies: {
      ticketContentMode: "email_body",
      customerDetailsMode: "sender_name_email",
      reviewMode: "review_drafts",
    },
    grounding: [],
    templates: [],
    connectorActionSlugs: [],
    connectorAccountIds: {},
    hasTriggerPayload: true,
  });

  assert.equal(output.status, "ticket_found");
  assert.equal(output.priority, "high");
  assert.deepEqual(validateEvidence(output), { valid: true });
});
