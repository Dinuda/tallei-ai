import assert from "node:assert/strict";
import test from "node:test";

import { atomicityIssues, buildRunnerSpecFromBuildContract } from "../../../src/services/conductor/services/spec.service.js";
import { validateContractData } from "../../../src/services/conductor/contracts/data-contract.js";
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

function buildContract(reviewMode: "draft_only" | "approve_each_action" | "approve_batch" = "approve_each_action") {
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
        value: { mode: "review_drafts" as const },
        validationErrors: [],
        warnings: [],
      },
    ],
  };
}

function buildContractWithOutputGates(
  gatesMode: "automatic" | "review_drafts" | "review_drafts_and_send",
  reviewMode: "draft_only" | "approve_each_action" | "approve_batch" = "approve_each_action",
) {
  return {
    ...buildContract(reviewMode),
    requirements: buildContract(reviewMode).requirements.map((req) =>
      req.kind === "output_review_gates"
        ? { ...req, value: { mode: gatesMode } }
        : req,
    ),
  };
}

const gmailContracts = [
  contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
  contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft", "create"]),
  contract("GMAIL_SEND_EMAIL", "irreversible_external", ["send"]),
];

const connectorAgentPlan = {
  parentAgents: [{
    id: "connector_parent_1",
    name: "Connector Coordinator",
    goal: "Coordinate connected app work for support replies",
    toolkits: ["gmail"],
    dependsOn: [],
    successCriteria: ["Connector operations are configured, validated, and ready for workflow planning."],
    failurePolicy: "Pause and ask the operator when connector output is missing or ambiguous.",
    subAgents: [{
      id: "connector_sub_1_gmail",
      parentAgentId: "connector_parent_1",
      goal: "Use gmail connector actions required for support replies",
      toolkit: "gmail",
      accountId: accountId,
      dependsOn: [],
      testStatus: "not_run" as const,
      handoffOutputs: [{ path: "/" }],
      operations: [
        {
          id: "op_1_gmail_fetch_emails",
          toolRef: "composio.gmail.action.GMAIL_FETCH_EMAILS",
          actionSlug: "GMAIL_FETCH_EMAILS",
          name: "List messages",
          plannerRole: "read" as const,
          inputBindings: {},
          outputSchema: { type: "object" },
          approvalPolicy: { required: false },
          dependsOn: [],
        },
        {
          id: "op_2_gmail_create_email_draft",
          toolRef: "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT",
          actionSlug: "GMAIL_CREATE_EMAIL_DRAFT",
          name: "Create email draft",
          plannerRole: "draft" as const,
          inputBindings: {},
          outputSchema: { type: "object" },
          approvalPolicy: { required: true },
          dependsOn: [],
        },
        {
          id: "op_3_gmail_send_email",
          toolRef: "composio.gmail.action.GMAIL_SEND_EMAIL",
          actionSlug: "GMAIL_SEND_EMAIL",
          name: "Send email",
          plannerRole: "publish" as const,
          inputBindings: {},
          outputSchema: { type: "object" },
          approvalPolicy: { required: true },
          dependsOn: [],
        },
      ],
    }],
  }],
};

