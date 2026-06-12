import assert from "node:assert/strict";
import test from "node:test";

import {
  discoveryQueriesForRequiredActions,
  inferRequiredConnectorActions,
  interleaveDiscoveredToolResults,
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

test("inferRequiredConnectorActions adds gmail send for newsletter delivery prompts", () => {
  const actions = inferRequiredConnectorActions({
    prompt: "Create and send a weekly newsletter to subscribers",
    deliveryProvider: "none",
    deliveryDescription: "Send the newsletter email.",
  });
  assert.deepEqual(actions, [{
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
  }]);
});

test("inferRequiredConnectorActions parses an explicit composio delivery provider", () => {
  const actions = inferRequiredConnectorActions({
    prompt: "Send updates",
    deliveryProvider: "composio.resend.action.resend_send_email",
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.toolkit, "resend");
  assert.equal(actions[0]?.actionSlug, "RESEND_SEND_EMAIL");
  assert.equal(actions[0]?.risk, "send");
});

test("discoveryQueriesForRequiredActions appends toolkit queries when search missed delivery", () => {
  const queries = discoveryQueriesForRequiredActions(["web research"], [{
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
  }]);
  assert.deepEqual(queries, ["web research", "gmail send email"]);
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
    "composio.search.action.one",
    "composio.gmail.action.gmail_send_email",
    "composio.search.action.two",
  ]);
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
