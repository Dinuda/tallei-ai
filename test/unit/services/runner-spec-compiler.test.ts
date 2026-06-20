import assert from "node:assert/strict";
import test from "node:test";

import { compileRunnerSpecFromBuildContract } from "../../../src/services/loop-builder/runner-spec-compiler.js";
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

function buildContract() {
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
        value: { mode: "approve_each_action" },
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
  assert.equal(spec.agents[1]?.outputContract?.renderer, "canvas.email");
  assert.ok(spec.agents[1]?.gate);
  assert.equal(spec.delivery.provider, "gmail");
  assert.doesNotMatch(spec.delivery.provider, /GMAIL_CREATE_EMAIL_DRAFT|gmail_create_email_draft/i);
  assert.match(spec.purpose, /Monitor Gmail/);
  assert.equal(spec.buildContract?.requirements.length, 4);
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
