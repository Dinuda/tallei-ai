import assert from "node:assert/strict";
import test from "node:test";

import { buildRunnerSpecFromBuildContract, specAtomicityIssues } from "../../../src/services/loop-builder/specs.js";
import { validateContractData } from "../../../src/services/loop-engine/data-contract.js";
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

test("buildRunnerSpecFromBuildContract builds finalizeAgent-ready agents without LLM", () => {
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: [
      contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
      contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft", "create"]),
      contract("GMAIL_SEND_EMAIL", "irreversible_external", ["send"]),
    ],
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

  assert.equal(spec.agents.length, 3);
  assert.equal(spec.agents[1]?.gate?.type, "draft_review");
  assert.equal(spec.agents[2]?.gate, undefined);
  assert.equal(spec.inputRequirements.some((req) => req.key === "draft_review"), false);
  assert.equal(spec.inputRequirements.some((req) => req.key === "source_review"), false);
  assert.ok(spec.agents.every((agent) => agent.outputContract));
  assert.equal(spec.agents[0]?.artifactRole, "source_evidence");
  assert.equal(spec.agents[0]?.outputContract?.visibility, "internal");
  assert.equal(spec.agents[0]?.outputContract?.renderer, undefined);
  assert.match(spec.agents[0]?.guardrails.join("\n") ?? "", /Do not draft or send outbound messages/);
  assert.equal(spec.agents[1]?.artifactRole, "draft_body");
  assert.equal(spec.agents[1]?.outputContract?.renderer, "canvas.email");
  assert.equal(spec.agents[1]?.gate?.type, "draft_review");
  assert.equal(spec.delivery.provider, "gmail");
  assert.doesNotMatch(spec.delivery.provider, /GMAIL_CREATE_EMAIL_DRAFT|gmail_create_email_draft/i);
  assert.match(spec.purpose, /Monitor Gmail/);
  assert.equal(spec.buildContract, undefined);
});

test("built Context Specialist contract supports ticket and no-ticket outcomes", () => {
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: [
      contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
      contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft", "create"]),
    ],
  });
  const schema = spec.agents[0]!.outputContract.schema;

  assert.deepEqual(validateContractData(schema, {
    status: "ticket_found",
    summary: "Customer reports the site is down.",
    priority: "high",
    ticket: {
      subject: "site down",
      body: "The site is unavailable.",
      threadId: "thread-1",
      messageId: "message-1",
    },
    customer: { email: "customer@example.com" },
  }), { valid: true });

  assert.deepEqual(validateContractData(schema, {
    status: "no_tickets_found",
    summary: "Scanned inbox and found no support tickets.",
    findings: ["Only newsletters and notifications were present."],
  }), { valid: true });

  const missingSummary = validateContractData(schema, {
    status: "no_tickets_found",
  });
  assert.equal(missingSummary.valid, false);
  if (!missingSummary.valid) assert.match(missingSummary.reason, /summary/);

  const missingTicket = validateContractData(schema, {
    status: "ticket_found",
    summary: "A support ticket was found.",
  });
  assert.equal(missingTicket.valid, false);
  if (!missingTicket.valid) assert.match(missingTicket.reason, /ticket/);
});

test("buildRunnerSpecFromBuildContract keeps delivery provider behavioral", () => {
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract(),
    discoveredToolContracts: [
      contract("GMAIL_CREATE_EMAIL_DRAFT", "irreversible_external", ["draft", "create"]),
    ],
  });

  assert.equal(spec.delivery.provider, "gmail");
  assert.doesNotMatch(spec.delivery.provider, /gmail_create_email_draft/i);
  assert.equal(spec.agents.at(-1)?.tools[0], "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT");
});

test("buildRunnerSpecFromBuildContract keeps builder-time gates for draft_only review policy", () => {
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract("draft_only"),
    discoveredToolContracts: [
      contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
      contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft", "create"]),
      contract("GMAIL_SEND_EMAIL", "irreversible_external", ["send"]),
    ],
  });

  assert.equal(spec.agents.length, 2);
  assert.equal(spec.agents[1]?.gate?.type, "draft_review");
  assert.equal(spec.inputRequirements.some((req) => req.key === "draft_review"), false);
  assert.equal(spec.inputRequirements.some((req) => req.key === "confirm_send"), false);
});

test("buildRunnerSpecFromBuildContract routes mutating tools to delivery agent", () => {
  const spec = buildRunnerSpecFromBuildContract({
    prompt: "Reply to Gmail support tickets",
    buildContract: {
      ...buildContract(),
      requirements: buildContract().requirements.map((req) =>
        req.kind === "connector"
          ? {
              ...req,
              value: {
                selections: [{
                  toolkit: "gmail",
                  accounts: [{ id: accountId }],
          actionSlugs: ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_EMAIL"],
                }],
              },
            }
          : req,
      ),
    },
    discoveredToolContracts: [
      contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
      contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft", "create"]),
      contract("GMAIL_SEND_EMAIL", "irreversible_external", ["send"]),
    ],
  });

  const contextAgent = spec.agents.find((agent) => agent.artifactRole === "source_evidence");
  const deliveryAgent = spec.agents.find((agent) => agent.artifactRole === "delivery");
  assert.ok(contextAgent);
  assert.ok(deliveryAgent);
  assert.ok(contextAgent.tools.some((ref) => ref.includes("GMAIL_FETCH_EMAILS")));
  assert.ok(!contextAgent.tools.some((ref) => ref.includes("GMAIL_CREATE_EMAIL_DRAFT")));
  assert.ok(deliveryAgent.tools.some((ref) => ref.includes("GMAIL_CREATE_EMAIL_DRAFT")));
  assert.ok(deliveryAgent.tools.some((ref) => ref.includes("GMAIL_SEND_EMAIL")));
});

test("buildRunnerSpecFromBuildContract adds gates from explicit output review modes only", () => {
  const contracts = [
    contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
    contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft", "create"]),
    contract("GMAIL_SEND_EMAIL", "irreversible_external", ["send"]),
  ];
  const legacyAutomatic = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContractWithOutputGates("automatic"),
    discoveredToolContracts: contracts,
  });
  assert.ok(legacyAutomatic.agents.every((agent) => !agent.gate));

  const draftReview = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContractWithOutputGates("review_drafts"),
    discoveredToolContracts: contracts,
  });
  assert.equal(draftReview.agents[1]?.gate?.type, "draft_review");
  assert.equal(draftReview.agents[2]?.gate, undefined);

  const withGates = buildRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContractWithOutputGates("review_drafts_and_send"),
    discoveredToolContracts: contracts,
  });
  assert.equal(withGates.agents[1]?.gate?.type, "draft_review");
  assert.equal(withGates.agents[2]?.gate?.type, "pre_send");
});

test("buildRunnerSpecFromBuildContract completes quickly for preview path", () => {
  const started = performance.now();
  buildRunnerSpecFromBuildContract({
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
