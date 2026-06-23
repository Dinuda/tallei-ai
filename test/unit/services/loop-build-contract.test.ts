import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBuildContractReady,
  deriveLoopBuildContract,
  resolveBuildRequirement,
  selectedConnectorAccountId,
  selectedConnectorAccountIds,
  selectedArtifactContract,
  selectedExternalDataToolkits,
  selectedGroundingSources,
  selectedLoopTrigger,
  unresolvedBuildRequirements,
} from "../../../src/services/conductor/domain/build-contract.js";
import { loopIntentContextSchema } from "../../../src/services/conductor/contracts/intent-context.js";
import type { ToolContract } from "../../../src/services/tool-spec/types.js";
import { noSlopSpecSchema } from "../../../src/services/conductor/contracts/spec-contracts.js";

const intent = loopIntentContextSchema.parse({
  analysis: {
    normalizedIntent: {
      outcome: "Read records and prepare a response",
      toolCategories: ["communication"],
      cadence: "daily",
      approvalModel: "approve external actions",
      runtimeInputs: ["Customer segment"],
    },
    analyzedAt: "2026-06-15T00:00:00.000Z",
  },
  resolvedIntent: "Read records and prepare a response",
  resolvedAt: "2026-06-15T00:00:00.000Z",
});

const readContract: ToolContract = {
  toolRef: "composio.gmail.action.GMAIL_LIST_MESSAGES",
  provider: "composio",
  name: "List messages",
  description: "List messages",
  skillTags: ["retrieve"],
  effect: "read_external",
  resources: ["messages"],
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object" },
  executionMode: "short_circuit",
  approval: { required: false },
  renderRecommendations: [],
  constraints: { toolkit: "gmail", actionSlug: "GMAIL_LIST_MESSAGES", connected: true },
  source: "composio_sdk",
};

const gmailAccount = {
  id: "11111111-1111-4111-8111-111111111111",
};

test("build contract blocks drafting until every material requirement is resolved", () => {
  const contract = deriveLoopBuildContract({
    intentContext: intent,
    discoveredToolContracts: [readContract],
    now: "2026-06-15T00:00:00.000Z",
  });
  assert.ok(unresolvedBuildRequirements(contract).length >= 5);
  assert.throws(() => assertBuildContractReady(contract), /Build contract is not ready/);
});

test("schedule answers are semantically validated instead of accepting unrelated prose", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [] });
  const invalid = resolveBuildRequirement({
    contract,
    requirementId: "trigger_schedule",
    value: { trigger: "schedule", cron: "lets do a daily", timezone: "UTC" },
    discoveredToolContracts: [],
  });
  const schedule = invalid.requirements.find((entry) => entry.id === "trigger_schedule")!;
  assert.equal(schedule.status, "invalid");
  assert.match(schedule.validationErrors.join(" "), /5-field cron/);
});

test("sub-hourly schedules are rejected while hourly schedules resolve", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [] });
  const tooFrequent = resolveBuildRequirement({
    contract,
    requirementId: "trigger_schedule",
    value: { trigger: "schedule", cron: "*/5 * * * *", timezone: "UTC" },
    discoveredToolContracts: [],
  });
  assert.equal(tooFrequent.requirements.find((entry) => entry.id === "trigger_schedule")?.status, "invalid");
  const hourly = resolveBuildRequirement({
    contract,
    requirementId: "trigger_schedule",
    value: { trigger: "schedule", cron: "0 * * * *", timezone: "UTC" },
    discoveredToolContracts: [],
  });
  assert.equal(hourly.requirements.find((entry) => entry.id === "trigger_schedule")?.status, "resolved");
});

