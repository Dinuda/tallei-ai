import assert from "node:assert/strict";
import test from "node:test";

import { noSlopSpecSchema } from "../../../src/services/loop-engine/spec-contracts.js";
import type { LoopArchitectOutput } from "../../../src/services/loop-engine/contracts.js";
import { loopArchitectOutputSchema } from "../../../src/services/loop-engine/contracts.js";
import { critiqueLoopDesign } from "../../../src/services/loop-engine/critic.js";
import { normalizeArchitectOutput } from "../../../src/services/loop-engine/normalize-architect.js";

function newsletterDesign(): LoopArchitectOutput {
  return {
    title: "Weekly digest",
    summary: "Curated newsletter from research and memories.",
    strategyText: "Research, recall memories, write newsletter.",
    inputsRequired: [],
    delivery: { provider: "none", target: "none" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [
      {
        id: "research",
        name: "Research Agent",
        goal: "Find newsletter sources",
        task: "Search the web for recent articles.",
        tool: "internal.web_search",
        inputContract: { description: "Topic", schema: {} },
        outputContract: { description: "Sources", schema: {} },
        doneCriteria: ["Returns cited sources"],
      },
      {
        id: "writer",
        name: "Newsletter Writer",
        goal: "Write the newsletter email",
        task: "Synthesize sources into a newsletter email body.",
        tool: "internal.llm_only",
        inputContract: { description: "Sources", schema: {} },
        outputContract: { description: "Newsletter email copy", schema: {} },
        doneCriteria: ["Includes subject and body"],
      },
      {
        id: "editorial_review",
        name: "Editorial Review Agent",
        goal: "Review upstream newsletter quality",
        task: "Review the writer output without rewriting the full newsletter.",
        tool: "internal.llm_only",
        inputContract: { description: "Draft", schema: {} },
        outputContract: { description: "Review notes", schema: {} },
        doneCriteria: ["Flags quality issues"],
        gate: { type: "draft_review", question: "Approve?" },
      },
      {
        id: "delivery_prep",
        name: "Delivery Preparation Agent",
        goal: "Prepare the newsletter email for delivery",
        task: "Format the newsletter email for sending after review.",
        tool: "internal.llm_only",
        inputContract: { description: "Approved draft", schema: {} },
        outputContract: { description: "Newsletter email ready to send", schema: {} },
        doneCriteria: ["Email is ready"],
        gate: { type: "pre_send", question: "Approve send?" },
      },
    ],
    rationale: [],
    suggestedChannels: ["primary"],
  };
}

test("normalize preserves architect-selected gates, roles, and render targets", () => {
  const normalized = normalizeArchitectOutput(newsletterDesign());
  assert.equal(normalized.agents.some((agent) => /editorial review/i.test(agent.name)), true);
  const writer = normalized.agents.find((agent) => /newsletter writer/i.test(agent.name));
  assert.ok(writer);
  assert.equal(writer?.renderTarget, undefined);
  assert.equal(writer?.gate, undefined);
  assert.equal(writer?.artifactRole, undefined);
  assert.equal(normalized.agents.some((agent) => /delivery preparation/i.test(agent.name)), true);
  assert.equal(normalized.agents.find((agent) => agent.tool === "internal.web_search")?.gate, undefined);
});

test("architect schema coerces object inputsRequired entries to string keys", () => {
  const parsed = loopArchitectOutputSchema.parse({
    ...newsletterDesign(),
    inputsRequired: [
      { key: "audience_id", surface: "input.audience_id", when: "before_send" },
      "confirm_send",
    ],
    inputRequirements: [
      { key: "audience_id", surface: "input.audience_id", when: "before_send", required: true },
      { key: "confirm_send", surface: "confirm.send", when: "before_send", required: true },
    ],
  });
  assert.deepEqual(parsed.inputsRequired, ["audience_id", "confirm_send"]);
});

test("normalize does not inject missing spec guardrails into strategy or writer criteria", () => {
  const guardrail = "Ensure summaries are readable at a glance and suitable for a general professional audience.";
  const normalized = normalizeArchitectOutput(newsletterDesign(), {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "digest",
    version: 1,
    title: "Digest",
    bodyMarkdown: "# Digest",
    approvedAt: "2026-06-09T00:00:00.000Z",
    specJson: {
      purpose: "Weekly digest",
      agents: [{
        name: "Writer",
        goal: "Write digest",
        guardrails: [guardrail],
        doneWhen: ["Digest is ready for review"],
        failureModes: [],
      }],
      guardrails: [],
      successCriteria: [],
      failureModes: [],
      schedule: { description: "Weekly", cron: "0 9 * * 1", timezone: "UTC" },
      delivery: { target: "none", description: "Dashboard only" },
    },
  } as never);
  assert.doesNotMatch(normalized.strategyText, /readable at a glance/i);
  const writer = normalized.agents.find((agent) => /newsletter writer/i.test(agent.name));
  assert.equal(writer?.doneCriteria.includes(guardrail), false);
});

test("normalize does not inject subscriber delivery agents from approved spec", () => {
  const specSnapshot = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "newsletter",
    version: 1,
    title: "Newsletter",
    bodyMarkdown: "# Newsletter",
    approvedAt: "2026-06-09T00:00:00.000Z",
    specJson: noSlopSpecSchema.parse({
      purpose: "Weekly AI newsletter",
      agents: [{
        name: "Writer",
        goal: "Write newsletter",
        guardrails: [],
        doneWhen: ["Newsletter ready"],
        failureModes: [],
      }],
      guardrails: [],
      successCriteria: ["Newsletter sends after approval"],
      failureModes: [],
      schedule: { description: "Weekly", cron: "0 9 * * 1", timezone: "UTC" },
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
    }),
  };

  const normalized = normalizeArchitectOutput({
    ...newsletterDesign(),
    delivery: { provider: "none", target: "subscriber_list" },
  }, specSnapshot);

  assert.equal(normalized.delivery.target, "subscriber_list");
  assert.equal(normalized.delivery.provider, "none");
  assert.equal(normalized.agents.some((agent) => agent.gate?.type === "recipient_upload"), false);
  assert.equal(normalized.agents.some((agent) => agent.tool === "composio.resend.action.resend_send_email"), false);
  const critique = critiqueLoopDesign(normalized, specSnapshot);
  assert.equal(critique.pass, false);
  assert.match(critique.requiredFixes.join("; "), /must be one of the approved connector write actions/i);
});

