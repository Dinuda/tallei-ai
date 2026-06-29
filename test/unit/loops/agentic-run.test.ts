import assert from "node:assert/strict";
import test from "node:test";

import { runAgenticLoop, type AgenticRunDeps } from "../../../src/loops/agentic-run.js";
import type { AuthContext } from "../../../src/domain/auth/index.js";
import type { CompiledPlan } from "../../../src/loops/spec.js";

const auth: AuthContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  scopes: [],
};

function plan(): CompiledPlan {
  const composioAction = {
    toolkit: "example",
    actionSlug: "EXAMPLE_APPLY_LABEL",
    label: "Apply label",
    inputInstructions: [{
      field: "message_id",
      required: true,
      sources: [
        { type: "trigger" as const, path: "message_id" },
        { type: "previous_action" as const, actionSlug: "EXAMPLE_QUERY", path: "messages.0.message_id" },
      ],
    }],
    outputInstructions: [],
    dependsOn: ["EXAMPLE_QUERY"],
  };

  return {
    id: "00000000-0000-4000-8000-000000000003",
    loopId: "00000000-0000-4000-8000-000000000002",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    specRevision: 1,
    revision: 1,
    contentHash: "hash",
    profile: "agentic",
    intent: { goal: "Label triggered item", outcome: "Item labeled", successCriteria: [] },
    trigger: { kind: "manual" },
    toolCatalog: [{
      id: "tool_example_apply_label",
      capability: "example.labels",
      connector: "example",
      actionSlug: "EXAMPLE_APPLY_LABEL",
      inputSchema: {
        type: "object",
        required: ["message_id"],
        properties: { message_id: { type: "string" } },
      },
      plannerCard: { summary: "Apply label", argGuides: {} },
      composioAction,
      sensitive: false,
      credentialRef: "acc-1",
    }],
    composioActions: [composioAction],
    connectorPlaybook: {
      compiledAt: new Date().toISOString(),
      useCase: "Item labeled",
    },
    agent: { instructions: "Label the triggered item.", maxSteps: 2, maxTokens: 8_000 },
    output: { kind: "none" },
    approval: { mode: "mixed", sensitiveCapabilities: [], defaultTimeoutHours: 24, onTimeout: "reject" },
    guardrails: { allowedTools: [], deniedTools: [], maxRetriesPerStep: 3, maxRunDurationMinutes: 60 },
    compiledAt: new Date().toISOString(),
    status: "draft",
  };
}

test("runAgenticLoop blocks unresolved required inputs before executing Composio", async () => {
  let executeCalls = 0;
  let deliveredSummary = "";
  const deps: AgenticRunDeps = {
    planner: async ({ state }) => state.stepIndex === 0
      ? {
          kind: "tool_call",
          toolId: "tool_example_apply_label",
          args: { thread_id: "thread-1", message_id: "planner-invented-message" },
          reasoning: "Try to label using a similar id.",
        }
      : { kind: "finish", summary: "Blocked: missing input source" },
    executeTool: async () => {
      executeCalls++;
      return { successful: true };
    },
    deliverOutput: async ({ summary }) => {
      deliveredSummary = summary;
    },
    failRun: async () => {},
    createApproval: async () => "approval-1",
    resolveApprovalExpired: async () => {},
    waitForApproval: async () => null,
  };

  const result = await runAgenticLoop({
    loopId: "00000000-0000-4000-8000-000000000002",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    tenantId: "tenant-1",
    userId: "user-1",
    compiledPlanId: "00000000-0000-4000-8000-000000000003",
    runId: "00000000-0000-4000-8000-000000000004",
    triggerKind: "event",
    eventPayload: { thread_id: "thread-1" },
  }, plan(), auth, deps);

  assert.equal(executeCalls, 0);
  assert.equal(result.status, "completed");
  assert.equal(deliveredSummary, "Blocked: missing input source");
});

test("runAgenticLoop blocks a redundant source call after its output contract is satisfied", async () => {
  const currentPlan = plan();
  currentPlan.agent = { ...currentPlan.agent!, maxSteps: 3 };
  currentPlan.toolCatalog[0] = {
    ...currentPlan.toolCatalog[0]!,
    outputSufficiencyPaths: ["items"],
  };
  let plannerCalls = 0;
  let executeCalls = 0;
  const deps: AgenticRunDeps = {
    planner: async () => {
      plannerCalls += 1;
      return plannerCalls <= 2
        ? { kind: "tool_call", toolId: "tool_example_apply_label", args: {}, reasoning: "Read source" }
        : { kind: "finish", summary: "Used existing output" };
    },
    executeTool: async () => {
      executeCalls += 1;
      return { successful: true, data: { items: [{ id: "item-1" }] } };
    },
    deliverOutput: async () => {},
    failRun: async () => {},
    createApproval: async () => "approval-1",
    resolveApprovalExpired: async () => {},
    waitForApproval: async () => null,
  };

  const result = await runAgenticLoop({
    loopId: currentPlan.loopId,
    workspaceId: currentPlan.workspaceId,
    tenantId: "tenant-1",
    userId: "user-1",
    compiledPlanId: currentPlan.id,
    runId: "00000000-0000-4000-8000-000000000005",
    triggerKind: "event",
    eventPayload: { message_id: "message-1" },
  }, currentPlan, auth, deps);

  assert.equal(result.status, "completed");
  assert.equal(executeCalls, 1);
});