test("buildRunnerSpecFromBuildContract builds conductor agents", async () => {
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: gmailContracts,
    intentContext: {
      resolvedIntent: "Monitor Gmail and draft support replies",
      resolvedAt: "2026-06-20T00:00:00.000Z",
      decisions: [],
      assumptions: [],
      analysis: {
        normalizedIntent: {
          outcome: "Monitor Gmail and draft support replies",
          toolCategories: [],
          cadence: "On new email",
          approvalModel: "Operator approval",
          runtimeInputs: [],
        },
        questions: [],
        assumptions: [],
        connectorFeasibility: [],
        interactivePrompts: [],
        events: [],
        analyzedAt: "2026-06-20T00:00:00.000Z",
      },
    },
  });

  assert.equal(spec.agents.length, 4);
  assert.deepEqual(spec.agents.map((agent) => agent.roleKey), [
    "coordinator",
    "researcher",
    "writer",
    "publisher",
  ]);
  assert.deepEqual(spec.agents.map((agent) => agent.toolDomain), [
    "coordinate",
    "read",
    "draft",
    "deliver",
  ]);
  assert.ok(spec.agents.every((agent) => agent.gate === undefined));
  assert.equal(spec.inputRequirements.some((req) => req.key === "source_review"), false);
  assert.ok(spec.agents.every((agent) => agent.outputContract));
  assert.equal(spec.agents[2]?.outputContract?.visibility, "operator");
  assert.equal(spec.agents[2]?.outputContract?.renderer, "canvas.email");
  assert.equal(spec.agents[3]?.outputContract?.renderer, undefined);
  assert.match(spec.agents[3]?.guardrails.join("\n") ?? "", /approval gates/);
  assert.equal(spec.delivery.provider, "gmail");
  assert.doesNotMatch(spec.delivery.provider, /GMAIL_CREATE_EMAIL_DRAFT|gmail_create_email_draft/i);
  assert.match(spec.purpose, /Monitor Gmail/);
  assert.equal(spec.buildContract, undefined);
  assert.equal(atomicityIssues(spec).length, 0);
});

test("mutating agent output contract supports draft and no-action outcomes", async () => {
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: gmailContracts,
  });
  const schema = spec.agents.find((agent) => agent.roleKey === "writer")!.outputContract.schema;

  assert.deepEqual(validateContractData(schema, {
    status: "draft_ready",
    subject: "Re: site down",
    body: "Thanks for contacting support.",
  }), { valid: true });

  assert.deepEqual(validateContractData(schema, {
    status: "no_action_required",
    summary: "Scanned inbox and found no support tickets.",
  }), { valid: true });

  const invalidStatus = validateContractData(schema, {
    status: "ticket_found",
  });
  assert.equal(invalidStatus.valid, false);
  if (!invalidStatus.valid) assert.match(invalidStatus.reason, /status/);
});

test("buildRunnerSpecFromBuildContract keeps delivery provider behavioral", async () => {
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: [
      contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
      contract("GMAIL_CREATE_EMAIL_DRAFT", "irreversible_external", ["draft", "create"]),
    ],
  });

  assert.equal(spec.delivery.provider, "gmail");
  assert.doesNotMatch(spec.delivery.provider, /gmail_create_email_draft/i);
  assert.equal(spec.agents.find((agent) => agent.roleKey === "writer")?.tools[0], "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT");
});

test("buildRunnerSpecFromBuildContract does not insert builder-time gates for draft_only review policy", async () => {
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract("draft_only"),
    discoveredToolContracts: gmailContracts,
  });

  assert.equal(spec.agents.length, 4);
  assert.ok(spec.agents.every((agent) => agent.gate === undefined));
  assert.equal(spec.inputRequirements.some((req) => req.key === "confirm_send"), false);
});

test("buildRunnerSpecFromBuildContract routes tools to role-sized agents", async () => {
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Reply to Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: gmailContracts,
  });

  const researcher = spec.agents.find((agent) => agent.roleKey === "researcher");
  const writer = spec.agents.find((agent) => agent.roleKey === "writer");
  const publisher = spec.agents.find((agent) => agent.roleKey === "publisher");

  assert.ok(researcher?.tools.some((ref) => ref.includes("GMAIL_FETCH_EMAILS")));
  assert.ok(writer?.tools.some((ref) => ref.includes("GMAIL_CREATE_EMAIL_DRAFT")));
  assert.ok(publisher?.tools.some((ref) => ref.includes("GMAIL_SEND_EMAIL")));
  assert.equal(researcher?.tools.some((ref) => ref.includes("GMAIL_SEND_EMAIL")), false);
  assert.equal(writer?.tools.some((ref) => ref.includes("GMAIL_SEND_EMAIL")), false);
});

