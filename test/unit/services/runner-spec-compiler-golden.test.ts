import assert from "node:assert/strict";
import test from "node:test";

import { buildRunnerSpecFromBuildContract } from "../../../src/services/loop-builder/specs.js";
import { compileSpecRunPlan } from "../../../src/services/loop-runtime/spec-run-plan.js";
import { definitionFromApprovedSpec } from "../../../src/services/loop-runtime/spec-run-types.js";
import type { NoSlopSpec } from "../../../src/services/loop-engine/spec-contracts.js";
import type { ToolContract } from "../../../src/services/tool-spec/types.js";

const accountId = "00000000-0000-4000-8000-000000000001";

function contract(actionSlug: string, effect: ToolContract["effect"], tags: ToolContract["skillTags"] = []): ToolContract {
  return {
    toolRef: `composio.gmail.action.${actionSlug}`,
    provider: "composio",
    name: actionSlug.replace(/_/g, " "),
    description: `Run ${actionSlug}`,
    skillTags: tags,
    effect,
    resources: ["gmail"],
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    executionMode: effect === "read_external" ? "short_circuit" : "approval_executed",
    approval: { required: effect !== "read_external" },
    renderRecommendations: tags.includes("draft")
      ? [{ target: "canvas.email", reason: "Draft review", strength: "strong" }]
      : [],
    constraints: { toolkit: "gmail", actionSlug, connected: true },
    source: "composio_sdk",
  };
}

function buildContract(
  reviewMode: "draft_only" | "approve_each_action" | "approve_batch" = "approve_each_action",
  gatesMode: "automatic" | "review_drafts" | "review_drafts_and_send" = "review_drafts",
) {
  return {
    version: "v1" as const,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
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
            toolkit: "gmail",
            accounts: [{ id: accountId }],
            actionSlugs: ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_EMAIL"],
          }],
        },
        validationErrors: [],
        warnings: [],
      },
      {
        id: "trigger_schedule",
        kind: "trigger_schedule" as const,
        question: "Schedule",
        reason: "Trigger",
        required: true,
        allowNone: false,
        valueSchema: {},
        status: "resolved" as const,
        value: { trigger: "event", toolkit: "gmail", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
        validationErrors: [],
        warnings: [],
      },
      {
        id: "artifact_contract",
        kind: "artifact_contract" as const,
        question: "Artifact",
        reason: "Email draft",
        required: true,
        allowNone: false,
        valueSchema: {},
        status: "resolved" as const,
        value: {
          mode: "supplied_template",
          template: JSON.stringify({
            templates: [{
              id: "ack",
              name: "Acknowledgment",
              subject: "Re: {{subject}}",
              html: "<p>Thanks</p>",
            }],
          }),
        },
        validationErrors: [],
        warnings: [],
      },
      {
        id: "review_policy",
        kind: "review_policy" as const,
        question: "Review policy",
        reason: "Approval",
        required: true,
        allowNone: false,
        valueSchema: {},
        status: "resolved" as const,
        value: { mode: reviewMode },
        validationErrors: [],
        warnings: [],
      },
      {
        id: "output_review_gates",
        kind: "output_review_gates" as const,
        question: "Output review gates",
        reason: "Opt-in pauses",
        required: true,
        allowNone: false,
        valueSchema: {},
        status: "resolved" as const,
        value: { mode: gatesMode },
        validationErrors: [],
        warnings: [],
      },
    ],
  };
}

function summarizeAgents(spec: NoSlopSpec) {
  return spec.agents.map((agent) => ({
    name: agent.name,
    tools: agent.tools,
    gate: agent.gate ?? null,
    renderer: agent.outputContract.renderer ?? null,
  }));
}

const gmailContracts = [
  contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
  contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft", "create"]),
  contract("GMAIL_SEND_EMAIL", "irreversible_external", ["send"]),
];

test("golden: approve_each_action with review_drafts produces stable agent graph", () => {
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: gmailContracts,
  });

  assert.deepEqual(summarizeAgents(spec), [
    {
      name: "Workflow Agent",
      tools: [
        "composio.gmail.action.GMAIL_FETCH_EMAILS",
        "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT",
        "composio.gmail.action.GMAIL_SEND_EMAIL",
        "internal.llm_only",
      ],
      gate: null,
      renderer: "canvas.email",
    },
  ]);
});

test("golden: draft_only still uses architect-owned fallback agent", () => {
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract("draft_only"),
    discoveredToolContracts: gmailContracts,
  });

  assert.equal(spec.agents.length, 1);
  assert.deepEqual(summarizeAgents(spec), [
    {
      name: "Workflow Agent",
      tools: [
        "composio.gmail.action.GMAIL_FETCH_EMAILS",
        "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT",
        "composio.gmail.action.GMAIL_SEND_EMAIL",
        "internal.llm_only",
      ],
      gate: null,
      renderer: "canvas.email",
    },
  ]);
});

test("golden: review_drafts_and_send does not add compiler-owned gates", () => {
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract("approve_each_action", "review_drafts_and_send"),
    discoveredToolContracts: gmailContracts,
  });

  assert.equal(spec.agents.length, 1);
  assert.equal(spec.agents[0]?.gate, undefined);
});

test("golden: automatic output gates produces no agent gates", () => {
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract("approve_each_action", "automatic"),
    discoveredToolContracts: gmailContracts,
  });

  assert.ok(spec.agents.every((agent) => !agent.gate));
});

test("compiler to plan parity preserves tool role decisions", () => {
  const build = buildContract();
  const discovered = gmailContracts;
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: build,
    discoveredToolContracts: discovered,
  });
  const snapshot = {
    id: "00000000-0000-4000-8000-000000000010",
    slug: "support",
    title: "Support",
    version: 1,
    bodyMarkdown: "",
    approvedAt: "2026-06-20T00:00:00.000Z",
    buildContract: build,
    specJson: spec,
  };
  const definition = definitionFromApprovedSpec({
    snapshot,
    buildContract: build,
    discoveredToolContracts: discovered,
    cron: "0 * * * *",
    timezone: "UTC",
  });
  const plan = compileSpecRunPlan(definition);

  assert.deepEqual(plan.readTools.map((tool) => tool.actionSlug), ["GMAIL_FETCH_EMAILS"]);
  assert.deepEqual(
    plan.writeTools.map((tool) => tool.actionSlug).sort(),
    ["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_EMAIL"].sort(),
  );
  assert.deepEqual(
    plan.agents.map((agent) => ({
      name: agent.name,
      toolRefs: agent.toolRefs.filter((ref) => ref.startsWith("composio.")),
      gate: agent.gate ?? null,
    })),
    [
      {
        name: "Workflow Agent",
        toolRefs: [
          "composio.gmail.action.GMAIL_FETCH_EMAILS",
          "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT",
          "composio.gmail.action.GMAIL_SEND_EMAIL",
        ],
        gate: null,
      },
    ],
  );
});
