import assert from "node:assert/strict";
import test from "node:test";

import { getTriggerFieldNamesForFeasibility } from "@tallei/composio-tools/trigger-known-fields.js";
import { evaluateActionFeasibility } from "@tallei/composio-tools/schema-contract.js";
import {
  prepareBindingResolution,
  type BindingResolutionInput,
} from "../../../src/loops/binding-resolver.js";

const gmailTriggerFields = getTriggerFieldNamesForFeasibility("GMAIL_NEW_GMAIL_MESSAGE");

test("GMAIL_REPLY_TO_THREAD is infeasible when trigger only emits message_id", () => {
  const result = evaluateActionFeasibility({
    actionSlug: "GMAIL_REPLY_TO_THREAD",
    inputSchema: {
      type: "object",
      required: ["thread_id", "body"],
      properties: {
        thread_id: { type: "string" },
        body: { type: "string" },
      },
    },
    context: {
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      triggerFieldNames: gmailTriggerFields,
    },
  });

  assert.equal(result.feasible, false);
  assert.deepEqual(result.unresolvableFields, ["thread_id"]);
});

test("GMAIL_SEND_EMAIL stays feasible when reply fields are planner-constructible", () => {
  const result = evaluateActionFeasibility({
    actionSlug: "GMAIL_SEND_EMAIL",
    inputSchema: {
      type: "object",
      required: ["recipient_email", "subject", "body"],
      properties: {
        recipient_email: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
    },
    context: {
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      triggerFieldNames: gmailTriggerFields,
    },
  });

  assert.equal(result.feasible, true);
});

test("prepareBindingResolution auto-selects the only feasible Gmail send action", () => {
  const input: BindingResolutionInput = {
    actions: [{
      outcomeId: "step-5",
      connector: "gmail",
      role: "destination",
      description: "Sends the reply email to the customer",
      candidates: [{
        actionSlug: "GMAIL_REPLY_TO_THREAD",
        name: "Reply to email thread",
        description: "Reply in the original thread",
        feasible: false,
        unresolvableFields: ["thread_id"],
        feasibilityReason: "requires thread_id",
      }, {
        actionSlug: "GMAIL_SEND_EMAIL",
        name: "Send email",
        description: "Start a new email thread",
        feasible: true,
      }],
    }],
    trigger: {
      outcomeId: "step-1",
      connector: "gmail",
      description: "Monitors for new incoming support tickets",
      candidates: [{
        slug: "GMAIL_NEW_GMAIL_MESSAGE",
        name: "New Gmail message",
        configSchema: { type: "object", properties: {} },
        configurableFields: [],
      }],
    },
    answers: [],
  };

  const prepared = prepareBindingResolution(input);
  assert.equal(prepared.ready, true);
  if (!prepared.ready) return;
  assert.equal(prepared.selected.actions[0]?.selected.actionSlug, "GMAIL_SEND_EMAIL");
});

test("prepareBindingResolution drops infeasible Gmail reply actions from pending questions", () => {
  const input: BindingResolutionInput = {
    actions: [{
      outcomeId: "step-5",
      connector: "gmail",
      role: "destination",
      description: "Sends the reply email to the customer",
      candidates: [{
        actionSlug: "GMAIL_REPLY_TO_THREAD",
        name: "Reply to email thread",
        description: "Reply in the original thread",
        feasible: false,
        unresolvableFields: ["thread_id"],
        feasibilityReason: "requires thread_id",
        requiredFields: [
          { field: "thread_id", type: "string", description: "Thread id", source: "unavailable" },
          { field: "body", type: "string", description: "Body", source: "planner" },
        ],
      }, {
        actionSlug: "GMAIL_SEND_EMAIL",
        name: "Send email",
        description: "Start a new email thread",
        feasible: true,
        requiredFields: [
          { field: "recipient_email", type: "string", description: "Recipient", source: "planner" },
          { field: "subject", type: "string", description: "Subject", source: "planner" },
          { field: "body", type: "string", description: "Body", source: "planner" },
        ],
      }, {
        actionSlug: "GMAIL_CREATE_EMAIL_DRAFT",
        name: "Create draft",
        description: "Create a draft email",
        feasible: true,
      }],
    }],
    trigger: {
      outcomeId: "step-1",
      connector: "gmail",
      description: "Monitors for new incoming support tickets",
      candidates: [{
        slug: "GMAIL_NEW_GMAIL_MESSAGE",
        name: "New Gmail message",
        configSchema: { type: "object", properties: {} },
        configurableFields: [],
      }],
    },
    answers: [],
  };

  const prepared = prepareBindingResolution(input);
  assert.equal(prepared.ready, false);
  if (prepared.ready) return;
  const actionQuestion = prepared.pendingQuestions.find((question) => question.questionId === "binding-action-step-5");
  assert.ok(actionQuestion);
  assert.deepEqual(actionQuestion.options.map((option) => option.value), [
    "GMAIL_SEND_EMAIL",
    "GMAIL_CREATE_EMAIL_DRAFT",
  ]);
});