test("normalize preserves architect delivery provider and lets critic reject unapproved external action", () => {
  const specSnapshot = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "newsletter",
    version: 1,
    title: "Newsletter",
    bodyMarkdown: "# Newsletter",
    approvedAt: "2026-06-09T00:00:00.000Z",
    specJson: noSlopSpecSchema.parse({
      purpose: "Weekly AI newsletter",
      agents: [{
        name: "Writer",
        goal: "Write newsletter",
        guardrails: [],
        doneWhen: ["Newsletter ready"],
        failureModes: [],
      }],
      guardrails: [],
      successCriteria: ["Newsletter sends after approval"],
      failureModes: [],
      schedule: { description: "Weekly", cron: "0 9 * * 1", timezone: "UTC" },
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
    }),
  };

  const normalized = normalizeArchitectOutput({
    ...newsletterDesign(),
    delivery: {
      provider: "composio.resend.action._2chat_create_contact",
      target: "subscriber_list",
    },
    agents: [
      ...newsletterDesign().agents.filter((agent) => !/delivery preparation/i.test(agent.name)),
      {
        id: "contact_sync",
        name: "Contact Sync Agent",
        goal: "Create contacts before send",
        task: "Create contacts in Resend before sending.",
        tool: "composio.resend.action._2chat_create_contact",
        inputContract: { description: "Recipients", schema: {} },
        outputContract: { description: "Contacts", schema: {} },
        doneCriteria: ["Contacts created"],
        gate: { type: "pre_send", question: "Approve contacts?" },
      },
    ],
  }, specSnapshot);

  assert.equal(normalized.delivery.provider, "composio.resend.action._2chat_create_contact");
  assert.equal(
    normalized.agents.some((agent) => agent.tool === "composio.resend.action._2chat_create_contact"),
    true,
  );
  const critique = critiqueLoopDesign(normalized, specSnapshot);
  assert.equal(critique.pass, false);
  assert.match(critique.requiredFixes.join("; "), /approved connector write actions/i);
});
