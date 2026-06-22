import assert from "node:assert/strict";
import test from "node:test";

import {
  agentGuardrailToolConflicts,
  validateAgentToolAssignments,
} from "../../../src/services/loop-builder/spec-available-tools.js";
import type { NoSlopSpec } from "../../../src/services/loop-engine/spec-contracts.js";

const buildContract = {
  version: "v1" as const,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  issues: [],
  requirements: [{
    id: "connector_selection",
    kind: "connector" as const,
    question: "Tools",
    reason: "Runtime",
    required: true,
    allowNone: false,
    valueSchema: {},
    status: "resolved" as const,
    value: {
      selections: [{
        toolkit: "gmail",
        accounts: [{ id: "00000000-0000-4000-8000-000000000001" }],
        actionSlugs: ["GMAIL_FETCH_EMAILS", "GMAIL_REPLY_TO_THREAD"],
      }],
    },
    validationErrors: [],
    warnings: [],
  }],
};

function supportSpec(): NoSlopSpec {
  return {
    purpose: "Support",
    agents: [{
      name: "Context Specialist",
      goal: "Classify tickets",
      tools: ["composio.gmail.action.GMAIL_FETCH_EMAILS", "composio.gmail.action.GMAIL_REPLY_TO_THREAD"],
      guardrails: ["Do not draft or send outbound messages."],
      doneWhen: ["Ticket classified"],
      failureModes: [],
    }],
    guardrails: [],
    successCriteria: [],
    failureModes: [],
    delivery: { provider: "gmail", description: "Gmail" },
    schedule: { description: "Hourly" },
    connectorPolicy: { allowedReadActions: [], allowedWriteActions: [] },
    inputRequirements: [],
  };
}

test("agentGuardrailToolConflicts flags delivery tools on context agents", () => {
  const issues = agentGuardrailToolConflicts(supportSpec());
  assert.ok(issues.some((issue) => /GMAIL_REPLY_TO_THREAD/.test(issue)));
});

test("validateAgentToolAssignments combines assignment and guardrail issues", () => {
  const issues = validateAgentToolAssignments(supportSpec(), buildContract);
  assert.ok(issues.length > 0);
  assert.ok(issues.some((issue) => /guardrails forbid outbound/i.test(issue)));
});
