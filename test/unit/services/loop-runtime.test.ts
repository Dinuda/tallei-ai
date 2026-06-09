import assert from "node:assert/strict";
import test from "node:test";

import { buildCanvasEmailTemplate } from "../../../src/services/loop-runtime/email-canvas.js";
import { normalizeLoopDefinitionForRuntime } from "../../../src/services/loop-runtime/normalize-definition.js";
import { runtimeDefinitionSchema } from "../../../src/services/loop-runtime/types.js";
import { getLoopTool, listLoopTools } from "../../../src/services/loop-executor/tool-catalog.js";
import { buildLoopDefinition } from "../../../src/services/loop-executor/creator.js";

function stableDefinition() {
  return {
    definitionVersion: "loop_executor_v2",
    engineVersion: "loop_engine_v3",
    goal: "Create a reviewed weekly brief",
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    schedulerTarget: "internal",
    allowedIntegrations: ["internal"],
    ceo: { name: "Parent", task: "Coordinate", policy: "Use reviewed artifacts" },
    draftPolicy: { requireDraftBeforeExternalAction: true, approvalRequiredFor: [] },
    delivery: { provider: "none", target: "none" },
    agentGraph: {
      parent: { id: "parent", name: "Parent", task: "Coordinate", policy: "Use reviewed artifacts" },
      children: [{
        id: "writer",
        name: "Writer",
        task: "Write the brief",
        goal: "Produce a complete brief",
        tools: [{ ref: "internal.llm_only" }],
        gate: { type: "draft_review", question: "Approve this brief?" },
      }],
    },
  };
}

test("stable runtime accepts a v3 artifact-only definition", () => {
  assert.equal(runtimeDefinitionSchema.parse(stableDefinition()).engineVersion, "loop_engine_v3");
});

test("stable runtime accepts canvas.email and canvas.preview as a render target, not a tool", () => {
  const parsed = runtimeDefinitionSchema.parse({
    ...stableDefinition(),
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        ...stableDefinition().agentGraph.children[0],
        renderTarget: "canvas.email",
      }],
    },
  });
  assert.equal(parsed.agentGraph?.children[0]?.renderTarget, "canvas.email");
  assert.equal(listLoopTools().some((tool) => tool.ref === "canvas.email"), false);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...stableDefinition(),
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        ...stableDefinition().agentGraph.children[0],
        renderTarget: "canvas.preview",
      }],
    },
  }).success, true);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...stableDefinition(),
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        ...stableDefinition().agentGraph.children[0],
        renderTarget: "canvas.document",
      }],
    },
  }).success, false);
});

test("stable runtime rejects legacy definitions and outbound delivery", () => {
  assert.equal(runtimeDefinitionSchema.safeParse({ ...stableDefinition(), engineVersion: undefined }).success, false);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...stableDefinition(),
    delivery: { provider: "composio.gmail.action.gmail_send_email", target: "team_email" },
  }).success, false);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...stableDefinition(),
    presetId: "newsletter",
  }).success, false);
});

test("normalize remaps writer pre_send gate to draft_review before runtime validation", () => {
  const invalid = {
    ...stableDefinition(),
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        ...stableDefinition().agentGraph.children[0],
        name: "Writer Agent",
        renderTarget: "canvas.email",
        gate: { type: "pre_send", question: "Confirm the final version before sending?" },
      }],
    },
  };
  assert.equal(runtimeDefinitionSchema.safeParse(invalid).success, false);
  const normalized = normalizeLoopDefinitionForRuntime(invalid as never);
  assert.equal(normalized.agentGraph?.children[0]?.gate?.type, "draft_review");
  assert.equal(runtimeDefinitionSchema.safeParse(normalized).success, true);
});

