import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveRequiredConnectorActionsFromSpec,
  prioritizeDiscoveredConnectors,
  specSemanticPipeline,
  supplementDiscoveryQueriesFromSpec,
} from "../../../src/services/loop-engine/spec-required-connectors.js";
import { validateOutboundDeliveryPlan } from "../../../src/services/loop-engine/architect.js";
import { compileLoopPlanningIR, loopPlanningIRSchema } from "../../../src/services/loop-engine/planning-ir.js";
import {
  buildComposioActionContract,
  getStaticToolContract,
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

test("planning compiler accepts contacts_csv array binding to calendar attendees", () => {
  const calendar = buildComposioActionContract({
    toolkit: "googlecalendar",
    actionSlug: "GOOGLECALENDAR_CREATE_EVENT",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        start: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "start", "attendees"],
    },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const plan = loopPlanningIRSchema.parse({
    version: "v2",
    title: "Weekly brief",
    summary: "Schedule follow-up.",
    strategy: "Write and schedule.",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [{
      key: "calendarInviteAttendees",
      label: "Attendees",
      description: "Attendee list.",
      lifecycle: "runtime_input",
      timing: "before_action",
      sensitivity: "private",
      surface: "input.contacts_csv",
      valueType: "array",
      sourceKind: "operator_input",
      status: "resolved",
      stableScalar: null,
    }],
    semanticAgents: [{
      id: "writer",
      name: "Writer",
      responsibility: "Write invite summary.",
      task: "Write.",
      toolRef: "internal.llm_only",
      inputBindings: [],
      outputArtifact: {
        id: "draft",
        description: "Draft",
        representation: "json",
        visibility: "internal",
        rendererRef: null,
        reviewMode: "none",
        editable: false,
        fields: [{ path: "/subject", type: "string", required: true }],
      },
    }],
    selectedActions: [{
      id: "schedule",
      contractRef: calendar.toolRef,
      purpose: "Create invite.",
      annotation: { effect: "write_external", confidence: "high", approvalRequired: true },
      bindings: [
        { source: { kind: "agent_output", nodeId: "writer", path: "/subject" }, targetPath: "/summary", required: true, valuePolicy: "derivable", provenance: "agent_output" },
        { source: { kind: "required_value", key: "calendarInviteAttendees", path: "/" }, targetPath: "/attendees", required: true, valuePolicy: "passthrough", provenance: "operator_input" },
        { source: { kind: "required_value", key: "calendarInviteAttendees", path: "/" }, targetPath: "/start", required: true, valuePolicy: "passthrough", provenance: "operator_input" },
      ],
    }],
    unresolvedIssues: [],
  });
  const compiled = compileLoopPlanningIR({
    planningIR: plan,
    contracts: [getStaticToolContract("internal.llm_only")!, calendar],
  });
  assert.equal(compiled.ok, true);
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

test("outbound delivery rejects an alternative provider action", () => {
  const alternative = buildComposioActionContract({
    toolkit: "provider_y",
    actionSlug: "PROVIDER_Y_SEND",
    risk: "send",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const issues = validateOutboundDeliveryPlan({
    provider: "provider_x",
    connectorContracts: [alternative],
    planningIR: loopPlanningIRSchema.parse({
      version: "v2",
      title: "Newsletter",
      summary: "Send newsletter.",
      strategy: "Compose and send.",
      schedule: { cron: "0 9 * * 5", timezone: "UTC" },
      requiredValues: [],
      semanticAgents: [],
      selectedActions: [],
      unresolvedIssues: [],
    }),
  });
  assert.deepEqual(issues.map((issue) => issue.code), ["required_external_capability_undiscovered"]);
});

test("outbound delivery requires matching-provider lineage from the final semantic artifact", () => {
  const send = buildComposioActionContract({
    toolkit: "provider_x",
    actionSlug: "PROVIDER_X_SEND",
    risk: "send",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  const base = {
    version: "v2" as const,
    title: "Newsletter",
    summary: "Send newsletter.",
    strategy: "Compose and send.",
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    requiredValues: [],
    semanticAgents: [{
      id: "composer",
      name: "Composer",
      responsibility: "Compose newsletter.",
      task: "Compose.",
      toolRef: "internal.llm_only",
      inputBindings: [],
      outputArtifact: {
        id: "draft",
        description: "Draft",
        representation: "text" as const,
        visibility: "internal" as const,
        rendererRef: null,
        reviewMode: "none" as const,
        editable: false,
        fields: [],
      },
    }],
    selectedActions: [{
      id: "send",
      contractRef: send.toolRef,
      purpose: "Send newsletter.",
      annotation: { effect: "write_external" as const, confidence: "high" as const, approvalRequired: true },
      bindings: [],
    }],
    unresolvedIssues: [],
  };
  const missing = validateOutboundDeliveryPlan({
    provider: "provider_x",
    connectorContracts: [send],
    planningIR: loopPlanningIRSchema.parse(base),
  });
  assert.deepEqual(missing.map((issue) => issue.code), ["external_delivery_missing_lineage"]);

  const valid = validateOutboundDeliveryPlan({
    provider: "provider_x",
    connectorContracts: [send],
    planningIR: loopPlanningIRSchema.parse({
      ...base,
      selectedActions: [{
        ...base.selectedActions[0],
        bindings: [{
          source: { kind: "agent_output", nodeId: "composer", path: "/text" },
          targetPath: "/body",
          required: true,
          valuePolicy: "derivable",
          provenance: "agent_output",
        }],
      }],
    }),
  });
  assert.deepEqual(valid, []);
});
