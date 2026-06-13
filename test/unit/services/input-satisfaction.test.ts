import assert from "node:assert/strict";
import test from "node:test";

import { detectPlaceholderText } from "../../../src/services/loop-engine/contracts.js";
import { normalizeInputSurface, specRequiresRunStartContent } from "../../../src/services/loop-engine/input-surfaces.js";
import { noSlopSpecDraftSchema } from "../../../src/services/loop-engine/spec-contracts.js";
import {
  applyGateSurfaceSubmission,
  collectRequirements,
  evaluateAt,
  evaluateExecutionBlockingAt,
  validateSurfaceValue,
} from "../../../src/services/loop-runtime/input-satisfaction.js";
import { runtimeContextSchema } from "../../../src/services/loop-runtime/types.js";
import { buildLoopDefinition } from "../../../src/services/loop-executor/creator.js";
import { emptyRunMemory, isMisclassifiedDraftReviewGate } from "../../../src/services/loop-runtime/memory.js";

const strictWorkflowFields = {
  operatorInteractionPlan: { version: "v1" as const, interactions: [] },
  builderMeta: {
    designedBy: "loop_architect" as const,
    preApproved: true,
    planningIRVersion: "v2" as const,
    planningIR: {},
  },
};

function syncEmailDefinition() {
  return buildLoopDefinition({
    ...strictWorkflowFields,
    task: "Send weekly internal sync email from sprint notes",
    cron: "0 9 * * 5",
    timezone: "UTC",
    inputRequirements: [{
      key: "sprint_notes",
      surface: "input.markdown",
      label: "Sprint notes",
      required: true,
      when: "run_start",
    }],
    agentGraph: {
      parent: { id: "parent", name: "Coordinator", task: "Coordinate", policy: "Review before send" },
      children: [{
        id: "draft",
        name: "Draft Agent",
        task: "Draft sync email",
        goal: "Produce email draft",
        tools: [{ ref: "internal.llm_only" }],
        gate: { type: "draft_review", question: "Approve draft?" },
        renderTarget: "canvas.email",
      }],
    },
  });
}

test("placeholder prompt text is detected but does not block build-time parsing", () => {
  const prompt = "Write sync email from [PASTE SPRINT NOTES]";
  assert.equal(detectPlaceholderText(prompt), true);
  assert.doesNotThrow(() => syncEmailDefinition());
});

test("run_start requirements stay unsatisfied until operator markdown is provided", () => {
  const definition = syncEmailDefinition();
  const emptyContext = runtimeContextSchema.parse({ inputs: {} });
  const unsatisfied = evaluateAt(definition, emptyContext, "run_start");
  assert.equal(unsatisfied.length, 1);
  assert.equal(unsatisfied[0]?.requirement.key, "sprint_notes");

  const nextContext = applyGateSurfaceSubmission({
    definition,
    context: emptyContext,
    values: {
      sprint_notes: {
        surface: "input.markdown",
        text: "Shipped auth refresh. Blocked on QA. Next: billing polish.",
      },
    },
  });
  assert.equal(evaluateAt(definition, nextContext, "run_start").length, 0);
});

test("blank stale submission is ignored when context already satisfies the input", () => {
  const definition = buildLoopDefinition({
    ...strictWorkflowFields,
    task: "Validate saved review notes",
    cron: "0 9 * * 5",
    timezone: "UTC",
    inputRequirements: [{
      key: "review",
      surface: "input.markdown",
      required: true,
      when: "run_start",
    }],
    agentGraph: {
      parent: { id: "parent", name: "Coordinator", task: "Coordinate", policy: "Validate input" },
      children: [{
        id: "input_validator",
        name: "Input Validator",
        task: "Validate saved review notes",
        goal: "Confirm review notes exist",
        tools: [{ ref: "internal.llm_only" }],
        gate: { type: "missing_input", question: "Provide review notes." },
      }],
    },
  });
  const context = runtimeContextSchema.parse({
    inputs: {
      review: "Sprint Goal: improve persistence. Completed storage APIs. Next: harden workspace isolation.",
    },
  });

  const nextContext = applyGateSurfaceSubmission({
    definition,
    context,
    values: {
      review: { surface: "input.markdown" },
    },
  });

  assert.equal(nextContext.inputs.review, context.inputs.review);
  assert.equal(evaluateAt(definition, nextContext, "run_start").length, 0);
});

