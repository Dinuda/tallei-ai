import assert from "node:assert/strict";
import test from "node:test";

import { noSlopSpecSchema } from "../../../src/services/loop-engine/spec-contracts.js";
import { critiqueLoopDesign } from "../../../src/services/loop-engine/critic.js";
import { repairArchitectDesignForSpec } from "../../../src/services/loop-engine/repair-architect.js";

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
