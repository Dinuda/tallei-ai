import assert from "node:assert/strict";
import test from "node:test";

import {
  interleaveDiscoveredToolResults,
  mergeDiscoveredToolContracts,
  mergeRequiredToolContracts,
} from "../../../src/services/tool-spec/discovery.js";
import { normalizeComposioToolSearchResponse } from "../../../src/services/connectors/composio.js";
import { buildComposioActionContract } from "../../../src/services/tool-spec/tool-contracts.js";
import { buildLoopDefinition } from "../../../src/services/loop-executor/creator.js";
import { getEffectiveLoopConstraints, validateAgentRoster } from "../../../src/services/loop-executor/tool-catalog.js";

test("Composio search normalization accepts SDK list response envelopes", () => {
  const tool = { slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "gmail" } };
  assert.deepEqual(normalizeComposioToolSearchResponse([tool]), [tool]);
  assert.deepEqual(normalizeComposioToolSearchResponse({ items: [tool] }), [tool]);
  assert.deepEqual(normalizeComposioToolSearchResponse({ tools: [tool] }), [tool]);
  assert.deepEqual(normalizeComposioToolSearchResponse({ data: { items: [tool] } }), [tool]);
});

test("spec-required actions preserve an already discovered exact contract", async () => {
  const exact = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
    inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const merged = await mergeRequiredToolContracts([{
    contract: exact,
    connected: false,
    source: "composio_search",
  }], [{
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
  }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.contract.toolRef, exact.toolRef);
  assert.equal(merged[0]?.source, "composio_search");
});

test("discovery interleaves query results before applying the global cap", () => {
  const entry = (toolkit: string, actionSlug: string) => ({
    contract: buildComposioActionContract({
      toolkit,
      actionSlug,
      risk: "read" as const,
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
    }),
    connected: false,
    source: "composio_search" as const,
  });
  const merged = interleaveDiscoveredToolResults([
    [entry("search", "ONE"), entry("search", "TWO"), entry("search", "THREE")],
    [entry("gmail", "GMAIL_SEND_EMAIL")],
  ], 3);
  assert.deepEqual(merged.map((item) => item.contract.toolRef), [
    "composio.search.action.ONE",
    "composio.gmail.action.GMAIL_SEND_EMAIL",
    "composio.search.action.TWO",
  ]);
});

test("discovery merging preserves capability query provenance", () => {
  const contract = buildComposioActionContract({
    toolkit: "provider_x",
    actionSlug: "PROVIDER_X_SEND",
    risk: "send",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const [merged] = mergeDiscoveredToolContracts(
    [{ contract, connected: false, source: "learned_catalog", capabilityQueries: ["provider x create message"] }],
    [{ contract, connected: true, source: "composio_search", capabilityQueries: ["provider x send message"] }],
  );
  assert.equal(merged?.source, "composio_search");
  assert.equal(merged?.connected, true);
  assert.deepEqual(merged?.capabilityQueries, ["provider x create message", "provider x send message"]);
});

test("roster validation accepts persisted exact dynamic action contracts", async () => {
  const contract = buildComposioActionContract({
    toolkit: "googlecalendar",
    actionSlug: "GOOGLECALENDAR_FIND_EVENT",
    risk: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    outputSchema: { type: "object", properties: { events: { type: "array" } } },
  });
  const definition = buildLoopDefinition({
    task: "Read calendar",
    cron: "0 9 * * 1",
    timezone: "UTC",
    allowedToolRefs: [contract.toolRef],
    operatorInteractionPlan: { version: "v1", interactions: [] },
    agentGraph: {
      parent: { id: "parent", name: "Orchestrator", task: "Coordinate", policy: "Use declared contracts." },
      children: [{
        id: "reader",
        name: "Reader",
        task: "Read events",
        goal: "Read events",
        tools: [{ ref: contract.toolRef }],
      }],
    },
    builderMeta: {
      designedBy: "loop_architect",
      preApproved: true,
      planningIRVersion: "v2",
      planningIR: {},
      discoveredToolContracts: [contract as unknown as Record<string, unknown>],
    },
  });
  const auth = {
    userId: "user-a",
    tenantId: "tenant-a",
    authMode: "oauth" as const,
    plan: "pro" as const,
    connectorType: "agent_engine" as const,
  };
  const accepted = await validateAgentRoster({
    agents: [{ id: "reader", name: "Reader", task: "Read", goal: "Read", tools: [{ ref: contract.toolRef }] }],
    definition: getEffectiveLoopConstraints(definition),
    auth,
    strictConnectors: false,
  });
  assert.equal(accepted.ok, true);
});