test("event-driven execution resolves only for an exact discovered trigger", () => {
  const contract = deriveLoopBuildContract({
    intentContext: intent,
    discoveredToolContracts: [readContract],
    discoveredTriggers: [{
      toolkit: "gmail",
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      name: "New Gmail message",
      description: "Run when a new message arrives.",
      type: "webhook",
    }],
  });
  const resolved = resolveBuildRequirement({
    contract,
    requirementId: "trigger_schedule",
    value: { trigger: "event", toolkit: "gmail", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
    discoveredToolContracts: [readContract],
  });
  assert.equal(resolved.requirements.find((entry) => entry.id === "trigger_schedule")?.status, "resolved");
  assert.deepEqual(selectedLoopTrigger(resolved), {
    mode: "event",
    toolkit: "gmail",
    triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
  });

  const invented = resolveBuildRequirement({
    contract,
    requirementId: "trigger_schedule",
    value: { trigger: "event", toolkit: "gmail", triggerSlug: "INVENTED_TRIGGER" },
    discoveredToolContracts: [readContract],
  });
  assert.equal(invented.requirements.find((entry) => entry.id === "trigger_schedule")?.status, "invalid");
});

test("explicit none choices persist user provenance and a warning", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [] });
  const resolved = resolveBuildRequirement({
    contract,
    requirementId: "grounding",
    value: { mode: "none" },
    discoveredToolContracts: [],
    now: "2026-06-15T01:00:00.000Z",
  });
  const grounding = resolved.requirements.find((entry) => entry.id === "grounding")!;
  assert.equal(grounding.status, "resolved");
  assert.equal(grounding.provenance?.source, "explicit_none");
  assert.equal(grounding.warnings.length, 1);
});

test("disconnected selected connector actions remain invalid", () => {
  const contract = deriveLoopBuildContract({
    intentContext: intent,
    discoveredToolContracts: [{ ...readContract, constraints: { ...readContract.constraints, connected: false } }],
  });
  const resolved = resolveBuildRequirement({
    contract,
    requirementId: "connector_selection",
    value: { selections: [{ toolkit: "gmail", accounts: [gmailAccount], actionSlugs: ["GMAIL_LIST_MESSAGES"] }] },
    discoveredToolContracts: [{ ...readContract, constraints: { ...readContract.constraints, connected: false } }],
  });
  assert.equal(resolved.requirements.find((entry) => entry.id === "connector_selection")?.status, "invalid");
});

test("connected accounts resolve the build contract before action visibility verification", () => {
  const connectedPendingVisibility = {
    ...readContract,
    constraints: { ...readContract.constraints, connected: true, actionVisible: false },
  };
  const contract = deriveLoopBuildContract({
    intentContext: intent,
    discoveredToolContracts: [connectedPendingVisibility],
  });
  const resolved = resolveBuildRequirement({
    contract,
    requirementId: "connector_selection",
    value: { selections: [{ toolkit: "gmail", accounts: [gmailAccount], actionSlugs: ["GMAIL_LIST_MESSAGES"] }] },
    discoveredToolContracts: [connectedPendingVisibility],
  });
  assert.equal(resolved.requirements.find((entry) => entry.id === "connector_selection")?.status, "resolved");
});

test("external-action review policy is derived from the validated action selection", () => {
  const writeContract: ToolContract = {
    ...readContract,
    toolRef: "composio.gmail.action.GMAIL_SEND_EMAIL",
    name: "Send email",
    effect: "write_external",
    skillTags: ["send"],
    constraints: { toolkit: "gmail", actionSlug: "GMAIL_SEND_EMAIL", connected: true },
  };
  const initial = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [readContract, writeContract] });
  assert.equal(initial.requirements.some((entry) => entry.kind === "review_policy"), false);
  const selected = resolveBuildRequirement({
    contract: initial,
    requirementId: "connector_selection",
    value: { selections: [{ toolkit: "gmail", accounts: [gmailAccount], actionSlugs: ["GMAIL_SEND_EMAIL"] }] },
    discoveredToolContracts: [readContract, writeContract],
  });
  assert.equal(selected.requirements.some((entry) => entry.kind === "review_policy"), true);
});

