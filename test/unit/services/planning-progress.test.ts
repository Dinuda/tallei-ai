import assert from "node:assert/strict";
import test from "node:test";

import {
  contractsForPlannerCorrection,
  compactPlannerContracts,
  planningAttemptStopReason,
  planningIssueFingerprint,
  planningProgressConfig,
  shouldRetryPlanningTransportFailure,
} from "../../../src/services/loop-engine/architect.js";
import {
  loopPlanningIRJsonSchema,
  loopPlanningIRJsonSchemaForContracts,
  loopPlanningIRSchema,
} from "../../../src/services/loop-engine/planning-ir.js";
import { buildComposioActionContract, getStaticToolContract } from "../../../src/services/tool-spec/tool-contracts.js";

const issue = (code: string, path: string) => ({ code, path, message: `${code} at ${path}` });

test("planning IR v2 strict schema contains no arbitrary objects or encoded JSON", () => {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    assert.notEqual(
      typeof row.additionalProperties,
      "object",
      "strict planner schema must not expose arbitrary object properties",
    );
    if (row.type === "object" && row.properties && typeof row.properties === "object") {
      assert.equal(row.additionalProperties, false, "strict planner objects must reject undeclared properties");
      assert.deepEqual(
        new Set(Array.isArray(row.required) ? row.required : []),
        new Set(Object.keys(row.properties as Record<string, unknown>)),
        "strict planner objects must require every declared property",
      );
    }
    Object.values(row).forEach(visit);
  };

  visit(loopPlanningIRJsonSchema);
  const serialized = JSON.stringify(loopPlanningIRJsonSchema);
  assert.doesNotMatch(serialized, /JSON-encoded value/);
  assert.doesNotMatch(serialized, /inputSchema|outputSchema|stableConfig|valueSchema/);
  assert.ok(Buffer.byteLength(serialized) < 8_000);
  assert.doesNotMatch(serialized, /reviewedSpec/);
  assert.doesNotMatch(serialized, /"default":/);
});

test("planning IR v2 accepts explicit null only for genuinely nullable fields", () => {
  const parsed = loopPlanningIRSchema.parse({
    version: "v2",
    title: "Draft",
    summary: "Draft content",
    strategy: "Draft content",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [{
      key: "topic",
      label: "Topic",
      description: "Topic supplied for each run",
      lifecycle: "runtime_input",
      timing: "run_start",
      sensitivity: "public",
      valueType: "string",
      surface: "input.text",
      sourceKind: "operator_input",
      status: "resolved",
      stableScalar: null,
    }],
    semanticAgents: [{
      id: "writer",
      name: "Writer",
      responsibility: "Write content",
      task: "Write content",
      toolRef: "internal.llm_only",
      inputBindings: [{
        source: { kind: "required_value", key: "topic", path: "/" },
        targetPath: "/topic",
        required: true,
        valuePolicy: "passthrough",
        provenance: "operator_input",
      }],
      outputArtifact: {
        id: "draft",
        description: "Draft",
        representation: "text",
        visibility: "operator",
        rendererRef: null,
        reviewMode: "required",
        editable: true,
        fields: [],
      },
    }],
    selectedActions: [],
    unresolvedIssues: [{
      id: "connector",
      kind: "action",
      message: "No action selected",
      blocksApproval: false,
      relatedRef: null,
    }],
  });
  assert.equal(parsed.requiredValues[0]?.stableScalar, null);
  assert.equal(parsed.semanticAgents[0]?.inputBindings[0]?.source.kind, "required_value");
  assert.equal(parsed.unresolvedIssues[0]?.relatedRef, null);
});

test("planner schema scopes semantic and connector references to loaded contracts", () => {
  const schema = loopPlanningIRJsonSchemaForContracts({
    internalToolRefs: ["internal.llm_only", "internal.web_search"],
    connectorContractRefs: ["composio.gmail.action.gmail_send_email"],
  }) as any;
  const arrayVariant = (value: any) => value.type === "array"
    ? value
    : value.anyOf.find((entry: any) => entry.type === "array");
  const semanticItems = arrayVariant(schema.properties.semanticAgents).items;
  const actionItems = arrayVariant(schema.properties.selectedActions).items;
  assert.deepEqual(semanticItems.properties.toolRef.enum, ["internal.llm_only", "internal.web_search"]);
  assert.deepEqual(actionItems.properties.contractRef.enum, ["composio.gmail.action.gmail_send_email"]);
});

test("planner schema forbids connector actions when discovery returns no contracts", () => {
  const schema = loopPlanningIRJsonSchemaForContracts({
    internalToolRefs: ["internal.llm_only"],
    connectorContractRefs: [],
  }) as any;
  const selectedActions = schema.properties.selectedActions.type === "array"
    ? schema.properties.selectedActions
    : schema.properties.selectedActions.anyOf.find((entry: any) => entry.type === "array");
  assert.equal(selectedActions.maxItems, 0);
});

test("planner bindings cannot reference an undeclared stable configuration object", () => {
  const result = loopPlanningIRSchema.safeParse({
    version: "v2",
    title: "Draft",
    summary: "Draft",
    strategy: "Draft",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [],
    semanticAgents: [{
      id: "writer",
      name: "Writer",
      responsibility: "Write",
      task: "Write",
      toolRef: "internal.llm_only",
      inputBindings: [{
        source: { kind: "stable_config", path: "/default_topic" },
        targetPath: "/topic",
        required: true,
        valuePolicy: "passthrough",
        provenance: "stable_config",
      }],
      outputArtifact: {
        id: "draft",
        description: "Draft",
        representation: "text",
        visibility: "operator",
        rendererRef: null,
        reviewMode: "required",
        editable: true,
        fields: [],
      },
    }],
    selectedActions: [],
    unresolvedIssues: [],
  });
  assert.equal(result.success, false);
});

