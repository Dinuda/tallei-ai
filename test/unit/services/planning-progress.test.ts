import assert from "node:assert/strict";
import test from "node:test";

import {
  contractsForPlannerCorrection,
  decodePlannerWireValue,
  planningAttemptStopReason,
  planningIssueFingerprint,
  planningProgressConfig,
  shouldRetryPlanningTransportFailure,
} from "../../../src/services/loop-engine/architect.js";
import { loopPlanningIRJsonSchema, loopPlanningIRSchema } from "../../../src/services/loop-engine/planning-ir.js";
import { buildComposioActionContract, getStaticToolContract } from "../../../src/services/tool-spec/tool-contracts.js";

const issue = (code: string, path: string) => ({ code, path, message: `${code} at ${path}` });

test("planning IR strict schema encodes free-form records without open additional properties", () => {
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
  assert.match(serialized, /user_prompt/);
  assert.match(serialized, /JSON-encoded value/);
  assert.doesNotMatch(serialized, /reviewedSpec/);
  assert.doesNotMatch(serialized, /"default":/);
});

test("planner wire decoder rejects malformed encoded schemas with exact paths", () => {
  const decoded = decodePlannerWireValue({
    semanticAgents: [{
      outputContract: {
        schema: "{\"type\":\"object\"",
      },
    }],
  });
  assert.equal(decoded.issues.length, 1);
  assert.equal(decoded.issues[0]?.code, "invalid_encoded_json");
  assert.equal(decoded.issues[0]?.path, "semanticAgents.0.outputContract.schema");
});

test("planner wire decoder converts valid encoded schemas into objects", () => {
  const decoded = decodePlannerWireValue({
    semanticAgents: [{
      outputContract: {
        schema: "{\"type\":\"object\",\"properties\":{}}",
      },
    }],
  });
  assert.deepEqual(decoded.issues, []);
  assert.deepEqual(
    (decoded.value as { semanticAgents: Array<{ outputContract: { schema: unknown } }> })
      .semanticAgents[0]?.outputContract.schema,
    { type: "object", properties: {} },
  );
});

test("planning progress configuration never permits more than two corrections", () => {
  const previous = process.env.TALLEI_LOOP_BUILDER__MAX_PLANNING_CORRECTIONS;
  process.env.TALLEI_LOOP_BUILDER__MAX_PLANNING_CORRECTIONS = "99";
  try {
    assert.equal(planningProgressConfig().maxCorrectionAttempts, 2);
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

test("targeted corrections retain every exact internal contract and only referenced connector contracts", () => {
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
    version: "v1",
    title: "Send",
    summary: "Send",
    strategy: "Send",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    decisions: [],
    requiredValues: [],
    semanticAgents: [],
    selectedActions: [{
      id: "send",
      name: "Send",
      toolRef: selected.toolRef,
      purpose: "Send",
      stableConfig: {},
      annotation: {
        effect: "write_external",
        confidence: "high",
        approvalRequired: true,
        evidence: [{ source: "tool_contract", reference: selected.toolRef, explanation: "Exact contract." }],
        semanticAssertions: [],
        fieldPolicies: [],
      },
      bindings: [],
      doneCriteria: ["Sent"],
    }],
    unresolvedIssues: [],
    rationale: [],
    suggestedChannels: ["primary"],
  });
  const internalContracts = [getStaticToolContract("internal.llm_only")!, getStaticToolContract("internal.web_search")!];
  assert.deepEqual(
    contractsForPlannerCorrection({
      previousIR,
      internalContracts,
      connectorContracts: [selected, unrelated],
    }).map((contract) => contract.toolRef),
    [...internalContracts.map((contract) => contract.toolRef), selected.toolRef],
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
