import assert from "node:assert/strict";
import test from "node:test";

import {
  compileLoopPlanningIR,
  loopPlanningIRSchema,
  mergeCompiledInputRequirementsWithSpec,
  seedRequiredValuesFromSpec,
} from "../../../src/services/loop-engine/planning-ir.js";
import { buildComposioActionContract, getStaticToolContract } from "../../../src/services/tool-spec/tool-contracts.js";

test("seedRequiredValuesFromSpec maps operational inputs but skips review surfaces", () => {
  const seeded = seedRequiredValuesFromSpec([
    { key: "recipientList", surface: "input.contacts_csv", when: "run_start", required: true },
    { key: "approvalRequired", surface: "confirm.send", when: "run_start", required: true },
    { key: "draft", surface: "review.email", when: "before_send", required: true },
  ]);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]?.key, "recipientList");
  assert.equal(seeded[0]?.lifecycle, "runtime_input");
  assert.equal(seeded[0]?.valueType, "array");
  assert.equal(seeded[0]?.status, "resolved");
});

test("mergeCompiledInputRequirementsWithSpec unions spec and compiled requirements", () => {
  const merged = mergeCompiledInputRequirementsWithSpec({
    compiled: [{ key: "topic", surface: "input.text", when: "run_start", required: true }],
    specRequirements: [
      { key: "recipientList", surface: "input.contacts_csv", when: "run_start", required: true },
    ],
    context: { recipientKind: "uploaded", deliveryTarget: "gmail" },
  });
  assert.equal(merged.length, 2);
  assert.equal(merged.some((req) => req.key === "recipientList"), true);
  assert.equal(merged.some((req) => req.key === "topic"), true);
});

test("planning compiler upgrades primitive paths when later fields nest deeper", () => {
  const plan = loopPlanningIRSchema.parse({
    version: "v2",
    title: "Nested upgrade",
    summary: "Primitive then nested path.",
    strategy: "Test.",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [],
    semanticAgents: [{
      id: "writer",
      name: "Writer",
      responsibility: "Write.",
      task: "Write.",
      toolRef: "internal.llm_only",
      inputBindings: [],
      outputArtifact: {
        id: "draft",
        description: "Draft",
        representation: "json",
        visibility: "operator",
        rendererRef: null,
        reviewMode: "none",
        editable: false,
        fields: [
          { path: "/meta", type: "string", required: false },
          { path: "/meta/title", type: "string", required: true },
        ],
      },
    }],
    selectedActions: [],
    unresolvedIssues: [],
  });
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!],
  });
  assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify((compiled as { issues: unknown[] }).issues));
});

test("planning compiler builds artifact schemas for nested and indexed field paths", () => {
  const plan = loopPlanningIRSchema.parse({
    version: "v2",
    title: "Research brief",
    summary: "Compile nested artifact fields.",
    strategy: "Research.",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [],
    semanticAgents: [{
      id: "researcher",
      name: "Researcher",
      responsibility: "Research stories.",
      task: "Research.",
      toolRef: "internal.web_search",
      inputBindings: [],
      outputArtifact: {
        id: "research",
        description: "Research output",
        representation: "json",
        visibility: "internal",
        rendererRef: null,
        reviewMode: "none",
        editable: false,
        fields: [
          { path: "/summary", type: "string", required: true },
          { path: "/sources/0/url", type: "string", required: true },
          { path: "/sources/0/title", type: "string", required: false },
        ],
      },
    }, {
      id: "writer",
      name: "Writer",
      responsibility: "Write newsletter.",
      task: "Write.",
      toolRef: "internal.llm_only",
      inputBindings: [{
        source: { kind: "agent_output", nodeId: "researcher", path: "/summary" },
        targetPath: "/summary",
        required: true,
        valuePolicy: "derivable",
        provenance: "agent_output",
      }],
      outputArtifact: {
        id: "draft",
        description: "Draft",
        representation: "text",
        visibility: "operator",
        rendererRef: null,
        reviewMode: "none",
        editable: false,
        fields: [],
      },
    }],
    selectedActions: [],
    unresolvedIssues: [],
  });
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [
      getStaticToolContract("internal.web_search")!,
      getStaticToolContract("internal.llm_only")!,
    ],
  });
  assert.equal(compiled.ok, true);
});

test("planning compiler attaches draft_review gate when requested for content agent", () => {
  const send = buildComposioActionContract({
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
  const calendar = buildComposioActionContract({
    toolkit: "googlecalendar",
    actionSlug: "GOOGLECALENDAR_CREATE_EVENT",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string" }, start: { type: "string" } },
      required: ["summary", "start"],
    },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const plan = loopPlanningIRSchema.parse({
    version: "v2",
    title: "Weekly brief",
    summary: "Draft, send, and schedule.",
    strategy: "Research, draft, send, schedule.",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [{
      key: "recipientList",
      label: "Recipients",
      description: "Marketing recipients.",
      lifecycle: "runtime_input",
      timing: "before_action",
      sensitivity: "private",
      surface: "input.contacts_csv",
      valueType: "array",
      sourceKind: "operator_input",
      status: "resolved",
      stableScalar: null,
    }],
    semanticAgents: [
      {
        id: "writer",
        name: "Content Agent",
        responsibility: "Compose newsletter content.",
        task: "Write newsletter.",
        toolRef: "internal.llm_only",
        inputBindings: [],
        outputArtifact: {
          id: "draft",
          description: "Newsletter draft",
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
      },
    ],
    selectedActions: [
      {
        id: "send",
        contractRef: send.toolRef,
        purpose: "Send newsletter.",
        annotation: { effect: "write_external", confidence: "high", approvalRequired: true },
        bindings: [
          { source: { kind: "required_value", key: "recipientList", path: "/" }, targetPath: "/to", required: true, valuePolicy: "passthrough", provenance: "operator_input" },
          { source: { kind: "agent_output", nodeId: "writer", path: "/subject" }, targetPath: "/subject", required: true, valuePolicy: "derivable", provenance: "agent_output" },
          { source: { kind: "agent_output", nodeId: "writer", path: "/body" }, targetPath: "/body", required: true, valuePolicy: "derivable", provenance: "agent_output" },
        ],
      },
      {
        id: "schedule",
        contractRef: calendar.toolRef,
        purpose: "Create calendar invite.",
        annotation: { effect: "write_external", confidence: "high", approvalRequired: true },
        bindings: [
          { source: { kind: "agent_output", nodeId: "writer", path: "/subject" }, targetPath: "/summary", required: true, valuePolicy: "derivable", provenance: "agent_output" },
          { source: { kind: "required_value", key: "recipientList", path: "/" }, targetPath: "/start", required: true, valuePolicy: "passthrough", provenance: "operator_input" },
        ],
      },
    ],
    unresolvedIssues: [],
  });
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, send, calendar],
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  assert.deepEqual(compiled.compiled.graph.children.map((node) => node.id), ["writer", "send", "schedule"]);
  assert.equal(compiled.compiled.graph.children[0]?.gate?.type, "draft_review");
  assert.equal(compiled.compiled.connectorPolicy.allowedWriteActions.length, 2);
});