test("collectRequirements does not derive inputs from delivery metadata", () => {
  const definition = buildLoopDefinition({
    ...strictWorkflowFields,
    task: "Send newsletter",
    cron: "0 9 * * 1",
    timezone: "UTC",
    delivery: { provider: "composio.resend.action.send_email", target: "subscriber_list" },
    connectorPolicy: {
      enabledToolkits: ["resend"],
      approvedInternalTools: { readToolRefs: [], writeToolRefs: [] },
      approvedComposioToolkits: ["resend"],
      allowedReadActions: [],
      allowedWriteActions: [{ toolkit: "resend", actionSlug: "send_email", risk: "send" }],
      recipientSource: { kind: "uploaded", description: "Operator uploads CSV at send time." },
      deliveryExpectation: "Send to uploaded list.",
    },
    agentGraph: {
      parent: { id: "parent", name: "Coordinator", task: "Coordinate", policy: "Approve send" },
      children: [{
        id: "send",
        name: "Send Agent",
        task: "Send newsletter",
        goal: "Deliver newsletter",
        tools: [{ ref: "composio.resend.action.send_email" }],
        gate: { type: "pre_send", question: "Approve send?" },
      }],
    },
  });
  const requirements = collectRequirements(definition);
  assert.deepEqual(requirements, []);
});

test("confirm_send does not block execution once recipient input is ready", () => {
  const definition = buildLoopDefinition({
    ...strictWorkflowFields,
    task: "Send newsletter",
    cron: "0 9 * * 5",
    timezone: "UTC",
    inputRequirements: [
      { key: "audience_id", surface: "input.audience_id", when: "before_send", required: true },
      { key: "confirm_send", surface: "confirm.send", when: "before_send", required: true },
    ],
    delivery: { provider: "composio.resend.action.resend_send_email", target: "subscriber_list" },
    connectorPolicy: {
      enabledToolkits: ["resend"],
      approvedInternalTools: { readToolRefs: [], writeToolRefs: [] },
      approvedComposioToolkits: ["resend"],
      allowedReadActions: [],
      allowedWriteActions: [{ toolkit: "resend", actionSlug: "resend_send_email", risk: "send" }],
      recipientSource: { kind: "configured", description: "Pick audience at send." },
      deliveryExpectation: "Send after approval.",
    },
    agentGraph: {
      parent: { id: "parent", name: "Coordinator", task: "Coordinate", policy: "Approve send" },
      children: [{
        id: "delivery",
        name: "Delivery Agent",
        task: "Send newsletter",
        goal: "Deliver newsletter",
        tools: [{ ref: "composio.resend.action.resend_send_email" }],
        gate: { type: "pre_send", question: "Approve send?" },
      }],
    },
  });
  const context = runtimeContextSchema.parse({
    inputs: {},
    deliveryRecipients: {
      audienceId: "aud_123",
      recipientCount: 1,
      contacts: [],
      uploadedAt: new Date().toISOString(),
      source: "configured",
    },
  });
  assert.equal(evaluateAt(definition, context, "before_send").length, 1);
  assert.equal(evaluateAt(definition, context, "before_send")[0]?.requirement.key, "confirm_send");
  assert.equal(evaluateExecutionBlockingAt(definition, context, "before_send").length, 0);
});

test("validateSurfaceValue rejects placeholder markdown submissions", () => {
  const result = validateSurfaceValue("input.markdown", "[PASTE SPRINT NOTES]", { key: "sprint_notes", required: true });
  assert.equal(result.ok, false);
});

test("misclassified draft_review does not advance when content inputs are still missing", () => {
  const definition = syncEmailDefinition();
  const runMemory = emptyRunMemory();
  assert.equal(isMisclassifiedDraftReviewGate({
    gateType: "missing_input",
    gateStatus: "pending",
    agent: { id: "draft", name: "Draft Agent" },
    gatePayload: { result: { goalEval: { blockers: ["placeholder_detected"] } } },
    definition,
    runMemory,
  }), false);

  runMemory.inputs.sprint_notes = "Real notes";
  assert.equal(isMisclassifiedDraftReviewGate({
    gateType: "missing_input",
    gateStatus: "pending",
    agent: { id: "draft", name: "Draft Agent" },
    gatePayload: { result: { goalEval: { blockers: ["placeholder_detected"] } } },
    definition,
    runMemory,
  }), true);
});

test("normalizeInputSurface rejects undeclared surface aliases", () => {
  assert.throws(() => normalizeInputSurface("input.boolean", "include_metrics"), /Unknown input surface/);
  assert.equal(normalizeInputSurface("confirm.send", "confirm_send"), "confirm.send");
});