test("planner required values cannot model approval or review interactions as data", () => {
  const plan = loopPlanningIRSchema.safeParse({
    version: "v2",
    title: "Approval as data",
    summary: "Invalid approval value.",
    strategy: "Invalid.",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [{
      key: "approvalConfirmed",
      label: "Approval",
      description: "Approval state.",
      lifecycle: "runtime_input",
      timing: "before_action",
      sensitivity: "public",
      valueType: "boolean",
      surface: "confirm.send",
      sourceKind: "operator_input",
      status: "resolved",
      stableScalar: null,
    }],
    semanticAgents: [],
    selectedActions: [],
    unresolvedIssues: [],
  });
  assert.equal(plan.success, false);
});

test("compact planner contracts expose references and field summaries without exact schemas", () => {
  const contract = getStaticToolContract("internal.web_search")!;
  const [view] = compactPlannerContracts([contract]);
  assert.equal(view?.contractRef, contract.toolRef);
  assert.equal("inputSchema" in (view ?? {}), false);
  assert.equal("outputSchema" in (view ?? {}), false);
  assert.equal(view?.inputFields.some((field) => field.path === "/query"), true);
});

test("planning progress configuration never permits more than one correction", () => {
  const previous = process.env.TALLEI_LOOP_BUILDER__MAX_PLANNING_CORRECTIONS;
  process.env.TALLEI_LOOP_BUILDER__MAX_PLANNING_CORRECTIONS = "99";
  try {
    assert.equal(planningProgressConfig().maxCorrectionAttempts, 1);
  } finally {
    if (previous === undefined) delete process.env.TALLEI_LOOP_BUILDER__MAX_PLANNING_CORRECTIONS;
    else process.env.TALLEI_LOOP_BUILDER__MAX_PLANNING_CORRECTIONS = previous;
  }
});

test("planner retries one transport failure but never retries structural output failures", () => {
  assert.equal(shouldRetryPlanningTransportFailure({
    structuralFailure: false,
    attempt: 0,
    maxPlanningAttempts: 3,
    transportFailures: 0,
  }), true);
  assert.equal(shouldRetryPlanningTransportFailure({
    structuralFailure: false,
    attempt: 1,
    maxPlanningAttempts: 3,
    transportFailures: 1,
  }), false);
  assert.equal(shouldRetryPlanningTransportFailure({
    structuralFailure: true,
    attempt: 0,
    maxPlanningAttempts: 3,
    transportFailures: 0,
  }), false);
});

test("targeted corrections retain every exact internal and discovered connector contract", () => {
  const selected = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
    inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const unrelated = buildComposioActionContract({
    toolkit: "calendar",
    actionSlug: "CALENDAR_CREATE_EVENT",
    risk: "write",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const previousIR = loopPlanningIRSchema.parse({
    version: "v2",
    title: "Send",
    summary: "Send",
    strategy: "Send",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [],
    semanticAgents: [],
    selectedActions: [{
      id: "send",
      contractRef: selected.toolRef,
      purpose: "Send",
      annotation: {
        effect: "write_external",
        confidence: "high",
        approvalRequired: true,
      },
      bindings: [],
    }],
    unresolvedIssues: [],
  });
  const internalContracts = [getStaticToolContract("internal.llm_only")!, getStaticToolContract("internal.web_search")!];
  assert.deepEqual(
    contractsForPlannerCorrection({
      previousIR,
      internalContracts,
      connectorContracts: [selected, unrelated],
    }).map((contract) => contract.toolRef),
    [...internalContracts.map((contract) => contract.toolRef), selected.toolRef, unrelated.toolRef],
  );
});

test("planning issue fingerprints are stable across ordering and messages", () => {
  const first = [issue("unknown_action", "send"), issue("missing_binding", "send./to")];
  const second = [
    { ...issue("missing_binding", "send./to"), message: "different wording" },
    issue("unknown_action", "send"),
  ];
  assert.equal(planningIssueFingerprint(first), planningIssueFingerprint(second));
});

test("planning attempts stop when correction issues repeat", () => {
  const issues = [issue("unknown_action", "send")];
  assert.equal(planningAttemptStopReason({
    previousIssues: issues,
    currentIssues: issues,
    correction: true,
    lastAttempt: false,
  }), "repeated_issues");
});

test("planning attempts stop when a correction only introduces more issues", () => {
  assert.equal(planningAttemptStopReason({
    previousIssues: [issue("unknown_action", "send")],
    currentIssues: [
      issue("unknown_action", "send"),
      issue("missing_binding", "send./to"),
    ],
    correction: true,
    lastAttempt: false,
  }), "worsened");
});

test("planning attempts allow a correction that resolves at least one issue", () => {
  assert.equal(planningAttemptStopReason({
    previousIssues: [
      issue("unknown_action", "send"),
      issue("missing_binding", "send./to"),
    ],
    currentIssues: [issue("missing_binding", "send./subject")],
    correction: true,
    lastAttempt: false,
  }), undefined);
});
