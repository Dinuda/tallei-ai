import assert from "node:assert/strict";
import test from "node:test";

import {
  hydrateDefinitionForExecution,
  resolveBuildContract,
  resolveDiscoveredToolContracts,
} from "../../../src/services/loop-runtime/definition-hydration.js";
import { definitionFromApprovedSpec } from "../../../src/services/loop-runtime/spec-run-types.js";
import type { ToolContract } from "../../../src/services/tool-spec/types.js";
import type { LoopDefinition } from "../../../src/services/loop-executor/types.js";

const accountId = "00000000-0000-4000-8000-000000000001";

function embeddedContract(): ToolContract {
  return {
    toolRef: "composio.gmail.action.GMAIL_FETCH_EMAILS",
    provider: "composio",
    name: "Fetch emails",
    description: "Fetch Gmail messages",
    skillTags: ["retrieve"],
    effect: "read_external",
    resources: ["gmail"],
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    executionMode: "short_circuit",
    approval: { required: false },
    renderRecommendations: [],
    constraints: { toolkit: "gmail", actionSlug: "GMAIL_FETCH_EMAILS", connected: true },
    source: "composio_sdk",
  };
}

function definitionWithBuildContract(): LoopDefinition {
  return {
    definitionVersion: 1,
    goal: "Monitor Gmail",
    schedule: { cron: "0 * * * *", timezone: "UTC" },
    schedulerTarget: "internal",
    allowedIntegrations: ["internal"],
    deliveryType: "gmail",
    buildContract: {
      version: "v1",
      requirements: [],
      issues: [],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
    agentGraph: {
      parent: { id: "orchestrator", name: "Orchestrator", task: "Run", policy: "Safe" },
      children: [{
        id: "context",
        name: "Context",
        goal: "Read tickets",
        tools: [{ ref: "composio.gmail.action.GMAIL_FETCH_EMAILS" }],
        guardrails: [],
        doneCriteria: [],
        failureModes: [],
      }],
    },
    builderMeta: {
      designedBy: "loop_architect",
      preApproved: true,
      specId: "00000000-0000-4000-8000-000000000099",
      discoveredToolContracts: [embeddedContract() as unknown as Record<string, unknown>],
    },
  };
}

test("resolveBuildContract reads only top-level build contract", () => {
  assert.ok(resolveBuildContract(definitionWithBuildContract()));
  assert.equal(resolveBuildContract({
    ...definitionWithBuildContract(),
    buildContract: undefined,
  }), null);
});

test("resolveDiscoveredToolContracts reads only embedded builderMeta contracts", () => {
  const contracts = resolveDiscoveredToolContracts(definitionWithBuildContract());
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0]?.toolRef, embeddedContract().toolRef);
  assert.deepEqual(resolveDiscoveredToolContracts({
    ...definitionWithBuildContract(),
    builderMeta: {
      designedBy: "loop_architect",
      preApproved: true,
    },
  }), []);
});

test("definitionFromApprovedSpec embeds discovered tool contracts in builderMeta", () => {
  const buildContract = {
    version: "v1" as const,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    issues: [],
    requirements: [{
      id: "connector_selection",
      kind: "connector" as const,
      question: "Tools",
      reason: "Runtime",
      required: true,
      allowNone: false,
      valueSchema: {},
      status: "resolved" as const,
      value: {
        selections: [{
          toolkit: "gmail",
          accounts: [{ id: accountId }],
          actionSlugs: ["GMAIL_FETCH_EMAILS"],
        }],
      },
      validationErrors: [],
      warnings: [],
    }],
  };
  const discovered = [embeddedContract()];

  const definition = definitionFromApprovedSpec({
    snapshot: {
      id: "00000000-0000-4000-8000-000000000099",
      slug: "support",
      title: "Support",
      version: 1,
      bodyMarkdown: "",
      approvedAt: "2026-06-20T00:00:00.000Z",
      buildContract,
      specJson: {
        purpose: "Monitor Gmail",
        agents: [{
          name: "Context Specialist",
          goal: "Read inbox",
          tools: ["composio.gmail.action.GMAIL_FETCH_EMAILS"],
          guardrails: ["Do not send."],
          doneWhen: ["Context ready"],
          failureModes: [],
          artifactRole: "source_evidence",
          outputArtifactKind: "structured_output",
        }],
        guardrails: [],
        successCriteria: [],
        failureModes: [],
        delivery: { provider: "gmail", description: "Gmail drafts" },
        schedule: { description: "Hourly" },
        connectorPolicy: { allowedReadActions: [], allowedWriteActions: [] },
        inputRequirements: [],
      },
    },
    buildContract,
    discoveredToolContracts: discovered,
    cron: "0 * * * *",
    timezone: "UTC",
    builderSessionId: "00000000-0000-4000-8000-000000000088",
  });

  assert.equal(definition.builderMeta?.specId, "00000000-0000-4000-8000-000000000099");
  assert.equal(definition.builderMeta?.workflowBuilderSessionId, "00000000-0000-4000-8000-000000000088");
  assert.equal(definition.builderMeta?.discoveredToolContracts?.length, 1);
  assert.equal(definition.builderMeta?.discoveredToolContracts?.[0]?.toolRef, embeddedContract().toolRef);
  assert.equal(definition.ceo, undefined);
  assert.equal(definition.draftPolicy, undefined);
});

test("hydrateDefinitionForExecution expands slim definitions without DB access", async () => {
  const definition = definitionWithBuildContract();
  const hydrated = await hydrateDefinitionForExecution(
    { tenantId: "00000000-0000-4000-8000-000000000010", userId: "00000000-0000-4000-8000-000000000011", scopes: [] } as any,
    "00000000-0000-4000-8000-000000000012",
    definition,
  );

  assert.ok(hydrated.ceo);
  assert.ok(hydrated.agentGraph.children[0]?.guardrails);
});

test("hydrateDefinitionForExecution is a no-op for fully expanded definitions", async () => {
  const definition = {
    ...definitionWithBuildContract(),
    ceo: { name: "Orchestrator", task: "Run", policy: "Safe" },
    draftPolicy: {
      requireDraftBeforeExternalAction: true,
      approvalRequiredFor: ["send"],
    },
  };

  const hydrated = await hydrateDefinitionForExecution(
    { tenantId: "00000000-0000-4000-8000-000000000010", userId: "00000000-0000-4000-8000-000000000011", scopes: [] } as any,
    "00000000-0000-4000-8000-000000000012",
    definition,
  );

  assert.strictEqual(hydrated, definition);
});
