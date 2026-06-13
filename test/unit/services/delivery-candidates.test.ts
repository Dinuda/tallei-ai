import assert from "node:assert/strict";
import test from "node:test";

import {
  compileLoopPlanningIR,
  loopPlanningIRSchema,
} from "../../../src/services/loop-engine/planning-ir.js";
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
        rendererRef: "canvas.email",
        reviewMode: "required",
        editable: true,
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
  assert.deepEqual(compiled.compiled.operatorInteractionPlan.interactions.map((item) => item.kind), [
    "collect_input",
    "review_artifact",
    "connect_connector",
    "confirm_action",
  ]);
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

test("planning compiler rejects an input surface that cannot collect the declared value type", () => {
  const action = buildComposioActionContract({
    toolkit: "example",
    actionSlug: "EXAMPLE_WRITE",
    risk: "write",
    inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    outputSchema: { type: "object", properties: {} },
  });
  const plan = newsletterPlan(action.toolRef);
  plan.requiredValues[0]!.surface = "input.contacts_csv";
  plan.requiredValues[0]!.valueType = "string";
  plan.selectedActions[0]!.bindings = [plan.selectedActions[0]!.bindings[0]!];
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, action],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  assert.equal(compiled.issues.some((issue) => issue.code === "input_surface_type_mismatch"), true);
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

test("planning compiler instructs planner to remove unused required values", () => {
  const plan = newsletterPlan("composio.gmail.action.gmail_send_email");
  plan.selectedActions = [];
  plan.semanticAgents[0]!.outputArtifact.visibility = "operator";
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  const issue = compiled.issues.find((candidate) => candidate.code === "unused_required_value");
  assert.match(issue?.message ?? "", /Remove it from requiredValues; do not invent a consumer/);
});

test("planning compiler reports text artifact bindings that need json fields", () => {
  const plan = newsletterPlan("composio.gmail.action.gmail_send_email");
  plan.semanticAgents[0]!.outputArtifact = {
    id: "writer_output",
    description: "Send-ready content",
    representation: "text",
    visibility: "operator",
    rendererRef: "canvas.email",
    reviewMode: "required",
    editable: true,
    fields: [],
  };
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
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, action],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  const issue = compiled.issues.find((candidate) => candidate.code === "text_artifact_needs_json_fields");
  assert.match(issue?.message ?? "", /explicit \/subject field/);
});

test("planning compiler rejects dot-notation connector output paths", () => {
  const createDraft = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_CREATE_EMAIL_DRAFT",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: { subject: { type: "string" }, body: { type: "string" } },
      required: ["subject", "body"],
    },
    outputSchema: {
      type: "object",
      properties: {
        data: { type: "object" },
        error: { type: "string" },
        successful: { type: "boolean" },
      },
    },
  });
  const sendDraft = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_DRAFT",
    risk: "send",
    inputSchema: { type: "object", properties: { draft_id: { type: "string" } }, required: ["draft_id"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const plan = newsletterPlan(createDraft.toolRef);
  plan.selectedActions = [
    {
      id: "create_gmail_draft",
      contractRef: createDraft.toolRef,
      purpose: "Create the Gmail draft.",
      annotation: { effect: "write_external", confidence: "high", approvalRequired: true },
      bindings: [
        { source: { kind: "agent_output", nodeId: "writer", path: "/subject" }, targetPath: "/subject", required: true, valuePolicy: "derivable", provenance: "agent_output" },
        { source: { kind: "agent_output", nodeId: "writer", path: "/body" }, targetPath: "/body", required: true, valuePolicy: "derivable", provenance: "agent_output" },
      ],
    },
    {
      id: "send_gmail_draft",
      contractRef: sendDraft.toolRef,
      purpose: "Send the created draft.",
      annotation: { effect: "irreversible_external", confidence: "high", approvalRequired: true },
      bindings: [{
        source: { kind: "connector_output", nodeId: "create_gmail_draft", path: "/data.response_data.draft_id" },
        targetPath: "/draft_id",
        required: true,
        valuePolicy: "passthrough",
        provenance: "connector_output",
      }],
    },
  ];
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, createDraft, sendDraft],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  const issue = compiled.issues.find((candidate) => candidate.code === "invalid_source_path_syntax");
  assert.match(issue?.message ?? "", /\/data\/response_data\/draft_id/);
});