test("buildRunnerSpecFromBuildContract respects planner roles from the connector agent plan", async () => {
  const contractWithPlan = {
    ...buildContract(),
    requirements: buildContract().requirements.map((requirement) =>
      requirement.kind === "connector"
        ? {
          ...requirement,
          value: {
            ...requirement.value,
            agentPlan: connectorAgentPlan,
          },
        }
        : requirement,
    ),
  };

  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Reply to Gmail support tickets",
    buildContract: contractWithPlan,
    discoveredToolContracts: gmailContracts,
  });

  const researcher = spec.agents.find((agent) => agent.roleKey === "researcher");
  const writer = spec.agents.find((agent) => agent.roleKey === "writer");
  const publisher = spec.agents.find((agent) => agent.roleKey === "publisher");

  assert.ok(researcher?.tools.some((ref) => ref.includes("GMAIL_FETCH_EMAILS")));
  assert.ok(writer?.tools.some((ref) => ref.includes("GMAIL_CREATE_EMAIL_DRAFT")));
  assert.ok(publisher?.tools.some((ref) => ref.includes("GMAIL_SEND_EMAIL")));
});

test("buildRunnerSpecFromBuildContract compiles connector agent plan without discovered contracts", async () => {
  const contractWithPlan = {
    ...buildContract(),
    requirements: buildContract().requirements.map((requirement) =>
      requirement.kind === "connector"
        ? {
          ...requirement,
          value: {
            ...requirement.value,
            agentPlan: connectorAgentPlan,
          },
        }
        : requirement,
    ),
  };

  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Reply to Gmail support tickets",
    buildContract: contractWithPlan,
    discoveredToolContracts: [],
  });

  assert.ok(spec.agents.find((agent) => agent.roleKey === "researcher")?.tools.includes("composio.gmail.action.GMAIL_FETCH_EMAILS"));
  assert.ok(spec.agents.find((agent) => agent.roleKey === "writer")?.tools.includes("composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT"));
  assert.ok(spec.agents.find((agent) => agent.roleKey === "publisher")?.tools.includes("composio.gmail.action.GMAIL_SEND_EMAIL"));
});

test("buildRunnerSpecFromBuildContract exposes intent structure and artifact bundle to agents", async () => {
  const artifactBundle = {
    templates: [{
      id: "support_reply",
      subject: "Re: {{ticket.subject}}",
      body: "Hi {{ticket.customer}}, {{reply}}",
    }],
  };
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: gmailContracts,
    artifactBundle,
    intentContext: {
      resolvedIntent: "Draft and send approved Gmail support replies",
      resolvedAt: "2026-06-20T00:00:00.000Z",
      decisions: [],
      assumptions: [],
      analysis: {
        normalizedIntent: {
          outcome: "send approved support replies",
          toolCategories: ["communication"],
          cadence: "event_triggered",
          approvalModel: "review_before_send",
          runtimeInputs: ["reply_tone", "priority_rules"],
        },
        questions: [],
        assumptions: [],
        connectorFeasibility: [],
        interactivePrompts: [],
        events: [],
        analyzedAt: "2026-06-20T00:00:00.000Z",
      },
    },
  });

  const writer = spec.agents.find((agent) => agent.roleKey === "writer");
  assert.match(writer?.goal ?? "", /approvalModel=review_before_send/);
  assert.match(writer?.goal ?? "", /runtimeInputs=reply_tone, priority_rules/);
  assert.match(writer?.inputContract?.description ?? "", /artifact_template/);
  assert.deepEqual(spec.inputRequirements.find((req) => req.key === "artifact_template")?.value, artifactBundle);
});

test("buildRunnerSpecFromBuildContract ignores legacy output review modes for active gates", async () => {
  const legacyAutomatic = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContractWithOutputGates("automatic"),
    discoveredToolContracts: gmailContracts,
  });
  assert.ok(legacyAutomatic.agents.every((agent) => !agent.gate));

  const draftReview = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContractWithOutputGates("review_drafts"),
    discoveredToolContracts: gmailContracts,
  });
  assert.equal(draftReview.agents.length, 4);
  assert.ok(draftReview.agents.every((agent) => agent.gate === undefined));

  const withGates = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContractWithOutputGates("review_drafts_and_send"),
    discoveredToolContracts: gmailContracts,
  });
  assert.equal(withGates.agents.length, 4);
  assert.ok(withGates.agents.every((agent) => agent.gate === undefined));
});

