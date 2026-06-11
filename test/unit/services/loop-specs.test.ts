import assert from "node:assert/strict";
import test from "node:test";

import { noSlopSpecDraftSchema, noSlopSpecSchema, noSlopSpecSnapshotSchema } from "../../../src/services/loop-engine/spec-contracts.js";
import { critiqueLoopDesign } from "../../../src/services/loop-engine/critic.js";
import type { LoopArchitectOutput } from "../../../src/services/loop-engine/contracts.js";
import { approvedSpecSnapshot, mapLoopSpecRowForTest, prepareLoopSpecJsonForValidation, type LoopSpecView } from "../../../src/services/loop-builder/specs.js";

const specJson = noSlopSpecSchema.parse({
  purpose: "Create a weekly market research digest.",
  agents: [
    {
      name: "Research Agent",
      goal: "Find recent market sources.",
      guardrails: ["Sources must be recent and cited."],
      doneWhen: ["At least five sources include URLs."],
      failureModes: ["Pause if fewer than three sources are found."],
    },
    {
      name: "Synthesis Agent",
      goal: "Write a cited digest.",
      guardrails: ["Every claim must cite a source."],
      doneWhen: ["Digest includes executive summary and trends."],
      failureModes: ["Skip synthesis if research is insufficient."],
    },
  ],
  guardrails: ["Do not invent facts."],
  successCriteria: ["The final digest is cited and ready for review."],
  failureModes: ["Pause for input when source quality is insufficient."],
  schedule: { description: "Weekly Monday morning", cron: "0 9 * * 1", timezone: "UTC" },
  delivery: { target: "none", description: "Dashboard only." },
});

const snapshot = noSlopSpecSnapshotSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  slug: "market-research",
  version: 1,
  title: "Market research digest",
  bodyMarkdown: "# Market research digest\n\nApproved spec.",
  specJson,
  approvedAt: "2026-06-09T00:00:00.000Z",
});

