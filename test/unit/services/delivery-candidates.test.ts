import assert from "node:assert/strict";
import test from "node:test";

import { compileLoopPlanningIR, loopPlanningIRSchema } from "../../../src/services/loop-engine/planning-ir.js";
import { buildComposioActionContract, getStaticToolContract } from "../../../src/services/tool-spec/tool-contracts.js";

const evidence = [{
  source: "tool_contract" as const,
  reference: "contract",
  explanation: "Declared from the exact contract.",
}];

function newsletterPlan(actionRef: string) {
  return loopPlanningIRSchema.parse({
    version: "v1",
    title: "Weekly brief",
    summary: "Draft and send a weekly brief.",
    strategy: "Research, draft, then execute the selected action.",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    decisions: [],
    requiredValues: [{
      key: "recipient",
      label: "Recipient",
      description: "Recipient for this run.",
      lifecycle: "runtime_input",
      timing: "before_action",
      sensitivity: "private",
      surface: "input.text",
      valueSchema: { type: "string" },
      allowedSourceKinds: ["operator_input"],
      status: "resolved",
      evidence,
    }],
    semanticAgents: [{
      id: "writer",
      name: "Writer",
      responsibility: "Produce the final message content.",
      goal: "Produce send-ready content.",
      task: "Write the brief.",
      toolRef: "internal.llm_only",
      inputContract: { description: "Workflow goal", schema: { type: "object" } },
      inputBindings: [],
      outputContract: {
        description: "Send-ready content",
        representation: "json",
        mediaType: "application/json",
        visibility: "operator",
        schema: {
          type: "object",
          properties: { subject: { type: "string" }, body: { type: "string" } },
          required: ["subject", "body"],
        },
      },
      doneCriteria: ["Content is complete."],
    }],
    selectedActions: [{
      id: "send",
      name: "Send",
      toolRef: actionRef,
      purpose: "Send the reviewed content.",
      stableConfig: {},
      annotation: {
        effect: "write_external",
        confidence: "high",
        approvalRequired: true,
        evidence,
        fieldPolicies: [
          { path: "/to", valuePolicy: "passthrough", required: true, allowedSourceKinds: ["operator_input"], evidence },
          { path: "/subject", valuePolicy: "derivable", required: true, allowedSourceKinds: ["agent_output"], evidence },
          { path: "/body", valuePolicy: "derivable", required: true, allowedSourceKinds: ["agent_output"], evidence },
        ],
      },
      bindings: [
        { source: { kind: "required_value", key: "recipient", path: "/" }, targetPath: "/to", required: true, valuePolicy: "passthrough", provenance: "operator_input" },
        { source: { kind: "agent_output", nodeId: "writer", path: "/subject" }, targetPath: "/subject", required: true, valuePolicy: "derivable", provenance: "agent_output" },
        { source: { kind: "agent_output", nodeId: "writer", path: "/body" }, targetPath: "/body", required: true, valuePolicy: "derivable", provenance: "agent_output" },
      ],
      doneCriteria: ["Provider reports success."],
    }],
    unresolvedIssues: [],
    rationale: [],
    suggestedChannels: ["primary"],
  });
}

test("planning compiler materializes direct bindings without formatter or coordinator agents", () => {
  const action = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const compiled = compileLoopPlanningIR({
    planningIR: newsletterPlan(action.toolRef),
    contracts: [getStaticToolContract("internal.llm_only")!, action],
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  assert.deepEqual(compiled.compiled.graph.children.map((node) => node.id), ["writer", "send"]);
  assert.equal(compiled.compiled.inputRequirements[0]?.key, "recipient");
  assert.equal(compiled.compiled.connectorPolicy.allowedWriteActions.length, 1);
});

test("planning compiler rejects an action with an unproven required identifier", () => {
  const action = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_DRAFT",
    risk: "send",
    inputSchema: { type: "object", properties: { draft_id: { type: "string" } }, required: ["draft_id"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const plan = newsletterPlan(action.toolRef);
  plan.selectedActions[0]!.bindings = [];
  plan.selectedActions[0]!.annotation.fieldPolicies = [];
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, action],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  assert.equal(compiled.issues.some((issue) => issue.code === "missing_required_binding"), true);
});

test("planning compiler rejects invented passthrough values", () => {
  const action = buildComposioActionContract({
    toolkit: "example",
    actionSlug: "EXAMPLE_WRITE",
    risk: "write",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });
  const plan = newsletterPlan(action.toolRef);
  plan.selectedActions[0]!.bindings = [{
    source: { kind: "agent_output", nodeId: "writer", path: "/body" },
    targetPath: "/body",
    required: true,
    valuePolicy: "passthrough",
    provenance: "agent_output",
  }];
  plan.selectedActions[0]!.annotation.fieldPolicies = [{
    path: "/body",
    valuePolicy: "passthrough",
    required: true,
    allowedSourceKinds: ["agent_output"],
    evidence,
  }];
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, action],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  assert.equal(compiled.issues.some((issue) => issue.code === "generated_passthrough"), true);
});

test("planning compiler permits a connector-only workflow without inventing a semantic agent", () => {
  const action = buildComposioActionContract({
    toolkit: "example",
    actionSlug: "EXAMPLE_LOOKUP",
    risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    outputSchema: { type: "object", properties: { result: { type: "string" } } },
  });
  const plan = newsletterPlan(action.toolRef);
  plan.semanticAgents = [];
  plan.requiredValues[0]!.key = "query";
  plan.requiredValues[0]!.label = "Query";
  plan.selectedActions[0]!.annotation = {
    effect: "read_external",
    confidence: "high",
    approvalRequired: false,
    evidence,
    semanticAssertions: [],
    fieldPolicies: [{
      path: "/query",
      valuePolicy: "passthrough",
      required: true,
      allowedSourceKinds: ["operator_input"],
      evidence,
    }],
  };
  plan.selectedActions[0]!.bindings = [{
    source: { kind: "required_value", key: "query", path: "/" },
    targetPath: "/query",
    required: true,
    valuePolicy: "passthrough",
    provenance: "operator_input",
  }];
  const compiled = compileLoopPlanningIR({ planningIR: plan, contracts: [action] });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  assert.deepEqual(compiled.compiled.graph.children.map((node) => node.id), ["send"]);
  assert.equal(compiled.compiled.connectorPolicy.allowedReadActions.length, 1);
});

test("planning compiler permits a final operator-visible semantic artifact without a connector consumer", () => {
  const plan = newsletterPlan("composio.gmail.action.gmail_send_email");
  plan.requiredValues = [];
  plan.selectedActions = [];
  plan.semanticAgents[0]!.inputContract = {
    description: "Research input",
    schema: {
      type: "object",
      properties: { research: { type: "string" } },
      required: ["research"],
    },
  };
  plan.semanticAgents[0]!.inputBindings = [{
    source: { kind: "agent_output", nodeId: "researcher", path: "/text" },
    targetPath: "/research",
    required: true,
    valuePolicy: "derivable",
    provenance: "agent_output",
  }];
  plan.semanticAgents.unshift({
    id: "researcher",
    name: "Researcher",
    responsibility: "Produce research.",
    goal: "Produce research.",
    task: "Research.",
    toolRef: "internal.llm_only",
    inputContract: { description: "Goal", schema: { type: "object" } },
    inputBindings: [],
    outputContract: {
      description: "Research",
      representation: "json",
      mediaType: "application/json",
      visibility: "internal",
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    doneCriteria: ["Research complete."],
  });
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!],
  });
  assert.equal(compiled.ok, true);
});
