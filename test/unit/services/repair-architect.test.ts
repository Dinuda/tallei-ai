import assert from "node:assert/strict";
import test from "node:test";

import { repairArchitectDesignForSpec, repairArchitectDesignForSpecWithInputs } from "../../../src/services/loop-engine/repair-architect.js";
import { critiqueLoopDesign } from "../../../src/services/loop-engine/critic.js";
import { noSlopSpecDraftSchema, noSlopSpecSchema } from "../../../src/services/loop-engine/spec-contracts.js";

test("repair aligns email canvas output type and operator surface without magic done criteria", () => {
  const repaired = repairArchitectDesignForSpec({
    title: "Newsletter",
    summary: "Draft and review",
    strategyText: "Write then review",
    inputsRequired: [],
    inputRequirements: [],
    delivery: { provider: "none", target: "none" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [{
      id: "drafting",
      name: "Drafting Agent",
      goal: "Write the newsletter",
      task: "Write the newsletter",
      tool: "internal.llm_only",
      inputContract: { description: "Research", schema: {} },
      outputContract: { description: "Email draft", schema: {} },
      doneCriteria: ["Newsletter is complete"],
      gate: { type: "draft_review", question: "Review draft?" },
      renderTarget: "canvas.email",
      operatorSurface: "confirm.send",
    }],
    rationale: [],
    suggestedChannels: ["primary"],
  });

  assert.equal(repaired.agents[0]?.outputContract.schema.format, "email_markdown");
  assert.equal(repaired.agents[0]?.operatorSurface, "review.email");
  assert.deepEqual(repaired.agents[0]?.doneCriteria, ["Newsletter is complete"]);
});

function newsletterSpecSnapshot() {
  return {
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
}

test("repair maps pre_send on llm_only to draft_review and remaps wrong delivery tool", () => {
  const spec = newsletterSpecSnapshot();
  const repaired = repairArchitectDesignForSpec({
    title: "Newsletter",
    summary: "Send newsletter",
    strategyText: "Write and send",
    inputsRequired: [],
    delivery: { provider: "composio.resend.action._1password_create_item", target: "subscriber_list" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [
      {
        id: "writer",
        name: "Writer",
        goal: "Write newsletter",
        task: "Write newsletter",
        tool: "internal.llm_only",
        inputContract: { description: "Brief", schema: {} },
        outputContract: { description: "Draft", schema: {} },
        doneCriteria: ["Draft ready"],
        gate: { type: "draft_review", question: "Review draft?" },
      },
      {
        id: "pre_send",
        name: "Pre-send Specialist Agent",
        goal: "Review before send",
        task: "Review before send",
        tool: "internal.llm_only",
        inputContract: { description: "Draft", schema: {} },
        outputContract: { description: "Review", schema: {} },
        doneCriteria: ["Reviewed"],
        gate: { type: "pre_send", question: "Approve send?" },
      },
      {
        id: "delivery",
        name: "Delivery Execution Agent",
        goal: "Send newsletter",
        task: "Send newsletter",
        tool: "composio.resend.action._1password_create_item",
        inputContract: { description: "Draft", schema: {} },
        outputContract: { description: "Send result", schema: {} },
        doneCriteria: ["Sent"],
        gate: { type: "pre_send", question: "Approve send?" },
      },
    ],
    rationale: [],
    suggestedChannels: ["primary"],
  }, spec);

  const preSendAgent = repaired.agents.find((agent) => agent.id === "pre_send");
  assert.equal(preSendAgent?.gate?.type, "draft_review");
  assert.equal(repaired.agents.find((agent) => agent.id === "delivery")?.tool, "composio.resend.action.resend_send_email");
  assert.equal(repaired.delivery.provider, "composio.resend.action.resend_send_email");

  const critique = critiqueLoopDesign(repaired, spec);
  assert.equal(critique.pass, true, critique.requiredFixes.join("; "));
});

test("repair canonicalizes pre_send_confirm and sync_to_team input requirements", () => {
  const spec = newsletterSpecSnapshot();
  const repaired = repairArchitectDesignForSpecWithInputs({
    title: "Newsletter",
    summary: "Send newsletter",
    strategyText: "Write and send",
    inputsRequired: [],
    inputRequirements: [
      { key: "sprint_notes", surface: "input.markdown", when: "run_start", required: true },
      { key: "pre_send_confirm", surface: "input.text", when: "before_send", required: true },
      { key: "sync_to_team", surface: "input.text", when: "before_send", required: true },
      { key: "recipients", surface: "input.contacts_csv", when: "before_send", required: true },
    ],
    delivery: { provider: "composio.resend.action.resend_send_email", target: "subscriber_list" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [
      {
        id: "writer",
        name: "Writer",
        goal: "Write newsletter",
        task: "Write newsletter",
        tool: "internal.llm_only",
        inputContract: { description: "Brief", schema: {} },
        outputContract: { description: "Draft", schema: {} },
        doneCriteria: ["Draft ready"],
        gate: { type: "draft_review", question: "Review draft?" },
      },
      {
        id: "delivery",
        name: "Delivery Agent",
        goal: "Send newsletter",
        task: "Send newsletter",
        tool: "composio.resend.action.resend_send_email",
        inputContract: { description: "Draft", schema: {} },
        outputContract: { description: "Send result", schema: {} },
        doneCriteria: ["Sent"],
        gate: { type: "pre_send", question: "Approve send?" },
      },
    ],
    rationale: [],
    suggestedChannels: ["primary"],
  }, spec, "Weekly sync email to team");

  assert.ok(repaired.inputRequirements?.some((req) => req.key === "confirm_send" && req.surface === "confirm.send"));
  assert.ok(repaired.inputRequirements?.some((req) => req.key === "recipients" && req.surface === "input.contacts_csv"));
  assert.ok(!repaired.inputRequirements?.some((req) => req.key === "pre_send_confirm"));
  assert.ok(!repaired.inputRequirements?.some((req) => req.key === "sprint_notes"));
  assert.ok(!repaired.agents.some((agent) => agent.id === "input_validator"));
  const critique = critiqueLoopDesign(repaired, spec);
  assert.equal(critique.pass, true, critique.requiredFixes.join("; "));
});

test("spec aliases recipients_upload and pre_send_confirm normalize and pass critic", () => {
  const rawSpec = {
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
    inputRequirements: [
      { key: "sprint_notes", surface: "input.markdown", when: "run_start", required: true },
      { key: "recipients_upload", surface: "input.contacts_csv", when: "before_send", required: true },
      { key: "pre_send_confirm", surface: "input.text", when: "before_send", required: true },
    ],
  };
  const parsed = noSlopSpecDraftSchema.parse(rawSpec);
  assert.ok(parsed.inputRequirements.some((req) => req.key === "recipients"));
  assert.ok(parsed.inputRequirements.some((req) => req.key === "confirm_send"));
  assert.ok(!parsed.inputRequirements.some((req) => req.key === "sprint_notes"));

  const spec = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "newsletter",
    version: 1,
    title: "Newsletter",
    bodyMarkdown: "# Newsletter",
    approvedAt: "2026-06-09T00:00:00.000Z",
    specJson: noSlopSpecSchema.parse(parsed),
  };

  const repaired = repairArchitectDesignForSpecWithInputs({
    title: "Newsletter",
    summary: "Send newsletter",
    strategyText: "Write and send",
    inputsRequired: [],
    inputRequirements: [],
    delivery: { provider: "composio.resend.action.resend_send_email", target: "subscriber_list" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [
      {
        id: "writer",
        name: "Writer",
        goal: "Write newsletter",
        task: "Write newsletter",
        tool: "internal.llm_only",
        inputContract: { description: "Brief", schema: {} },
        outputContract: { description: "Draft", schema: {} },
        doneCriteria: ["Draft ready"],
        gate: { type: "draft_review", question: "Review draft?" },
      },
      {
        id: "delivery",
        name: "Delivery Agent",
        goal: "Send newsletter",
        task: "Send newsletter",
        tool: "composio.resend.action.resend_send_email",
        inputContract: { description: "Draft", schema: {} },
        outputContract: { description: "Send result", schema: {} },
        doneCriteria: ["Sent"],
        gate: { type: "pre_send", question: "Approve send?" },
      },
    ],
    rationale: [],
    suggestedChannels: ["primary"],
  }, spec, "Weekly newsletter");

  const critique = critiqueLoopDesign(repaired, spec);
  assert.equal(critique.pass, true, critique.requiredFixes.join("; "));
});

test("repair strips hallucinated sprint_notes for subscriber_list newsletter", () => {
  const spec = newsletterSpecSnapshot();
  const repaired = repairArchitectDesignForSpecWithInputs({
    title: "Newsletter",
    summary: "Weekly newsletter",
    strategyText: "Research then write",
    inputsRequired: ["sprint_notes"],
    inputRequirements: [
      { key: "sprint_notes", surface: "input.markdown", when: "run_start", required: true },
    ],
    delivery: { provider: "none", target: "subscriber_list" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [
      {
        id: "input_validator",
        name: "Input Validator",
        goal: "Ask the operator to paste sprint_notes",
        task: "Collect sprint notes",
        tool: "internal.llm_only",
        inputContract: { description: "provided", schema: {} },
        outputContract: { description: "confirmed", schema: {} },
        doneCriteria: ["Inputs confirmed"],
        gate: { type: "missing_input", question: "Provide sprint notes?" },
      },
      {
        id: "research",
        name: "Research Agent",
        goal: "Find relevant sources",
        task: "Search the web for newsletter topics",
        tool: "internal.web_search",
        inputContract: { description: "Search query", schema: {} },
        outputContract: { description: "Sources", schema: { sources: "array" } },
        doneCriteria: ["Returns ranked sources"],
        gate: { type: "source_confirmation", question: "Review sources?" },
      },
      {
        id: "writer",
        name: "Writer",
        goal: "Write newsletter",
        task: "Draft newsletter from sources",
        tool: "internal.llm_only",
        inputContract: { description: "Sources", schema: {} },
        outputContract: { description: "Draft", schema: {} },
        doneCriteria: ["Draft ready"],
        gate: { type: "draft_review", question: "Review draft?" },
      },
    ],
    rationale: [],
    suggestedChannels: ["primary"],
  }, spec, "Weekly AI newsletter");

  assert.equal(repaired.agents[0]?.id, "research");
  assert.ok(!repaired.inputRequirements?.some((req) => req.key === "sprint_notes"));
  assert.ok(!repaired.agents.some((agent) => agent.id === "input_validator"));
});
