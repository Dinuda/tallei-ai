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

test("stable runtime rejects invalid definitions and outbound delivery", () => {
  assert.equal(runtimeDefinitionSchema.safeParse({ ...stableDefinition(), engineVersion: undefined }).success, false);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...stableDefinition(),
    delivery: { provider: "composio.gmail.action.gmail_send_email", target: "team_email" },
  }).success, false);
});

test("normalize does not remap writer pre_send gate before runtime validation", () => {
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
  assert.equal(normalized.agentGraph?.children[0]?.gate?.type, "pre_send");
  assert.equal(runtimeDefinitionSchema.safeParse(normalized).success, false);
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

test("stable runtime accepts approved generic external write action with approval gate", () => {
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
  assert.equal(runtimeDefinitionSchema.safeParse(definition).success, true);
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
  assert.equal(template.finalUse, false);
  assert.equal(template.source, "runtime");
  assert.match(template.html, /stable loops/);
  assert.equal(template.html.includes("RESEND_UNSUBSCRIBE_URL"), false);
  assert.equal(template.design.body.rows.length > 0, true);
});

test("canvas email renderer strips boilerplate from final-use content", () => {
  const template = buildCanvasEmailTemplate({
    finalUse: true,
    markdown: [
      "Subject: Weekly sync: memory persistence, multi-tenant isolation, and next steps",
      "Preview: Final preview is approved and ready to send.",
      "",
      "Here's a ready-to-send internal sync email draft you can use. It's written in a casual, founder-to-team voice and uses only the sprint notes you provided.",
      "",
      "JUNE 11, 2026",
      "",
      "# Weekly sync: memory persistence, multi-tenant isolation, and next steps",
      "",
      "Hey team,",
      "",
      "Shipped this week",
      "",
      "- Implemented persistent storage API endpoints and workspace authentication layer to strengthen multi-tenant data safety and access control.",
      "",
      "In progress",
      "",
      "- Multi-tenant data isolation is about 70% done; API docs generation and a performance monitoring dashboard are in progress.",
      "",
      "Sending plan and required confirmations",
      "",
      "Recipients: I'll use the uploaded contacts CSV or the configured audience_id you provide. Please share:",
      "",
      "Permissions: I'll verify you're authorized to send to this audience and check any Gmail/connector permissions before sending.",
      "",
      "Confirm send: Please reply once you've uploaded the contacts or shared the audience_id. I'll run format checks, confirm, and send.",
      "",
      "If you want, I can draft the email with your exact sender name and tailor the sign-off once you drop in your name and the recipient list.",
    ].join("\n"),
  });

  assert.equal(template.finalUse, true);
  assert.equal(template.subject, "Weekly sync: memory persistence, multi-tenant isolation, and next steps");
  assert.equal(/ready-to-send internal sync email draft/i.test(template.text), false);
  assert.equal(/sending plan and required confirmations/i.test(template.text), false);
  assert.equal(/confirm send:/i.test(template.text), false);
  assert.equal(/drop in your name/i.test(template.text), false);
  assert.match(template.text, /Shipped this week/);
  assert.match(template.text, /Multi-tenant data isolation is about 70% done/);
  assert.match(template.html, /Shipped this week/);
  assert.equal(template.html.includes("ready-to-send internal sync email draft"), false);
});

test("canvas email renderer strips html-friendly version blocks", () => {
  const template = buildCanvasEmailTemplate({
    finalUse: true,
    markdown: [
      "Subject: Weekly AI News Roundup",
      "Preview: AI news from the week.",
      "",
      "Top AI News This Week",
      "",
      "HTML-friendly version",
      "",
      "<!-- Simple HTML-friendly newsletter version -->",
      "<div style=\"font-family: Arial, sans-serif; color: #1a1a1a; max-width: 680px;\">",
      "<h2 style=\"border-bottom: 1px solid #ddd; padding-bottom: 6px;\">Top AI News This Week</h2>",
      "<article style=\"margin-bottom: 20px;\"><h3 style=\"margin: 0 0 6px 0;\">Google open-sources speedy DiffusionGemma text diffusion model</h3><p style=\"margin: 0; line-height: 1.5;\">Google has open-sourced DiffusionGemma.</p></article>",
      "</div>",
    ].join("\n"),
  });

  assert.equal(template.finalUse, true);
  assert.match(template.text, /Top AI News This Week/);
  assert.equal(/HTML-friendly version/i.test(template.text), false);
  assert.equal(/<div style=/i.test(template.text), false);
  assert.equal(/<article style=/i.test(template.text), false);
  assert.equal(template.html.includes("HTML-friendly version"), false);
  assert.equal(template.html.includes("Simple HTML-friendly newsletter version"), false);
  assert.equal(template.html.includes("Google open-sources speedy DiffusionGemma text diffusion model"), false);
});

test("canvas email renderer unwraps serialized text envelopes", () => {
  const template = buildCanvasEmailTemplate({
    markdown: JSON.stringify({
      text: "Subject: Weekly AI Roundup\nPreview: Four important stories.\n\n## This week\nClean body copy.",
    }),
  });

  assert.equal(template.subject, "Weekly AI Roundup");
  assert.equal(template.preview, "Four important stories.");
  assert.match(template.text, /Clean body copy/);
  assert.equal(template.text.includes('{"text"'), false);
  assert.equal(template.html.includes("&quot;text&quot;"), false);
});

test("normalize preserves explicit review agents and does not add writer gates", () => {
  const definition = {
    ...stableDefinition(),
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [
        {
          id: "writer",
          name: "Writer Agent",
          task: "Write newsletter",
          goal: "Produce newsletter draft",
          tools: [{ ref: "internal.llm_only" }],
        },
        {
          id: "approval_qa",
          name: "Approval & QA Agent",
          task: "Review upstream draft",
          goal: "Approve newsletter quality",
          tools: [{ ref: "internal.llm_only" }],
          gate: { type: "draft_review", question: "Approve?" },
        },
      ],
    },
  };
  const normalized = normalizeLoopDefinitionForRuntime(definition as never);
  assert.equal(normalized.agentGraph?.children.length, 2);
  assert.equal(normalized.agentGraph?.children[0]?.gate, undefined);
  assert.equal(normalized.agentGraph?.children[0]?.renderTarget, undefined);
  assert.equal(normalized.agentGraph?.children[1]?.gate?.type, "draft_review");
});

test("injectDeliveryRecipientsIntoPayload adds email recipients for send actions", async () => {
  const { injectDeliveryRecipientsIntoPayload } = await import("../../../src/services/loop-runtime/recipient-resolution.js");
  const payload = injectDeliveryRecipientsIntoPayload({
    payload: { subject: "Hello", content: "Body" },
    context: {
      inputs: {},
      approvedMemories: [],
      approvedSources: {},
      operatorRevisions: {},
      deliveryRecipients: {
        uploadedAt: "2026-06-09T00:00:00.000Z",
        contacts: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
        recipientCount: 2,
        source: "uploaded",
      },
    },
    actionSlug: "RESEND_SEND_EMAIL",
  });
  assert.deepEqual(payload.to, ["alice@example.com", "bob@example.com"]);
  assert.deepEqual(payload.recipients, ["alice@example.com", "bob@example.com"]);
});

test("resolveRecipientStatus is ready when configured audience id exists", async () => {
  const { resolveRecipientStatus } = await import("../../../src/services/loop-runtime/recipient-resolution.js");
  assert.equal(resolveRecipientStatus({
    recipientSource: { kind: "configured" },
    context: { inputs: {}, approvedMemories: [], approvedSources: {}, operatorRevisions: {} },
    assignmentConfig: { audience_id: "aud_123" },
  }), "ready");
});

test("normalize preserves web search agents without forced source confirmation", () => {
  const definition = {
    ...stableDefinition(),
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        id: "research",
        name: "Research Agent",
        task: "Search web",
        goal: "Find sources",
        tools: [{ ref: "internal.web_search" }],
      }],
    },
  };
  const normalized = normalizeLoopDefinitionForRuntime(definition as never);
  assert.equal(normalized.agentGraph?.children[0]?.gate, undefined);
});