test("connector selections persist explicit durable account IDs", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [readContract] });
  const selected = resolveBuildRequirement({
    contract,
    requirementId: "connector_selection",
    value: { selections: [{ toolkit: "gmail", accounts: [gmailAccount], actionSlugs: ["GMAIL_LIST_MESSAGES"] }] },
    discoveredToolContracts: [readContract],
  });
  assert.deepEqual(selectedConnectorAccountIds(selected, "gmail"), [gmailAccount.id]);
  assert.equal(selectedConnectorAccountId(selected, "gmail"), gmailAccount.id);
});

test("runtime refuses an ambiguous multi-account connector route", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [readContract] });
  const selected = resolveBuildRequirement({
    contract,
    requirementId: "connector_selection",
    value: {
      selections: [{
        toolkit: "gmail",
        accounts: [
          gmailAccount,
          { id: "22222222-2222-4222-8222-222222222222" },
        ],
        actionSlugs: ["GMAIL_LIST_MESSAGES"],
      }],
    },
    discoveredToolContracts: [readContract],
  });
  assert.throws(() => selectedConnectorAccountId(selected, "gmail"), /explicit account-scoped route/);
});

test("connector selections require only a durable account id", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [readContract] });
  const selected = resolveBuildRequirement({
    contract,
    requirementId: "connector_selection",
    value: {
      selections: [{
        toolkit: "gmail",
        accounts: [{ id: gmailAccount.id }],
        actionSlugs: ["GMAIL_LIST_MESSAGES"],
      }],
    },
    discoveredToolContracts: [readContract],
  });
  assert.equal(selected.requirements.find((entry) => entry.id === "connector_selection")?.status, "resolved");
});

test("connector selection derives only material passthrough settings", () => {
  const contractWithPolicies: ToolContract = {
    ...readContract,
    readiness: {
      toolRef: readContract.toolRef,
      originalInputSchema: readContract.inputSchema,
      effectiveInputSchema: readContract.inputSchema,
      semanticAssertions: [],
      fieldPolicies: {
        mailbox: { required: true, valuePolicy: "passthrough", description: "Which mailbox should this loop monitor?" },
        thread_id: { required: true, valuePolicy: "derivable" },
      },
      unresolvedRequirements: [],
      sourceHash: "hash",
      generatedBy: "model_annotation",
      generatedAt: "2026-06-15T00:00:00.000Z",
    },
  };
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [contractWithPolicies] });
  const selected = resolveBuildRequirement({
    contract,
    requirementId: "connector_selection",
    value: { selections: [{ toolkit: "gmail", accounts: [gmailAccount], actionSlugs: ["GMAIL_LIST_MESSAGES"] }] },
    discoveredToolContracts: [contractWithPolicies],
  });
  assert.ok(selected.requirements.some((entry) => entry.id.endsWith(":mailbox")));
  assert.equal(selected.requirements.some((entry) => entry.id.endsWith(":thread_id")), false);
});

test("approved behavioral specs preserve the resolved build contract", () => {
  let contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [] });
  for (const [requirementId, value] of [
    ["trigger_schedule", { trigger: "schedule", cron: "0 9 * * *", timezone: "UTC" }],
    ["stable_input:0", { name: "Customer segment", value: "Enterprise" }],
    ["grounding", { mode: "none" }],
    ["artifact_contract", { mode: "none" }],
    ["output_review_gates", { mode: "review_drafts" }],
  ] as const) {
    contract = resolveBuildRequirement({ contract, requirementId, value, discoveredToolContracts: [] });
  }
  assertBuildContractReady(contract);
  const spec = noSlopSpecSchema.parse({
    purpose: "Prepare a response",
    agents: [{ name: "Writer", goal: "Prepare a response" }],
    schedule: { description: "Daily", cron: "0 9 * * *", timezone: "UTC" },
    delivery: { provider: "none", description: "Dashboard only" },
    buildContract: contract,
  });
  assert.equal(spec.buildContract?.requirements.every((entry) => entry.status === "resolved"), true);
});