test("input names do not imply recipient-specific surfaces or timing", () => {
  assert.throws(() => normalizeInputSurface("input.custom", "subscriber_list_id"), /Unknown input surface/);
  assert.throws(() => normalizeInputSurface("input.custom", "recipient_email"), /Unknown input surface/);
});

test("noSlopSpecDraftSchema rejects undeclared input surfaces", () => {
  const parsed = noSlopSpecDraftSchema.safeParse({
    purpose: "Weekly sync email",
    agents: [{ name: "Draft Agent", goal: "Draft email", guardrails: [], doneWhen: [], failureModes: [] }],
    guardrails: [],
    successCriteria: [],
    failureModes: [],
    schedule: { description: "Weekly" },
    delivery: { target: "team_email", description: "Internal team email" },
    connectorPolicy: {
      enabledToolkits: [],
      approvedInternalTools: { readToolRefs: [], writeToolRefs: ["internal.llm_only"] },
      approvedComposioToolkits: [],
      allowedReadActions: [],
      allowedWriteActions: [],
      recipientSource: { kind: "none" },
      deliveryExpectation: "Team email",
    },
    inputRequirements: [
      { key: "sprint_notes", surface: "input.markdown", when: "run_start" },
      { key: "include_metrics", surface: "input.boolean", when: "run_start", required: false },
    ],
  });
  assert.equal(parsed.success, false);
});

test("input.file accepts pasted text when no fileRef is provided", () => {
  const definition = buildLoopDefinition({
    ...strictWorkflowFields,
    task: "Draft launch email from product brief",
    cron: "0 9 * * 5",
    timezone: "UTC",
    inputRequirements: [{
      key: "product_brief_or_link",
      surface: "input.file",
      label: "Product brief or link",
      required: true,
      when: "run_start",
    }],
    agentGraph: {
      parent: { id: "parent", name: "Coordinator", task: "Coordinate", policy: "Draft from brief" },
      children: [{
        id: "draft",
        name: "Draft Agent",
        task: "Draft launch email",
        goal: "Produce email draft",
        tools: [{ ref: "internal.llm_only" }],
      }],
    },
  });
  const emptyContext = runtimeContextSchema.parse({ inputs: {} });
  assert.equal(evaluateAt(definition, emptyContext, "run_start").length, 1);

  const nextContext = applyGateSurfaceSubmission({
    definition,
    context: emptyContext,
    values: {
      product_brief_or_link: {
        surface: "input.file",
        text: "Tallei Loops turns repeated patterns into reusable automations.",
      },
    },
  });
  assert.equal(nextContext.inputs.product_brief_or_link, "Tallei Loops turns repeated patterns into reusable automations.");
  assert.equal(evaluateAt(definition, nextContext, "run_start").length, 0);
});

test("applyGateSurfaceSubmission rejects undeclared keys with declared input list", () => {
  const definition = buildLoopDefinition({
    ...strictWorkflowFields,
    task: "Send to subscriber list",
    cron: "0 9 * * 5",
    timezone: "UTC",
    inputRequirements: [{
      key: "subscriber_list",
      surface: "input.contacts_csv",
      when: "run_start",
      required: true,
    }],
    agentGraph: {
      parent: { id: "parent", name: "Coordinator", task: "Coordinate", policy: "Send" },
      children: [{
        id: "send",
        name: "Send Agent",
        task: "Send email",
        goal: "Deliver",
        tools: [{ ref: "internal.llm_only" }],
      }],
    },
  });
  const context = runtimeContextSchema.parse({ inputs: {} });
  assert.throws(
    () => applyGateSurfaceSubmission({
      definition,
      context,
      values: {
        recipients: {
          surface: "input.contacts_csv",
          contacts: [{ email: "alex@example.com" }],
        },
      },
    }),
    /Undeclared operator input: recipients\. Declared inputs: subscriber_list\./,
  );
});

test("team email requires run_start content only when explicitly declared", () => {
  assert.equal(specRequiresRunStartContent({
    delivery: { target: "team_email" },
    inputRequirements: [{ key: "confirm_send", surface: "confirm.send", when: "before_send", required: true }],
  }), false);
  assert.equal(specRequiresRunStartContent({
    delivery: { target: "team_email" },
    inputRequirements: [{ key: "sprint_notes", surface: "input.markdown", when: "run_start", required: true }],
  }), true);
});