test("stable runtime accepts approved connector action only with pre-send gate", () => {
  const connectorPolicy = {
    enabledToolkits: ["gmail"],
    allowedReadActions: [],
    allowedWriteActions: [{
      toolkit: "gmail",
      actionSlug: "gmail_send_email",
      risk: "send",
      requiresPreSendApproval: true,
    }],
    recipientSource: { kind: "uploaded", description: "Uploaded contacts for this run." },
    deliveryExpectation: "Send after approval.",
  };
  const approved = {
    ...stableDefinition(),
    allowedIntegrations: ["internal", "gmail"],
    allowedToolRefs: ["composio.gmail.action.gmail_send_email"],
    delivery: { provider: "composio.gmail.action.gmail_send_email", target: "team_email" },
    connectorPolicy,
    builderMeta: {
      designedBy: "loop_architect",
      engineVersion: "loop_engine_v3",
      preApproved: true,
      noSlopSpec: {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "send-email",
        version: 1,
        title: "Send email",
        bodyMarkdown: "# Send email",
        approvedAt: "2026-06-09T00:00:00.000Z",
        specJson: {
          purpose: "Send an approved email.",
          agents: [{ name: "Sender", goal: "Send after approval.", guardrails: [], doneWhen: [], failureModes: [] }],
          guardrails: ["Do not send before approval."],
          successCriteria: ["Connector action completes after approval."],
          failureModes: ["Block if contacts are missing."],
          schedule: { description: "Weekly", cron: "0 9 * * 1", timezone: "UTC" },
          delivery: { target: "team_email", description: "Send approved email." },
          connectorPolicy,
        },
      },
    },
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        id: "sender",
        name: "Sender",
        task: "Send the approved email.",
        goal: "Send after approval",
        tools: [{ ref: "composio.gmail.action.gmail_send_email" }],
        gate: { type: "pre_send", question: "Approve this send?" },
      }],
    },
  };
  assert.equal(runtimeDefinitionSchema.safeParse(approved).success, true);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...approved,
    agentGraph: {
      ...approved.agentGraph,
      children: [{ ...approved.agentGraph.children[0], gate: undefined }],
    },
  }).success, false);
});

test("stable runtime rejects subscriber delivery with draft-only connector action", () => {
  const connectorPolicy = {
    enabledToolkits: ["create_email_draft"],
    allowedReadActions: [],
    allowedWriteActions: [{
      toolkit: "create_email_draft",
      actionSlug: "create_email_draft",
      risk: "send",
      requiresPreSendApproval: true,
    }],
    recipientSource: { kind: "uploaded", description: "Uploaded contacts for this run." },
    deliveryExpectation: "Send after approval.",
  };
  const definition = {
    ...stableDefinition(),
    allowedIntegrations: ["internal", "create_email_draft"],
    allowedToolRefs: ["composio.create_email_draft.action.create_email_draft"],
    delivery: { provider: "composio.create_email_draft.action.create_email_draft", target: "subscriber_list" },
    connectorPolicy,
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        id: "sender",
        name: "Sender",
        task: "Send the approved newsletter.",
        goal: "Send after approval",
        tools: [{ ref: "composio.create_email_draft.action.create_email_draft" }],
        gate: { type: "pre_send", question: "Approve this send?" },
      }],
    },
  };
  assert.equal(runtimeDefinitionSchema.safeParse(definition).success, false);
});

test("dynamic composio action refs resolve through the tool catalog", () => {
  const tool = getLoopTool("composio.notion.action.notion_create_page");
  assert.equal(tool?.ref, "composio.notion.action.notion_create_page");
  assert.equal(tool?.requiresApproval, true);
  assert.equal(tool?.toolkit, "notion");
});

test("connected app search tools are executable v3 tools", () => {
  assert.equal(listLoopTools().some((tool) => tool.ref === "composio.github.search"), true);
  const definition = buildLoopDefinition({
    task: "Create a weekly changelog from GitHub activity",
    cron: "0 9 * * 1",
    timezone: "UTC",
    agentGraph: {
      parent: { id: "parent", name: "Parent", task: "Coordinate", policy: "Use reviewed artifacts" },
      children: [{
        id: "github_research",
        name: "GitHub Research Agent",
        task: "Search GitHub for repository activity.",
        goal: "Return relevant GitHub activity",
        tools: [{ ref: "composio.github.search" }],
      }],
    },
    delivery: { provider: "none", target: "none" },
    engineVersion: "loop_engine_v3",
  });
  assert.equal(definition.allowedIntegrations.includes("github"), true);
  assert.equal(runtimeDefinitionSchema.safeParse(definition).success, true);
});

test("canvas email renderer returns editable template without delivery footer", () => {
  const template = buildCanvasEmailTemplate({
    markdown: [
      "Subject: Product update",
      "Preview: The short version.",
      "",
      "# Product update",
      "",
      "We shipped **stable loops**.",
      "- No outbound delivery",
    ].join("\n"),
  });
  assert.equal(template.subject, "Product update");
  assert.equal(template.preview, "The short version.");
  assert.equal(template.source, "runtime");
  assert.match(template.html, /stable loops/);
  assert.equal(template.html.includes("RESEND_UNSUBSCRIBE_URL"), false);
  assert.equal(template.design.body.rows.length > 0, true);
});
