import assert from "node:assert/strict";
import test from "node:test";

import { compileSpecRunPlan, declaredAgentToolRefs } from "../../../src/services/loop-runtime/spec-run-plan.js";
import type { RunnableSpec } from "../../../src/services/loop-runtime/spec-run-types.js";
import type { ToolContract } from "../../../src/services/tool-spec/types.js";

const accountId = "00000000-0000-4000-8000-000000000001";

function contract(actionSlug: string, effect: ToolContract["effect"], tags: ToolContract["skillTags"] = []): ToolContract {
  return {
    toolRef: `composio.mail.action.${actionSlug}`,
    provider: "composio",
    name: actionSlug.replace(/_/g, " "),
    description: `Run ${actionSlug}`,
    skillTags: tags,
    effect,
    resources: ["mail"],
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    executionMode: effect === "read_external" ? "short_circuit" : "approval_executed",
    approval: { required: effect !== "read_external" },
    renderRecommendations: tags.includes("draft")
      ? [{ target: "canvas.email", reason: "Draft review", strength: "strong" }]
      : [],
    constraints: { toolkit: "mail", actionSlug, connected: true },
    source: "composio_sdk",
  };
}

function buildSpec(reviewMode: "draft_only" | "approve_each_action" = "approve_each_action"): RunnableSpec {
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
            toolkit: "mail",
            accounts: [{ id: accountId }],
            actionSlugs: ["READ_TICKETS", "CREATE_DRAFT", "SEND_MESSAGE"],
          }],
        },
        validationErrors: [],
        warnings: [],
      },
      {
        id: "grounding",
        kind: "grounding" as const,
        question: "Grounding",
        reason: "Search context.",
        required: true,
        allowNone: true,
        valueSchema: {},
        status: "resolved" as const,
        value: {
          mode: "sources",
          sources: [{ type: "workspace_memory" }],
          externalDataToolkits: ["crm"],
        },
        validationErrors: [],
        warnings: [],
      },
      {
        id: "review_policy",
        kind: "review_policy" as const,
        question: "Review policy",
        reason: "External writes need approval.",
        required: true,
        allowNone: false,
        valueSchema: {},
        status: "resolved" as const,
        value: { mode: reviewMode },
        validationErrors: [],
        warnings: [],
      },
    ],
  };

  return {
    version: "v1",
    goal: "Monitor support and draft replies",
    title: "Support monitor",
    schedule: { cron: "0 * * * *", timezone: "UTC" },
    buildContract,
    discoveredToolContracts: [
      contract("READ_TICKETS", "read_external", ["retrieve"]),
      contract("CREATE_DRAFT", "write_external", ["draft", "create"]),
      contract("SEND_MESSAGE", "irreversible_external", ["send"]),
    ],
    artifacts: {
      mode: "approved_generated_structure",
      templates: [],
      structure: "Priority and draft reply",
    },
    noSlopSpec: {
      id: "spec-1",
      slug: "support-monitor",
      title: "Support monitor",
      version: 1,
      bodyMarkdown: "",
      approvedAt: "2026-06-18T00:00:00.000Z",
      buildContract,
      specJson: {
        purpose: "Monitor support and draft replies",
        agents: [
          {
            name: "Context Reader",
            goal: "Read context, search history, and collect source facts.",
            tools: ["internal.memory_search", "composio.crm.search", "composio.mail.action.READ_TICKETS"],
            guardrails: [],
            doneWhen: ["Ticket context is ready."],
            failureModes: [],
          },
          {
            name: "Draft Writer",
            goal: "Draft reply, create the draft artifact, and request approval for writes.",
            tools: ["composio.mail.action.CREATE_DRAFT", "composio.mail.action.SEND_MESSAGE"],
            guardrails: ["Do not send directly."],
            doneWhen: ["Draft is ready for review."],
            failureModes: [],
          },
        ],
        guardrails: [],
        successCriteria: [],
        failureModes: [],
        delivery: { provider: "mail", description: "Create reviewed replies." },
        schedule: { description: "Hourly" },
        connectorPolicy: { allowedReadActions: [], allowedWriteActions: [] },
        inputRequirements: [
          { key: "team_tone", surface: "input.text", label: "Tone", required: true, when: "run_start" },
          { key: "draft_review", surface: "review.email", required: true, when: "before_send" },
          { key: "source_review", surface: "review.sources", required: true, when: "before_step" },
        ],
        buildContract,
      },
    },
  };
}

