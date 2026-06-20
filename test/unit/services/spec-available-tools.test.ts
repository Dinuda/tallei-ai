import assert from "node:assert/strict";
import test from "node:test";

import {
  agentToolAssignmentIssues,
  availableToolsForSpecDraft,
} from "../../../src/services/loop-builder/spec-available-tools.js";
import type { NoSlopSpec } from "../../../src/services/loop-engine/spec-contracts.js";

const buildContract = {
  version: "v1" as const,
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
  issues: [],
  requirements: [
    {
      id: "connector_selection",
      kind: "connector" as const,
      question: "Select tools",
      reason: "Runtime needs exact tool refs.",
      required: true,
      allowNone: false,
      valueSchema: {},
      status: "resolved" as const,
      value: {
        selections: [{
          toolkit: "exa",
          accounts: [{ id: "acc-1" }],
          actionSlugs: ["SEARCH", "SEND_EMAIL"],
        }],
      },
      validationErrors: [],
      warnings: [],
    },
  ],
};

test("availableToolsForSpecDraft synthesizes connector refs from build contract", () => {
  const tools = availableToolsForSpecDraft(buildContract, []);
  assert.ok(tools.some((tool) => tool.toolRef === "composio.exa.action.SEARCH"));
  assert.ok(tools.some((tool) => tool.toolRef === "composio.exa.action.SEND_EMAIL"));
});

test("agentToolAssignmentIssues rejects duplicate write tool ownership", () => {
  const spec = {
    purpose: "Test",
    agents: [
      {
        name: "Reader",
        goal: "Read",
        tools: ["composio.exa.action.SEARCH"],
        guardrails: [],
        doneWhen: [],
        failureModes: [],
      },
      {
        name: "Writer A",
        goal: "Send",
        tools: ["composio.exa.action.SEND_EMAIL"],
        guardrails: [],
        doneWhen: [],
        failureModes: [],
      },
      {
        name: "Writer B",
        goal: "Also send",
        tools: ["composio.exa.action.SEND_EMAIL"],
        guardrails: [],
        doneWhen: [],
        failureModes: [],
      },
    ],
    guardrails: [],
    successCriteria: [],
    failureModes: [],
    schedule: { description: "Weekly" },
    delivery: { provider: "none", description: "Dashboard only" },
    connectorPolicy: { allowedReadActions: [], allowedWriteActions: [] },
    inputRequirements: [],
  } satisfies NoSlopSpec;

  const available = availableToolsForSpecDraft(buildContract, []);
  const issues = agentToolAssignmentIssues(spec, available);
  assert.ok(issues.some((issue) => issue.includes("SEND_EMAIL")));
});
