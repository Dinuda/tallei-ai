import assert from "node:assert/strict";
import test from "node:test";

import { compileLoopPlanningIR, loopPlanningIRSchema } from "../../../src/services/loop-engine/planning-ir.js";
import { buildComposioActionContract, getStaticToolContract } from "../../../src/services/tool-spec/tool-contracts.js";

function newsletterPlan(actionRef: string) {
  return loopPlanningIRSchema.parse({
    version: "v2",
    title: "Weekly brief",
    summary: "Draft and send a weekly brief.",
    strategy: "Research, draft, then execute the selected action.",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [{
      key: "recipient",
      label: "Recipient",
      description: "Recipient for this run.",
      lifecycle: "runtime_input",
      timing: "before_action",
      sensitivity: "private",
      surface: "input.text",
      valueType: "string",
      sourceKind: "operator_input",
      status: "resolved",
    }],
    semanticAgents: [{
      id: "writer",
      name: "Writer",
      responsibility: "Produce the final message content.",
      task: "Write the brief.",
      toolRef: "internal.llm_only",
      inputBindings: [],
      outputArtifact: {
        id: "writer_output",
        description: "Send-ready content",
        representation: "json",
        visibility: "operator",
        fields: [
          { path: "/subject", type: "string", required: true },
          { path: "/body", type: "string", required: true },
        ],
      },
    }],
    selectedActions: [{
      id: "send",
      contractRef: actionRef,
      purpose: "Send the reviewed content.",
      annotation: {
        effect: "write_external",
        confidence: "high",
        approvalRequired: true,
      },
      bindings: [
        { source: { kind: "required_value", key: "recipient", path: "/" }, targetPath: "/to", required: true, valuePolicy: "passthrough", provenance: "operator_input" },
        { source: { kind: "agent_output", nodeId: "writer", path: "/subject" }, targetPath: "/subject", required: true, valuePolicy: "derivable", provenance: "agent_output" },
        { source: { kind: "agent_output", nodeId: "writer", path: "/body" }, targetPath: "/body", required: true, valuePolicy: "derivable", provenance: "agent_output" },
      ],
    }],
    unresolvedIssues: [],
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
  assert.deepEqual(compiled.compiled.graph.children[0]?.outputContract?.schema, {
    type: "object",
    properties: {
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["subject", "body"],
    additionalProperties: false,
  });
});

test("planning compiler rejects connector references absent from the exact contract registry", () => {
  const plan = newsletterPlan("composio.gmail.action.invented_send");
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  assert.equal(compiled.issues.some((issue) => issue.code === "unknown_action"), true);
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

test("planning compiler normalizes runtime inputs marked unresolved when lifecycle is declared", () => {
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
  const plan = newsletterPlan(action.toolRef);
  plan.requiredValues[0]!.status = "unresolved";
  plan.unresolvedIssues = [{
    id: "runtime_inputs",
    kind: "required_value",
    message: "Recipient must be supplied at run_start.",
    blocksApproval: true,
    relatedRef: "recipient",
  }];
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, action],
  });
  assert.equal(compiled.ok, true);
});

test("planning compiler accepts number and integer binding types interchangeably", () => {
  const action = buildComposioActionContract({
    toolkit: "search",
    actionSlug: "SEARCH_LIMITED",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer" } },
      required: ["limit"],
    },
    outputSchema: { type: "object", properties: { items: { type: "array" } } },
  });
  const plan = newsletterPlan(action.toolRef);
  plan.semanticAgents = [];
  plan.requiredValues = [{
    key: "limit",
    label: "Limit",
    description: "Result limit",
    lifecycle: "workflow_config",
    timing: "run_start",
    sensitivity: "public",
    surface: "input.text",
    valueType: "number",
    sourceKind: "stable_config",
    status: "resolved",
    stableScalar: 5,
  }];
  plan.selectedActions[0]!.annotation = {
    effect: "read_external",
    confidence: "high",
    approvalRequired: false,
  };
  plan.selectedActions[0]!.bindings = [{
    source: { kind: "required_value", key: "limit", path: "/" },
    targetPath: "/limit",
    required: true,
    valuePolicy: "passthrough",
    provenance: "stable_config",
  }];
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [action],
  });
  assert.equal(compiled.ok, true);
});

test("planning compiler permits a final operator-visible semantic artifact without a connector consumer", () => {
  const plan = newsletterPlan("composio.gmail.action.gmail_send_email");
  plan.requiredValues = [];
  plan.selectedActions = [];
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
    task: "Research.",
    toolRef: "internal.llm_only",
    inputBindings: [],
    outputArtifact: {
      id: "researcher_output",
      description: "Research",
      representation: "json",
      visibility: "internal",
      fields: [{ path: "/text", type: "string", required: true }],
    },
  });
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!],
  });
  assert.equal(compiled.ok, true);
});
