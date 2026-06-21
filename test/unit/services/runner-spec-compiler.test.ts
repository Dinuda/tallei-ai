import assert from "node:assert/strict";
import test from "node:test";

import { compileRunnerSpecFromBuildContract } from "../../../src/services/loop-builder/runner-spec-compiler.js";
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
    ],
  };
}

test("compileRunnerSpecFromBuildContract builds finalizeAgent-ready agents without LLM", () => {
  const spec = compileRunnerSpecFromBuildContract({
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
  assert.ok(spec.agents.every((agent) => agent.outputContract));
  assert.equal(spec.agents[0]?.artifactRole, "source_evidence");
  assert.equal(spec.agents[0]?.outputContract?.visibility, "internal");
  assert.equal(spec.agents[0]?.outputContract?.renderer, undefined);
  assert.match(spec.agents[0]?.guardrails.join("\n") ?? "", /Do not draft or send outbound messages/);
  assert.equal(spec.agents[1]?.artifactRole, "draft_body");
  assert.equal(spec.agents[1]?.outputContract?.renderer, "canvas.email");
  assert.ok(spec.agents[1]?.gate);
  assert.equal(spec.delivery.provider, "gmail");
  assert.doesNotMatch(spec.delivery.provider, /GMAIL_CREATE_EMAIL_DRAFT|gmail_create_email_draft/i);
  assert.match(spec.purpose, /Monitor Gmail/);
  assert.equal(spec.buildContract?.requirements.length, 4);
});

test("compiled Context Specialist contract supports ticket and no-ticket outcomes", () => {
  const spec = compileRunnerSpecFromBuildContract({
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

test("compileRunnerSpecFromBuildContract keeps delivery provider behavioral", () => {
  const spec = compileRunnerSpecFromBuildContract({
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

test("compileRunnerSpecFromBuildContract omits agent gates for draft_only review policy", () => {
  const spec = compileRunnerSpecFromBuildContract({
    prompt: "Handle Gmail support tickets",
    buildContract: buildContract("draft_only"),
    discoveredToolContracts: [
      contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
      contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft", "create"]),
      contract("GMAIL_SEND_EMAIL", "irreversible_external", ["send"]),
    ],
  });

  assert.equal(spec.agents.length, 2);
  assert.equal(spec.agents[1]?.gate, undefined);
  assert.equal(spec.inputRequirements.some((req) => req.key === "draft_review"), false);
  assert.equal(spec.inputRequirements.some((req) => req.key === "confirm_send"), false);
});

test("compileRunnerSpecFromBuildContract completes quickly for preview path", () => {
  const started = performance.now();
  compileRunnerSpecFromBuildContract({
    prompt: "Quick compile",
    buildContract: buildContract(),
    discoveredToolContracts: [
      contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]),
      contract("GMAIL_CREATE_EMAIL_DRAFT", "write_external", ["draft"]),
    ],
  });
  assert.ok(performance.now() - started < 50);
});
