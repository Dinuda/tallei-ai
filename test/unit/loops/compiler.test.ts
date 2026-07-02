import assert from "node:assert/strict";
import test from "node:test";

import { scoreOutcomeRelevance } from "../../../src/loops/binding-discovery.js";
import { isToolApprovalSensitive } from "../../../src/loops/compiler.js";
import { buildExecutionStrategy } from "../../../src/loops/execution-strategy.js";
import type { LoopSpec, ResolvedTool } from "../../../src/loops/spec.js";

test("scoreOutcomeRelevance ranks matching action slugs by outcome word overlap", () => {
  const score = scoreOutcomeRelevance(
    "send message to slack channel",
    "SLACK_SEND_MESSAGE",
    "Send message",
    "Post a message to a Slack channel",
  );
  assert.ok(score >= 2);
});

test("scoreOutcomeRelevance returns zero for unrelated outcomes", () => {
  assert.equal(
    scoreOutcomeRelevance("payment charge", "GMAIL_FETCH_EMAILS", "Fetch emails", "List messages"),
    0,
  );
});

test("compiler marks destination tools sensitive from role-based approval", () => {
  const approval = {
    mode: "mixed" as const,
    sensitiveRoles: ["destination" as const],
    sensitiveCapabilities: [],
  };

  assert.equal(isToolApprovalSensitive(approval, {
    capability: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    role: "source",
  }), false);
  assert.equal(isToolApprovalSensitive(approval, {
    capability: "GMAIL_SEND_EMAIL",
    role: "destination",
  }), true);
});

function strategySpec(): LoopSpec {
  return {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    intent: { goal: "Handle support mail", outcome: "Reply sent", successCriteria: [] },
    trigger: { kind: "event", source: "gmail", eventType: "new_mail", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
    profile: "agentic",
    bindings: [],
    composioActions: [],
    taskBlueprint: {
      version: 1,
      summary: "Handle support mail",
      outcomes: [
        { id: "incoming", role: "source", description: "Read incoming email", selectedConnector: "gmail", status: "chosen" },
        { id: "draft", role: "transform", description: "Draft a useful response", status: "chosen" },
        { id: "send", role: "destination", description: "Send response", selectedConnector: "gmail", status: "chosen" },
      ],
    },
    intentDiscovery: { status: "confirmed", decisions: [], assumptions: [], askedQuestionIds: [] },
    agent: { instructions: "Handle the message", maxSteps: 12, maxTokens: 8000 },
    output: { kind: "none" },
    approval: { mode: "mixed", sensitiveRoles: ["destination"], sensitiveCapabilities: [], defaultTimeoutHours: 24, onTimeout: "reject" },
    guardrails: { allowedTools: [], deniedTools: [], maxRetriesPerStep: 3, maxRunDurationMinutes: 60 },
  };
}

const destinationTool = {
  id: "tool_gmail_send",
  capability: "email.send",
  connector: "gmail",
  actionSlug: "GMAIL_SEND_EMAIL",
  inputSchema: { type: "object", properties: {} },
  plannerCard: { summary: "Send email", argGuides: {} },
  sensitive: true,
  credentialRef: "account-1",
  role: "destination" as const,
} satisfies ResolvedTool;

test("execution strategy uses event payload instead of refetching the trigger source", () => {
  const strategy = buildExecutionStrategy(strategySpec(), [destinationTool]);
  assert.equal(strategy.mode, "hybrid");
  assert.deepEqual(strategy.steps.map((step) => step.kind), ["transform", "tool"]);
  assert.equal(strategy.steps.some((step) => step.role === "source"), false);
  assert.equal(strategy.steps[1]?.requiresApproval, true);
});

test("execution strategy falls back to agentic when a required bound tool is absent", () => {
  const spec = strategySpec();
  spec.trigger = { kind: "manual" };
  assert.equal(buildExecutionStrategy(spec, [destinationTool]).mode, "agentic");
});