function baseDesign(): LoopArchitectOutput {
  return {
    title: "Weekly market digest",
    summary: "Create a cited weekly market research digest ready for review.",
    strategyText: "Find recent sources, synthesize cited trends, and prepare a reviewed digest.",
    inputsRequired: [],
    delivery: { provider: "none", target: "none" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [
      {
        id: "research_agent",
        name: "Research Agent",
        goal: "Find recent market sources with URLs.",
        task: "Find at least five recent and cited market sources. Pause if fewer than three sources are found.",
        tool: "internal.memory_search",
        inputContract: { description: "Focused research topic", schema: { query: "string" } },
        outputContract: { description: "Recent sources with URLs", schema: { sources: [{ url: "string" }] } },
        doneCriteria: ["At least five sources include URLs", "Sources are recent and cited"],
      },
      {
        id: "synthesis_agent",
        name: "Synthesis Agent",
        goal: "Write a cited digest.",
        task: "Write a digest with executive summary and trends. Every claim must cite a source and do not invent facts.",
        tool: "internal.llm_only",
        artifactRole: "draft_body",
        renderTarget: "canvas.email",
        inputContract: { description: "Research sources", schema: { sources: "array" } },
        outputContract: { description: "Final cited digest ready for review", schema: { digest: "string" } },
        doneCriteria: ["Digest includes executive summary and trends", "The final digest is cited and ready for review"],
        gate: { type: "draft_review", question: "Review this digest in the canvas before continuing." },
      },
    ],
    rationale: [],
    suggestedChannels: ["primary"],
  };
}

test("no-slop spec schema requires purpose and at least one agent", () => {
  assert.equal(noSlopSpecSchema.safeParse(specJson).success, true);
  assert.equal(noSlopSpecSchema.safeParse({ ...specJson, purpose: "" }).success, false);
  assert.equal(noSlopSpecSchema.safeParse({ ...specJson, agents: [] }).success, false);
});

test("no-slop spec treats empty optional schedule fields as omitted", () => {
  const parsed = noSlopSpecDraftSchema.parse({
    ...specJson,
    schedule: {
      description: "Weekly on Monday morning",
      cron: "",
      timezone: "",
    },
  });
  assert.equal(parsed.schedule.description, "Weekly on Monday morning");
  assert.equal(parsed.schedule.cron, undefined);
  assert.equal(parsed.schedule.timezone, undefined);
});

test("no-slop spec outbound delivery requires approved connector write policy", () => {
  assert.equal(noSlopSpecSchema.safeParse({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Send the newsletter." },
  }).success, false);
  assert.equal(noSlopSpecSchema.safeParse({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Send the newsletter." },
    connectorPolicy: {
      enabledToolkits: ["gmail"],
      allowedReadActions: [],
      allowedWriteActions: [{
        toolkit: "gmail",
        actionSlug: "gmail_send_email",
        risk: "send",
        requiresPreSendApproval: true,
      }],
      recipientSource: { kind: "uploaded", description: "Uploaded contacts." },
      deliveryExpectation: "Send only after per-run approval.",
    },
  }).success, true);
  assert.equal(noSlopSpecSchema.safeParse({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Send the newsletter." },
    connectorPolicy: {
      enabledToolkits: ["gmail"],
      allowedReadActions: [],
      allowedWriteActions: [{
        toolkit: "gmail",
        actionSlug: "gmail_send_email",
        risk: "send",
        requiresPreSendApproval: false,
      }],
      recipientSource: { kind: "uploaded" },
      deliveryExpectation: "Send automatically.",
    },
  }).success, false);
});

test("no-slop spec normalizes full or generic Composio action refs to toolkit action policy", () => {
  const parsedFromRef = noSlopSpecSchema.parse({
    ...specJson,
    delivery: { target: "none", description: "Create a 1Password item after approval." },
    connectorPolicy: {
      enabledToolkits: ["1password"],
      allowedReadActions: [],
      allowedWriteActions: ["composio.1password.action._1password_create_item"],
      recipientSource: { kind: "none" },
      deliveryExpectation: "Create only after per-run approval.",
    },
  });
  assert.equal(parsedFromRef.connectorPolicy.allowedWriteActions[0]?.toolkit, "1password");
  assert.equal(parsedFromRef.connectorPolicy.allowedWriteActions[0]?.actionSlug, "_1password_create_item");

  const parsedFromGenericToolkit = noSlopSpecSchema.parse({
    ...specJson,
    delivery: { target: "none", description: "Create a 1Password item after approval." },
    connectorPolicy: {
      enabledToolkits: ["1password"],
      allowedReadActions: [],
      allowedWriteActions: [{
        toolkit: "composio",
        actionSlug: "_1password_create_item",
        risk: "send",
        requiresPreSendApproval: true,
      }],
      recipientSource: { kind: "none" },
      deliveryExpectation: "Create only after per-run approval.",
    },
  });
  assert.equal(parsedFromGenericToolkit.connectorPolicy.allowedWriteActions[0]?.toolkit, "1password");
  assert.equal(parsedFromGenericToolkit.connectorPolicy.allowedWriteActions[0]?.actionSlug, "_1password_create_item");
});

test("no-slop spec normalizes connected_app delivery alias to subscriber_list", () => {
  const parsed = noSlopSpecDraftSchema.parse({
    ...specJson,
    delivery: { target: "connected_app", description: "Send newsletter via Connected Apps." },
    connectorPolicy: {
      enabledToolkits: [],
      allowedReadActions: [],
      allowedWriteActions: [],
      recipientSource: { kind: "none" },
      deliveryExpectation: "Send after approval.",
    },
  });
  assert.equal(parsed.delivery.target, "subscriber_list");
  assert.match(parsed.connectorPolicy.recipientSource.description ?? "", /pre_send/i);
});

test("draft spec allows subscriber delivery intent without connected write actions yet", () => {
  const parsed = noSlopSpecDraftSchema.parse({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Weekly newsletter via Resend." },
    connectorPolicy: {
      enabledToolkits: [],
      allowedReadActions: [],
      allowedWriteActions: [],
      recipientSource: { kind: "none" },
      deliveryExpectation: "Bound at approve from Connected Apps.",
    },
  });
  assert.equal(parsed.delivery.target, "subscriber_list");
  assert.equal(parsed.connectorPolicy.allowedWriteActions.length, 0);
  assert.equal(noSlopSpecSchema.safeParse(parsed).success, false);
});

test("no-slop spec normalizes connected mailing list delivery alias", () => {
  const parsed = noSlopSpecSchema.parse({
    ...specJson,
    delivery: { target: "connected_mailing_list", description: "Send to connected contacts." },
    connectorPolicy: {
      enabledToolkits: ["gmail"],
      allowedReadActions: [],
      allowedWriteActions: [{
        toolkit: "gmail",
        actionSlug: "gmail_send_email",
        risk: "send",
        requiresPreSendApproval: true,
      }],
      recipientSource: { kind: "uploaded", description: "Uploaded contacts." },
      deliveryExpectation: "Send only after per-run approval.",
    },
  });
  assert.equal(parsed.delivery.target, "subscriber_list");
});

test("no-slop spec upgrades subscriber delivery recipientSource none to uploaded", () => {
  const parsed = noSlopSpecSchema.parse({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Send to subscribers." },
    connectorPolicy: {
      enabledToolkits: ["resend"],
      allowedReadActions: [],
      allowedWriteActions: [{
        toolkit: "resend",
        actionSlug: "RESEND_SEND_EMAIL",
        risk: "send",
        requiresPreSendApproval: true,
      }],
      recipientSource: { kind: "none" },
      deliveryExpectation: "Send after approval.",
    },
  });
  assert.equal(parsed.connectorPolicy.recipientSource.kind, "uploaded");
  assert.match(parsed.connectorPolicy.recipientSource.description ?? "", /pre_send/i);
});

test("no-slop spec fills default recipientSource description for subscriber delivery", () => {
  const parsed = noSlopSpecSchema.parse({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Send to subscribers." },
    connectorPolicy: {
      enabledToolkits: ["resend"],
      allowedReadActions: [],
      allowedWriteActions: [{
        toolkit: "resend",
        actionSlug: "RESEND_SEND_EMAIL",
        risk: "send",
        requiresPreSendApproval: true,
      }],
      recipientSource: { kind: "uploaded" },
      deliveryExpectation: "Send after approval.",
    },
  });
  assert.match(
    parsed.connectorPolicy.recipientSource.description ?? "",
    /CSV contact list at pre_send/i,
  );
});

test("prepareLoopSpecJsonForValidation injects ranked external-effect candidate when needed", () => {
  const candidate = {
    toolkit: "resend",
    actionSlug: "RESEND_SEND_EMAIL",
    name: "Send Email",
    description: "Send email",
    risk: "send" as const,
    toolRef: "composio.resend.action.resend_send_email",
    score: 150,
    reason: "external write action ranked by contract skills/resources/effect",
  };
  const prepared = prepareLoopSpecJsonForValidation({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Send to subscribers." },
    connectorPolicy: {
      enabledToolkits: ["resend"],
      allowedReadActions: [],
      allowedWriteActions: [{
        toolkit: "resend",
        actionSlug: "_2chat_create_contact",
        risk: "send",
        requiresPreSendApproval: true,
      }],
      recipientSource: { kind: "uploaded" },
      deliveryExpectation: "Send after approval.",
    },
  }, candidate);
  const parsed = noSlopSpecSchema.parse(prepared);
  assert.equal(parsed.connectorPolicy.allowedWriteActions.length, 1);
  assert.equal(parsed.connectorPolicy.allowedWriteActions[0]?.actionSlug, "RESEND_SEND_EMAIL");
});

test("no-slop spec preserves multiple reviewed external-effect actions", () => {
  const parsed = noSlopSpecSchema.parse({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Send to subscribers." },
    connectorPolicy: {
      enabledToolkits: ["resend", "gmail"],
      allowedReadActions: [],
      allowedWriteActions: [
        {
          toolkit: "gmail",
          actionSlug: "gmail_send_email",
          risk: "send",
          requiresPreSendApproval: true,
        },
        {
          toolkit: "resend",
          actionSlug: "RESEND_SEND_EMAIL",
          risk: "send",
          requiresPreSendApproval: true,
        },
      ],
      recipientSource: { kind: "uploaded" },
      deliveryExpectation: "Send after approval.",
    },
  });
  assert.equal(parsed.connectorPolicy.allowedWriteActions.length, 2);
});

test("no-slop spec rejects contact-only actions for subscriber delivery", () => {
  const result = noSlopSpecSchema.safeParse({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Send to subscribers." },
    connectorPolicy: {
      enabledToolkits: ["resend"],
      allowedReadActions: [],
      allowedWriteActions: [{
        toolkit: "resend",
        actionSlug: "_2chat_create_contact",
        risk: "send",
        requiresPreSendApproval: true,
      }],
      recipientSource: { kind: "uploaded" },
      deliveryExpectation: "Send after approval.",
    },
  });
  assert.equal(result.success, false);
});

test("no-slop spec rejects draft-only actions for subscriber delivery", () => {
  const result = noSlopSpecSchema.safeParse({
    ...specJson,
    delivery: { target: "subscriber_list", description: "Send to subscribers." },
    connectorPolicy: {
      enabledToolkits: ["create_email_draft"],
      allowedReadActions: [],
      allowedWriteActions: [{
        toolkit: "create_email_draft",
        actionSlug: "create_email_draft",
        risk: "send",
        requiresPreSendApproval: true,
      }],
      recipientSource: { kind: "uploaded", description: "Uploaded contacts." },
      deliveryExpectation: "Send after approval.",
    },
  });
  assert.equal(result.success, false);
});

test("approved snapshot requires approved spec status", () => {
  const draft: LoopSpecView = {
    id: snapshot.id,
    slug: snapshot.slug,
    title: snapshot.title,
    status: "draft",
    version: snapshot.version,
    sourcePrompt: "Create a weekly digest.",
    bodyMarkdown: snapshot.bodyMarkdown,
    specJson: snapshot.specJson,
    approvedAt: null,
    approvedByUserId: null,
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
  };

  assert.throws(() => approvedSpecSnapshot(draft), /approved/i);
});

test("loop spec row mapper serializes Date timestamps", () => {
  const approvedAt = new Date("2026-06-09T01:02:03.000Z");
  const view = mapLoopSpecRowForTest({
    id: snapshot.id,
    slug: snapshot.slug,
    title: snapshot.title,
    status: "approved",
    version: snapshot.version,
    source_prompt: "Create a weekly digest.",
    body_markdown: snapshot.bodyMarkdown,
    spec_json: snapshot.specJson,
    approved_at: approvedAt,
    approved_by_user_id: "11111111-1111-4111-8111-111111111111",
    created_at: new Date("2026-06-09T00:00:00.000Z"),
    updated_at: new Date("2026-06-09T02:00:00.000Z"),
  });

  assert.equal(view.approvedAt, "2026-06-09T01:02:03.000Z");
  assert.equal(view.createdAt, "2026-06-09T00:00:00.000Z");
  assert.equal(approvedSpecSnapshot(view).approvedAt, "2026-06-09T01:02:03.000Z");
});

test("critic passes a design that reflects the approved spec", () => {
  const result = critiqueLoopDesign(baseDesign(), snapshot);
  assert.equal(result.pass, true);
  assert.deepEqual(result.requiredFixes, []);
});

test("critic rejects a design missing approved spec criteria", () => {
  const design = baseDesign();
  design.agents[1] = {
    ...design.agents[1],
    task: "Write a short summary.",
    doneCriteria: ["Includes one summary"],
    outputContract: { description: "Short summary", schema: { summary: "string" } },
  };

  const result = critiqueLoopDesign(design, snapshot);
  assert.equal(result.pass, false);
  assert.match(result.requiredFixes.join("\n"), /Spec (guardrail|success criterion|done criterion) is not reflected/i);
});

test("critic allows newsletter writer agents to choose gates and render targets dynamically", () => {
  const design = baseDesign();
  design.agents = [
    {
      id: "web_research",
      name: "Research Agent",
      goal: "Find recent AI industry sources with URLs.",
      task: "Search the web for recent AI industry news with URLs and snippets.",
      tool: "internal.web_search",
      inputContract: { description: "Research topic", schema: { query: "string" } },
      outputContract: { description: "Raw search results", schema: { sources: "array" } },
      doneCriteria: ["At least five sources include URLs"],
      artifactRole: "source_evidence",
    },
    {
      id: "newsletter_writer",
      name: "Writer Agent",
      goal: "Write the weekly AI industry newsletter.",
      task: "Synthesize research into a newsletter email with subject and preview.",
      tool: "internal.llm_only",
      inputContract: { description: "Research handoff", schema: { handoff: { web_research: "object" } } },
      outputContract: { description: "Newsletter email copy", schema: { text: "string" } },
      doneCriteria: ["Includes a Subject line", "Includes one complete newsletter body"],
    },
  ];

  const result = critiqueLoopDesign(design, snapshot);
  assert.equal(result.requiredFixes.some((fix) => /renderTarget "canvas.email"/i.test(fix)), false);
  assert.equal(result.requiredFixes.some((fix) => /draft_review/i.test(fix)), false);
});

test("critic does not hard-code delivery config input rejection", () => {
  const design = baseDesign();
  design.inputsRequired = ["subscriber_list_id"];
  const result = critiqueLoopDesign(design, snapshot);
  assert.equal(result.requiredFixes.some((fix) => /recipientSource|subscriber_list_id/i.test(fix)), false);
});

test("critic rejects external-effect provider that is not approved by contract policy", () => {
  const newsletterSpec = noSlopSpecSnapshotSchema.parse({
    ...snapshot,
    specJson: noSlopSpecSchema.parse({
      ...specJson,
      purpose: "Send a weekly newsletter.",
      delivery: { target: "subscriber_list", description: "Send to subscribers." },
      connectorPolicy: {
        enabledToolkits: ["resend"],
        allowedReadActions: [],
        allowedWriteActions: [{
          toolkit: "resend",
          actionSlug: "RESEND_SEND_EMAIL",
          risk: "send",
          requiresPreSendApproval: true,
        }],
        recipientSource: { kind: "uploaded", description: "Uploaded contacts." },
        deliveryExpectation: "Send after approval.",
      },
    }),
  });
  const design = baseDesign();
  design.delivery = { provider: "composio.create_email_draft.action.create_email_draft", target: "subscriber_list" };
  design.agents.push({
    id: "sender",
    name: "Sender Agent",
    goal: "Send the newsletter after approval.",
    task: "Send the newsletter after pre-send approval.",
    tool: "composio.create_email_draft.action.create_email_draft",
    inputContract: { description: "Approved newsletter draft", schema: {} },
    outputContract: { description: "Connector action result", schema: {} },
    doneCriteria: ["Send action result is recorded"],
    gate: { type: "pre_send", question: "Approve send?" },
  });

  const result = critiqueLoopDesign(design, newsletterSpec);
  assert.equal(result.pass, false);
  assert.match(result.requiredFixes.join("\n"), /approved connector write actions/i);
});

test("critic allows standalone approval QA agents when explicitly designed", () => {
  const design = baseDesign();
  design.agents.push({
    id: "approval_qa",
    name: "Approval & QA Agent",
    goal: "Review and approve the synthesis output.",
    task: "Review upstream draft quality before delivery.",
    tool: "internal.llm_only",
    inputContract: { description: "Upstream draft", schema: {} },
    outputContract: { description: "Approval notes", schema: {} },
    doneCriteria: ["Draft is reviewed"],
    gate: { type: "draft_review", question: "Approve?" },
  });

  const result = critiqueLoopDesign(design, snapshot);
  assert.equal(result.requiredFixes.some((fix) => /standalone approval\/QA reviewer/i.test(fix)), false);
});

test("critic allows web search agents without forced source confirmation", () => {
  const design = baseDesign();
  design.agents[0] = {
    ...design.agents[0]!,
    tool: "internal.web_search",
    gate: undefined,
  };

  const result = critiqueLoopDesign(design, snapshot);
  assert.equal(result.requiredFixes.some((fix) => /source_confirmation/i.test(fix)), false);
});

test("critic explains that pre_send belongs only on external-effect tools", () => {
  const design = baseDesign();
  design.agents[1] = {
    ...design.agents[1]!,
    name: "Pre-send Specialist Agent",
    tool: "internal.llm_only",
    gate: { type: "pre_send", question: "Approve send?" },
  };

  const result = critiqueLoopDesign(design, snapshot);
  assert.equal(result.pass, false);
  assert.match(result.requiredFixes.join("\n"), /pre_send is only valid on the exact approved external-effect tool/i);
});