const hubspotSearchContract: ToolContract = {
  toolRef: "composio.hubspot.search",
  provider: "composio",
  name: "hubspot search",
  description: "Search HubSpot",
  skillTags: ["search"],
  effect: "read_external",
  resources: ["records"],
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object" },
  executionMode: "short_circuit",
  approval: { required: false },
  renderRecommendations: [],
  constraints: { toolkit: "hubspot", connected: true },
  source: "composio_sdk",
};

test("grounding resolves with optional externalDataToolkits when discovered", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [hubspotSearchContract] });
  const resolved = resolveBuildRequirement({
    contract,
    requirementId: "grounding",
    value: {
      mode: "sources",
      sources: [{ type: "tallei_memory" }, { type: "workspace_memory" }],
      externalDataToolkits: ["hubspot"],
    },
    discoveredToolContracts: [hubspotSearchContract],
  });
  const grounding = resolved.requirements.find((entry) => entry.id === "grounding")!;
  assert.equal(grounding.status, "resolved");
  assert.deepEqual(selectedExternalDataToolkits(resolved), ["hubspot"]);
  assert.deepEqual(selectedGroundingSources(resolved), [
    { type: "tallei_memory" },
    { type: "workspace_memory" },
  ]);
});

test("grounding rejects unknown externalDataToolkits", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [hubspotSearchContract] });
  const resolved = resolveBuildRequirement({
    contract,
    requirementId: "grounding",
    value: {
      mode: "sources",
      sources: [{ type: "workspace_memory" }],
      externalDataToolkits: ["salesforce"],
    },
    discoveredToolContracts: [hubspotSearchContract],
  });
  const grounding = resolved.requirements.find((entry) => entry.id === "grounding")!;
  assert.equal(grounding.status, "invalid");
  assert.match(grounding.validationErrors.join(" "), /salesforce/i);
});

test("resolveBuildRequirement ignores incomplete artifact re-resolve when already resolved", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [] });
  const fullValue = {
    mode: "supplied_template",
    template: JSON.stringify({
      designId: "minimal",
      templates: [{
        id: "t1",
        name: "Acknowledgment",
        subject: "We received your request",
        html: "<p>Thanks</p>",
      }],
    }),
  };
  const resolved = resolveBuildRequirement({
    contract,
    requirementId: "artifact_contract",
    value: fullValue,
    discoveredToolContracts: [],
  });
  assert.equal(resolved.requirements.find((entry) => entry.id === "artifact_contract")?.status, "resolved");

  const replayed = resolveBuildRequirement({
    contract: resolved,
    requirementId: "artifact_contract",
    value: {
      mode: "supplied_template",
      template: JSON.stringify({ designId: "minimal", templates: [{ id: "t1" }] }),
    },
    discoveredToolContracts: [],
  });
  const artifact = replayed.requirements.find((entry) => entry.id === "artifact_contract")!;
  assert.equal(artifact.status, "resolved");
  assert.equal(artifact.validationErrors.length, 0);
});

test("selectedArtifactContract parses rendered template bundle from artifact_contract", () => {
  const contract = deriveLoopBuildContract({ intentContext: intent, discoveredToolContracts: [] });
  const resolved = resolveBuildRequirement({
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
          text: "Thanks",
          reactEmailSource: JSON.stringify({ subject: "We received your request", greeting: "Hi", body: "Thanks", signOff: "Best" }),
        }],
      }),
    },
    discoveredToolContracts: [],
  });
  const artifacts = selectedArtifactContract(resolved);
  assert.ok(artifacts);
  assert.equal(artifacts?.mode, "supplied_template");
  assert.equal(artifacts?.templates.length, 1);
  assert.equal(artifacts?.templates[0]?.subject, "We received your request");
});
