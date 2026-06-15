import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveVerificationScope,
  selectedConnectorSlugsFromContract,
} from "../../../src/services/loop-executor/verification-scope.js";
import { deriveLoopBuildContract, resolveBuildRequirement } from "../../../src/services/loop-engine/build-contract.js";
import { loopIntentContextSchema } from "../../../src/services/loop-engine/intent-context.js";
import type { ToolContract } from "../../../src/services/tool-spec/types.js";

const intent = loopIntentContextSchema.parse({
  analysis: {
    normalizedIntent: {
      outcome: "Draft Gmail replies for support",
      toolCategories: ["communication"],
      cadence: "daily",
      approvalModel: "approve external actions",
      runtimeInputs: [],
    },
    analyzedAt: "2026-06-15T00:00:00.000Z",
  },
  resolvedIntent: "Draft Gmail replies for support",
  resolvedAt: "2026-06-15T00:00:00.000Z",
});

const gmailContracts: ToolContract[] = [
  "GMAIL_CREATE_EMAIL_DRAFT",
  "GMAIL_GET_DRAFT",
  "GMAIL_SEND_DRAFT",
  "GMAIL_LIST_DRAFTS",
  "GMAIL_GET_CONTACTS",
].map((actionSlug) => ({
  toolRef: `composio.gmail.action.${actionSlug}`,
  provider: "composio" as const,
  name: actionSlug,
  description: actionSlug,
  skillTags: [],
  effect: actionSlug.includes("GET") || actionSlug.includes("LIST") ? "read_external" as const : "write_external" as const,
  resources: ["gmail"],
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object" },
  executionMode: "short_circuit" as const,
  approval: { required: false },
  renderRecommendations: [],
  constraints: { toolkit: "gmail", actionSlug, connected: true },
  source: "composio_sdk" as const,
}));

function resolvedGmailContract(actionSlugs: string[]) {
  let contract = deriveLoopBuildContract({
    intentContext: intent,
    discoveredToolContracts: gmailContracts,
    now: "2026-06-15T00:00:00.000Z",
  });
  contract = resolveBuildRequirement({
    contract,
    requirementId: "trigger_schedule",
    value: { trigger: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    discoveredToolContracts: gmailContracts,
  });
  contract = resolveBuildRequirement({
    contract,
    requirementId: "grounding",
    value: { mode: "none" },
    discoveredToolContracts: gmailContracts,
  });
  contract = resolveBuildRequirement({
    contract,
    requirementId: "artifact_contract",
    value: {
      mode: "supplied_template",
      template: JSON.stringify({
        templates: [{
          id: "t1",
          name: "Acknowledgment",
          templateId: "acknowledgment",
          subject: "We received your request",
          html: "<p>Thanks</p>",
        }],
      }),
    },
    discoveredToolContracts: gmailContracts,
  });
  return resolveBuildRequirement({
    contract,
    requirementId: "connector_selection",
    value: {
      selections: [{
        toolkit: "gmail",
        actionSlugs,
        accounts: [{ id: "11111111-1111-4111-8111-111111111111" }],
      }],
    },
    discoveredToolContracts: gmailContracts,
  });
}

test("gmail drafts-only scope marks create/get draft critical and contacts optional", () => {
  const buildContract = resolvedGmailContract([
    "GMAIL_CREATE_EMAIL_DRAFT",
    "GMAIL_GET_DRAFT",
    "GMAIL_LIST_DRAFTS",
    "GMAIL_GET_CONTACTS",
  ]);
  const scope = deriveVerificationScope({
    buildContract,
    runnableSpec: {
      version: "v1",
      goal: "Draft Gmail replies for support tickets",
      title: "Support drafts",
      noSlopSpec: {
        id: "spec-1",
        title: "Support drafts",
        bodyMarkdown: "",
        specJson: {
          purpose: "Draft Gmail replies for support tickets without sending",
          delivery: { provider: "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT", description: "Create drafts only" },
          schedule: { cron: "0 9 * * *", timezone: "UTC" },
          agents: [{
            name: "Reply drafter",
            goal: "Create Gmail drafts with approved templates",
            guardrails: [],
            doneWhen: ["Draft created"],
            failureModes: [],
          }],
          successCriteria: ["Draft exists"],
          buildContract,
        },
        approvedAt: "2026-06-15T00:00:00.000Z",
        buildContract,
      },
      discoveredToolContracts: [],
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      buildContract,
    },
  });

  const bySlug = new Map(scope.map((target) => [target.actionSlug, target]));
  assert.equal(bySlug.get("GMAIL_CREATE_EMAIL_DRAFT")?.role, "critical");
  assert.equal(bySlug.get("GMAIL_GET_DRAFT")?.role, "critical");
  assert.equal(bySlug.get("GMAIL_LIST_DRAFTS")?.role, "optional");
  assert.equal(bySlug.get("GMAIL_GET_CONTACTS")?.role, "optional");
  assert.deepEqual(
    selectedConnectorSlugsFromContract(buildContract).sort(),
    ["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_GET_CONTACTS", "GMAIL_GET_DRAFT", "GMAIL_LIST_DRAFTS"].sort(),
  );
});
