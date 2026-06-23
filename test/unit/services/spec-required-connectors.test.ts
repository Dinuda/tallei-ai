import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveRequiredConnectorActionsFromSpec,
  prioritizeDiscoveredConnectors,
  specSemanticPipeline,
  supplementDiscoveryQueriesFromSpec,
} from "../../../src/services/conductor/domain/spec-required-connectors.js";
import {
  buildComposioActionContract,
} from "../../../src/services/tool-spec/tool-contracts.js";

const newsletterSpec = {
  purpose: "Produce and send a weekly AI-industry newsletter and schedule a follow-up meeting.",
  delivery: {
    provider: "google_calendar",
    description: "Send the newsletter email to the specified recipient list and create a Google Calendar invite for the next day at 13:00.",
  },
  agents: [{
    goal: "Send the finalized newsletter email and create a calendar invite for the next day.",
    doneWhen: ["The email is delivered to all addresses in the provided recipientList."],
  }],
};

test("deriveRequiredConnectorActionsFromSpec defers explicit provider action selection to discovery", () => {
  const actions = deriveRequiredConnectorActionsFromSpec(newsletterSpec);
  assert.deepEqual(actions, []);
});

test("supplementDiscoveryQueriesFromSpec searches the explicit provider generically", () => {
  const queries = supplementDiscoveryQueriesFromSpec(["ai news research"], newsletterSpec);
  assert.equal(queries.some((query) => query.startsWith("google_calendar ")), true);
  assert.equal(queries.some((query) => /gmail/i.test(query)), false);
});

test("explicit provider is included in discovery without suppressing secondary capabilities", () => {
  const spec = {
    purpose: "Create a newsletter with the latest news in the AI space.",
    delivery: {
      provider: "customer_io",
      description: "Send the newsletter to subscribers.",
    },
    agents: [{
      goal: "Create and send a subscriber-ready AI news newsletter.",
      doneWhen: ["The newsletter is delivered to subscribers."],
    }],
  };
  const actions = deriveRequiredConnectorActionsFromSpec(spec);
  assert.deepEqual(actions, []);
  assert.equal(
    supplementDiscoveryQueriesFromSpec(["latest ai news"], spec)
      .some((query) => query.startsWith("customer_io ")),
    true,
  );
});

test("explicit provider is attached to each atomic capability search", () => {
  const queries = supplementDiscoveryQueriesFromSpec(
    ["create campaign", "set campaign content", "send campaign"],
    {
      purpose: "Publish a newsletter.",
      delivery: { provider: "provider_x", description: "Deliver the final newsletter." },
      agents: [],
    },
  );
  assert.equal(queries.every((query) => query.startsWith("provider_x ")), true);
  assert.equal(queries.some((query) => query.includes("send campaign")), true);
});

test("specSemanticPipeline preserves reviewed agent order through selectedActions", () => {
  const pipeline = specSemanticPipeline({
    agents: [
      { name: "Research Agent", goal: "Research", guardrails: [], doneWhen: [], failureModes: [] },
      { name: "Analysis Agent", goal: "Analyze", guardrails: [], doneWhen: [], failureModes: [] },
      { name: "Content Agent", goal: "Write", guardrails: [], doneWhen: [], failureModes: [] },
    ],
  });
  assert.deepEqual(pipeline.map((step) => step.downstream), ["Analysis Agent", "Content Agent", "selectedActions"]);
});

test("prioritizeDiscoveredConnectors keeps only spec-required toolkits when present", () => {
  const gmail = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
    inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const calendar = buildComposioActionContract({
    toolkit: "googlecalendar",
    actionSlug: "GOOGLECALENDAR_CREATE_EVENT",
    risk: "write",
    inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const noise = buildComposioActionContract({
    toolkit: "apify_mcp",
    actionSlug: "APIFY_MCP_SEARCH_ACTORS",
    risk: "write",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
  });
  const prioritized = prioritizeDiscoveredConnectors([
    { contract: noise, connected: false, source: "composio_search" },
    { contract: gmail, connected: false, source: "required_spec" },
    { contract: calendar, connected: false, source: "required_spec" },
  ], [
    { toolkit: "gmail", actionSlug: "GMAIL_SEND_EMAIL", risk: "send" },
    { toolkit: "googlecalendar", actionSlug: "GOOGLECALENDAR_CREATE_EVENT", risk: "write" },
  ]);
  assert.deepEqual(prioritized.map((entry) => entry.contract.toolRef), [gmail.toolRef, calendar.toolRef]);
});

test("prioritizeDiscoveredConnectors orders any preferred available provider first", () => {
  const preferred = buildComposioActionContract({
    toolkit: "customer_io",
    actionSlug: "CUSTOMER_IO_SEND_BROADCAST",
    risk: "send",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const alternative = buildComposioActionContract({
    toolkit: "gmail",
    actionSlug: "GMAIL_SEND_EMAIL",
    risk: "send",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const prioritized = prioritizeDiscoveredConnectors([
    { contract: alternative, connected: false, source: "composio_search" },
    { contract: preferred, connected: false, source: "composio_search" },
  ], [], "customer-io");
  assert.deepEqual(prioritized.map((entry) => entry.contract.toolRef), [preferred.toolRef, alternative.toolRef]);
});