test("compileSpecRunPlan materializes ordered agents, scoped tool refs, and review surfaces", () => {
  const plan = compileSpecRunPlan(buildSpec());

  assert.deepEqual(plan.agents.map((agent) => agent.name), ["Context Reader", "Draft Writer"]);
  assert.equal(plan.readTools.length, 1);
  assert.equal(plan.writeTools.length, 2);
  assert.equal(plan.writeTools.find((entry) => entry.actionSlug === "SEND_MESSAGE")?.isSendLike, true);
  assert.equal(plan.writeTools.find((entry) => entry.actionSlug === "CREATE_DRAFT")?.isSendLike, false);
  assert.ok(plan.agents[0]?.toolRefs.includes("internal.memory_search"));
  assert.ok(plan.agents[0]?.toolRefs.includes("composio.crm.search"));
  assert.ok(plan.agents[1]?.toolRefs.includes("composio.mail.action.CREATE_DRAFT"));
  assert.ok(plan.agents[1]?.toolRefs.includes("composio.mail.action.SEND_MESSAGE"));
  assert.ok(plan.reviewSurfaces.includes("review.email"));
  assert.ok(plan.reviewSurfaces.includes("review.sources"));
  assert.ok(plan.reviewSurfaces.includes("review.draft"));
});

test("compileSpecRunPlan keeps mutating tools approval-only and honors draft-only policy", () => {
  const plan = compileSpecRunPlan(buildSpec("draft_only"));

  assert.ok(plan.writeTools.some((entry) => entry.actionSlug === "CREATE_DRAFT"));
  assert.ok(!plan.writeTools.some((entry) => entry.actionSlug === "SEND_MESSAGE"));
  assert.ok(plan.writeTools.every((entry) => entry.requiresApproval));
});

test("compileSpecRunPlan passes agent personas through to run plan agents", () => {
  const spec = buildSpec();
  const persona = {
    displayName: "Maya",
    roleKey: "researcher" as const,
    roleLabel: "Researcher",
    avatarId: "00000000-0000-4000-8000-000000000021",
    avatarSeed: "seed-maya",
  };
  spec.noSlopSpec.specJson.agents[0] = {
    ...spec.noSlopSpec.specJson.agents[0]!,
    persona,
  };

  const plan = compileSpecRunPlan(spec);
  assert.deepEqual(plan.agents[0]?.persona, persona);
  assert.equal(plan.agents[1]?.persona, undefined);
});

test("compileSpecRunPlan uses declared agent tools when present", () => {
  const spec = buildSpec();
  spec.noSlopSpec.specJson.agents[0] = {
    ...spec.noSlopSpec.specJson.agents[0]!,
    tools: ["internal.web_search", "composio.mail.action.READ_TICKETS"],
  };
  spec.noSlopSpec.specJson.agents[1] = {
    ...spec.noSlopSpec.specJson.agents[1]!,
    tools: ["composio.mail.action.CREATE_DRAFT"],
  };

  const plan = compileSpecRunPlan(spec);
  assert.ok(plan.agents[0]?.toolRefs.includes("internal.web_search"));
  assert.ok(plan.agents[0]?.toolRefs.includes("composio.mail.action.READ_TICKETS"));
  assert.ok(!plan.agents[0]?.toolRefs.includes("composio.mail.action.CREATE_DRAFT"));
  assert.ok(plan.agents[1]?.toolRefs.includes("composio.mail.action.CREATE_DRAFT"));
  assert.ok(!plan.agents[1]?.toolRefs.includes("internal.memory_search"));
});

test("declaredAgentToolRefs uses only spec-declared tools when tools array is empty", () => {
  const spec = buildSpec();
  const plan = compileSpecRunPlan(spec);
  const agent = { ...spec.noSlopSpec.specJson.agents[0]!, tools: [] };
  const refs = declaredAgentToolRefs(agent, plan.readTools.concat(plan.writeTools));
  assert.deepEqual(refs, ["internal.llm_only"]);
});