test("buildRunnerSpecFromBuildContract completes quickly for preview path", async () => {
  const started = performance.now();
  await buildRunnerSpecFromBuildContract({
    prompt: "Quick compile",
    buildContract: buildContract(),
    discoveredToolContracts: [
      contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
      contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft"]),
    ],
  });
  assert.ok(performance.now() - started < 50);
});

test("specAtomicityIssues flags agents that mix connector tools with llm synthesis", () => {
  const issues = atomicityIssues({
    agents: [
      {
        name: "Mixed Agent",
        goal: "Read Gmail and synthesize a reply.",
        tools: ["composio.gmail.action.GMAIL_FETCH_EMAILS", "internal.llm_only"],
        guardrails: [],
        doneWhen: ["Done"],
        doneCriteria: ["Done"],
        failureModes: [],
        inputContract: { description: "Input", schema: {} },
        outputContract: { description: "Output", schema: {}, representation: "text" },
        handoffBindings: [],
      },
      {
        name: "Synthesis Agent",
        goal: "Synthesize.",
        tools: ["internal.llm_only"],
        guardrails: [],
        doneWhen: ["Done"],
        doneCriteria: ["Done"],
        failureModes: [],
        inputContract: { description: "Input", schema: {} },
        outputContract: { description: "Output", schema: {}, representation: "text" },
        handoffBindings: [],
      },
    ],
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0] ?? "", /Mixed Agent/);
});

test("conductor produces multi-agent specs without tool atomicity issues", async () => {
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: gmailContracts,
  });
  assert.equal(spec.agents.length, 4);
  assert.ok(spec.agents[0]?.name.length);
  assert.ok(spec.agents[1]?.name.length);
  assert.equal(atomicityIssues(spec).length, 0);
  assert.ok((spec.agents.at(-1)?.handoffBindings.length ?? 0) > 0);
});

test("artifact-only workflows allocate a writer", async () => {
  const artifactOnlyContract = {
    version: "v1" as const,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    issues: [],
    requirements: buildContract().requirements.filter((requirement) =>
      requirement.id === "trigger_schedule" || requirement.id === "artifact_contract"),
  };

  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Draft a weekly status summary",
    buildContract: artifactOnlyContract,
    discoveredToolContracts: [],
  });

  assert.deepEqual(spec.agents.map((agent) => agent.roleKey), ["coordinator", "writer"]);
  assert.deepEqual(spec.agents.map((agent) => agent.toolDomain), ["coordinate", "draft"]);
  assert.deepEqual(spec.agents[1]?.tools, ["internal.llm_only"]);
});

test("schedule-only workflows allocate a coordinator", async () => {
  const scheduleOnlyContract = {
    version: "v1" as const,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    issues: [],
    requirements: buildContract().requirements.filter((requirement) =>
      requirement.id === "trigger_schedule"),
  };

  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Run a scheduled operational checkpoint",
    buildContract: scheduleOnlyContract,
    discoveredToolContracts: [],
  });

  assert.deepEqual(spec.agents.map((agent) => agent.roleKey), ["coordinator"]);
  assert.equal(spec.agents[0]?.toolDomain, "coordinate");
  assert.deepEqual(spec.agents[0]?.tools, []);
});

test("buildRunnerSpecFromBuildContract supports write-only artifact workflows", async () => {
  const writeOnlyContract = {
    ...buildContract(),
    requirements: buildContract().requirements.map((requirement) =>
      requirement.id === "connector_selection"
        ? {
          ...requirement,
          value: {
            selections: [{
              toolkit: "gmail",
              accounts: [{ id: accountId }],
              actionSlugs: ["GMAIL_CREATE_EMAIL_DRAFT"],
            }],
          },
        }
        : requirement,
    ),
  };
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Write only",
    buildContract: writeOnlyContract,
    discoveredToolContracts: [
      contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft"]),
    ],
  });

  assert.deepEqual(spec.agents.map((agent) => agent.roleKey), ["coordinator", "writer"]);
  assert.equal(spec.agents[1]?.tools[0], "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT");
});
