import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveRequiredConnectorActionsFromSpec,
  prioritizeDiscoveredConnectors,
  specSemanticPipeline,
  supplementDiscoveryQueriesFromSpec,
} from "../../../src/services/loop-engine/spec-required-connectors.js";
import { compileLoopPlanningIR, loopPlanningIRSchema } from "../../../src/services/loop-engine/planning-ir.js";
import { getStaticToolContract } from "../../../src/services/tool-spec/tool-contracts.js";
import { buildComposioActionContract } from "../../../src/services/tool-spec/tool-contracts.js";

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

test("deriveRequiredConnectorActionsFromSpec requires gmail send and calendar create for newsletter spec", () => {
  const actions = deriveRequiredConnectorActionsFromSpec(newsletterSpec);
  assert.equal(actions.some((action) => action.toolkit === "gmail" && action.actionSlug === "GMAIL_SEND_EMAIL"), true);
  assert.equal(actions.some((action) => action.toolkit === "googlecalendar" && action.actionSlug === "GOOGLECALENDAR_CREATE_EVENT"), true);
});

test("supplementDiscoveryQueriesFromSpec adds gmail and calendar queries", () => {
  const queries = supplementDiscoveryQueriesFromSpec(["ai news research"], newsletterSpec);
  assert.equal(queries.includes("gmail send email"), true);
  assert.equal(queries.includes("google calendar create event"), true);
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
  ], deriveRequiredConnectorActionsFromSpec(newsletterSpec));
  assert.deepEqual(prioritized.map((entry) => entry.contract.toolRef), [gmail.toolRef, calendar.toolRef]);
});
