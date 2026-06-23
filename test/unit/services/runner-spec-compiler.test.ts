import assert from "node:assert/strict";
import test from "node:test";

import { buildRunnerSpecFromBuildContract, specAtomicityIssues } from "../../../src/services/conductor/services/spec.service.js";
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

  assert.equal(spec.agents.length, 2);
  assert.equal(spec.agents[0]?.name, "Context Reader");
  assert.equal(spec.agents[1]?.name, "Draft Writer");
  assert.ok(spec.agents.every((agent) => agent.gate === undefined));
  assert.equal(spec.inputRequirements.some((req) => req.key === "source_review"), false);
  assert.ok(spec.agents.every((agent) => agent.outputContract));
  assert.equal(spec.agents[1]?.outputContract?.visibility, "operator");
  assert.equal(spec.agents[1]?.outputContract?.renderer, "canvas.email");
  assert.match(spec.agents[1]?.guardrails.join("\n") ?? "", /approval gates/);
  assert.equal(spec.delivery.provider, "gmail");
  assert.doesNotMatch(spec.delivery.provider, /GMAIL_CREATE_EMAIL_DRAFT|gmail_create_email_draft/i);
  assert.match(spec.purpose, /Monitor Gmail/);
  assert.equal(spec.buildContract, undefined);
  assert.equal(specAtomicityIssues(spec).length, 0);
});

test("Draft Writer output contract supports draft and no-action outcomes", async () => {
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: gmailContracts,
  });
  const schema = spec.agents[1]!.outputContract.schema;

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
  assert.equal(spec.agents[1]?.tools[0], "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT");
});

test("buildRunnerSpecFromBuildContract does not insert builder-time gates for draft_only review policy", async () => {
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract("draft_only"),
    discoveredToolContracts: gmailContracts,
  });

  assert.equal(spec.agents.length, 2);
  assert.ok(spec.agents.every((agent) => agent.gate === undefined));
  assert.equal(spec.inputRequirements.some((req) => req.key === "confirm_send"), false);
});

test("buildRunnerSpecFromBuildContract routes read tools to Context Reader and mutating tools to Draft Writer", async () => {
  const spec = await buildRunnerSpecFromBuildContract({
    prompt: "Reply to Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: gmailContracts,
  });

  assert.equal(spec.agents.length, 2);
  assert.ok(spec.agents[0]?.tools.some((ref) => ref.includes("GMAIL_FETCH_EMAILS")));
  assert.ok(spec.agents[1]?.tools.some((ref) => ref.includes("GMAIL_CREATE_EMAIL_DRAFT")));
  assert.ok(spec.agents[1]?.tools.some((ref) => ref.includes("GMAIL_SEND_EMAIL")));
  assert.equal(spec.agents[0]?.tools.some((ref) => ref.includes("GMAIL_SEND_EMAIL")), false);
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
  assert.equal(draftReview.agents.length, 2);
  assert.ok(draftReview.agents.every((agent) => agent.gate === undefined));

  const withGates = await buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContractWithOutputGates("review_drafts_and_send"),
    discoveredToolContracts: gmailContracts,
  });
  assert.equal(withGates.agents.length, 2);
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
  const issues = specAtomicityIssues({
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
  assert.equal(spec.agents.length, 2);
  assert.equal(spec.agents[0]?.name, "Context Reader");
  assert.equal(spec.agents[1]?.name, "Draft Writer");
  assert.equal(specAtomicityIssues(spec).length, 0);
  assert.ok((spec.agents[1]?.handoffBindings.length ?? 0) > 0);
});

test("buildRunnerSpecFromBuildContract rejects workflows without read/write split", async () => {
  await assert.rejects(
    () => buildRunnerSpecFromBuildContract({
      prompt: "Write only",
      buildContract: buildContract(),
      discoveredToolContracts: [
        contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft"]),
      ],
    }),
    /Conductor could not decompose/,
  );
});