test("planning compiler rejects undeclared nested connector output paths", () => {
  const createDraft = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_CREATE_EMAIL_DRAFT",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: { subject: { type: "string" }, body: { type: "string" } },
      required: ["subject", "body"],
    },
    outputSchema: {
      type: "object",
      properties: {
        data: { type: "object" },
        error: { type: "string" },
        successful: { type: "boolean" },
      },
    },
  });
  const sendDraft = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_DRAFT",
    risk: "send",
    inputSchema: { type: "object", properties: { draft_id: { type: "string" } }, required: ["draft_id"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const plan = newsletterPlan(createDraft.toolRef);
  plan.selectedActions = [
    {
      id: "create_gmail_draft",
      contractRef: createDraft.toolRef,
      purpose: "Create the Gmail draft.",
      annotation: { effect: "write_external", confidence: "high", approvalRequired: true },
      bindings: [
        { source: { kind: "agent_output", nodeId: "writer", path: "/subject" }, targetPath: "/subject", required: true, valuePolicy: "derivable", provenance: "agent_output" },
        { source: { kind: "agent_output", nodeId: "writer", path: "/body" }, targetPath: "/body", required: true, valuePolicy: "derivable", provenance: "agent_output" },
      ],
    },
    {
      id: "send_gmail_draft",
      contractRef: sendDraft.toolRef,
      purpose: "Send the created draft.",
      annotation: { effect: "irreversible_external", confidence: "high", approvalRequired: true },
      bindings: [{
        source: { kind: "connector_output", nodeId: "create_gmail_draft", path: "/data/response_data/draft_id" },
        targetPath: "/draft_id",
        required: true,
        valuePolicy: "passthrough",
        provenance: "connector_output",
      }],
    },
  ];
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, createDraft, sendDraft],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  const issue = compiled.issues.find((candidate) => candidate.code === "opaque_connector_output_path");
  assert.match(issue?.message ?? "", /only exposes: \/, \/data, \/error, \/successful/);
  assert.match(issue?.message ?? "", /single direct send action/);
});

test("planning compiler reports valid source paths for an invalid binding", () => {
  const plan = newsletterPlan("composio.gmail.action.gmail_send_email");
  plan.requiredValues = [];
  plan.selectedActions = [];
  plan.semanticAgents.push({
    id: "consumer",
    name: "Consumer",
    responsibility: "Consume the writer output.",
    task: "Consume the writer output.",
    toolRef: "internal.llm_only",
    inputBindings: [{
      source: { kind: "agent_output", nodeId: "writer", path: "/missing" },
      targetPath: "/newsletter",
      required: true,
      valuePolicy: "derivable",
      provenance: "agent_output",
    }],
    outputArtifact: {
      id: "consumer_output",
      description: "Final output",
      representation: "text",
      visibility: "operator",
      rendererRef: "canvas.preview",
      reviewMode: "none",
      editable: false,
      fields: [],
    },
  });
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  const issue = compiled.issues.find((candidate) => candidate.code === "unknown_source_path");
  assert.match(issue?.message ?? "", /Valid source paths for writer: \/, \/body, \/subject/);
});

test("planning compiler reports exact source and target types for incompatible bindings", () => {
  const action = buildComposioActionContract({
    toolkit: "example",
    actionSlug: "EXAMPLE_WRITE",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: { metadata: { type: "object", properties: {} } },
      required: ["metadata"],
    },
    outputSchema: { type: "object", properties: {} },
  });
  const plan = newsletterPlan(action.toolRef);
  plan.requiredValues = [];
  plan.selectedActions[0]!.bindings = [{
    source: { kind: "agent_output", nodeId: "writer", path: "/body" },
    targetPath: "/metadata",
    required: true,
    valuePolicy: "derivable",
    provenance: "agent_output",
  }];
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, action],
  });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  const issue = compiled.issues.find((candidate) => candidate.code === "incompatible_binding");
  assert.match(issue?.message ?? "", /source \/body is string, target \/metadata requires object/);
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

test("planning compiler rejects binding from connector node /input sub-path (connector_input_path_used_as_source)", () => {
  const sendEmail = buildComposioActionContract({
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
  const plan = newsletterPlan(sendEmail.toolRef);
  plan.selectedActions[0]!.bindings = [
    {
      source: { kind: "connector_output", nodeId: "orchestration_1", path: "/input/email_subject" },
      targetPath: "/subject",
      required: true,
      valuePolicy: "derivable",
      provenance: "agent_output",
    },
    {
      source: { kind: "connector_output", nodeId: "orchestration_1", path: "/input/email_body" },
      targetPath: "/body",
      required: true,
      valuePolicy: "derivable",
      provenance: "agent_output",
    },
  ];
  const compiled = compileLoopPlanningIR({ planningIR: plan, contracts: [sendEmail] });
  assert.equal(compiled.ok, false);
  if (compiled.ok) return;
  assert.ok(
    compiled.issues.some((i) => i.code === "connector_input_path_used_as_source"),
    `expected connector_input_path_used_as_source, got: ${compiled.issues.map((i) => i.code).join(", ")}`,
  );
});

test("planning compiler drops blocksApproval unresolved issues that describe runtime edge cases", () => {
  const sendEmail = buildComposioActionContract({
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
  const plan = newsletterPlan(sendEmail.toolRef);
  plan.unresolvedIssues = [{
    id: "news_zero_results",
    kind: "decision",
    message: "If the user's source_block_list eliminates all usable news sources for the 7-day window, News Research & Synthesis Agent may produce zero top stories. The runtime should instruct whether to (a) proceed with a brief 'no major stories' email, (b) expand date range, or (c) abort the send. The operator must resolve this at runtime before proceeding.",
    blocksApproval: true,
    relatedRef: null,
  }];
  const compiled = compileLoopPlanningIR({ planningIR: plan, contracts: [sendEmail] });
  assert.equal(
    compiled.ok === false && compiled.issues.some((i) => i.code.startsWith("unresolved_")),
    false,
    "runtime edge-case unresolved issue must not block compilation",
  );
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
      rendererRef: null,
      reviewMode: "none",
      editable: false,
      fields: [{ path: "/text", type: "string", required: true }],
    },
  });
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!],
  });
  assert.equal(compiled.ok, true);
});
