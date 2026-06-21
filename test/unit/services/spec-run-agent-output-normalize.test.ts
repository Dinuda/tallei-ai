import assert from "node:assert/strict";
import test from "node:test";

import {
  stripToSchema,
  validateContractData,
} from "../../../src/services/loop-engine/data-contract.js";
import { normalizeAgentStepOutput } from "../../../src/services/loop-runtime/spec-run-agent-runner.js";

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
