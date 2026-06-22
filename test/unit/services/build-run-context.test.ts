import assert from "node:assert/strict";
import test from "node:test";

import {
  selectedReviewPolicy,
  selectedStableInputs,
  selectedConnectorActionSlugs,
} from "../../../src/services/loop-engine/build-contract.js";
import {
  buildRunSeedMessage,
  projectRunContext,
} from "../../../src/services/loop-runtime/build-run-context.js";
import { normalizeGmailTriggerPayload } from "../../../src/services/loop-runtime/trigger-normalizers/gmail.js";

const buildContract = {
  version: "v1" as const,
  issues: [],
  createdAt: "2026-06-17T16:37:42.542Z",
  updatedAt: "2026-06-17T16:39:01.238Z",
  requirements: [
    {
      id: "connector_selection",
      kind: "connector" as const,
      status: "resolved" as const,
      question: "connectors",
      reason: "test",
      required: true,
      allowNone: false,
      valueSchema: { type: "object" },
      validationErrors: [],
      warnings: [],
      value: {
        selections: [{
          toolkit: "gmail",
          accounts: [{ id: "17e5327e-228e-4f0f-b555-9e71d4a21496" }],
          actionSlugs: [
            "GMAIL_CREATE_EMAIL_DRAFT",
            "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
            "GMAIL_LIST_THREADS",
          ],
        }],
      },
    },
    {
      id: "trigger_schedule",
      kind: "trigger_schedule" as const,
      status: "resolved" as const,
      question: "trigger",
      reason: "test",
      required: true,
      allowNone: false,
      valueSchema: { type: "object" },
      validationErrors: [],
      warnings: [],
      value: { trigger: "event", toolkit: "gmail", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
    },
    {
      id: "stable_input:0",
      kind: "stable_input" as const,
      status: "resolved" as const,
      question: "ticket",
      reason: "test",
      required: true,
      allowNone: false,
      valueSchema: { type: "object" },
      validationErrors: [],
      warnings: [],
      value: { name: "ticket_content", value: "email_body" },
    },
    {
      id: "stable_input:1",
      kind: "stable_input" as const,
      status: "resolved" as const,
      question: "customer",
      reason: "test",
      required: true,
      allowNone: false,
      valueSchema: { type: "object" },
      validationErrors: [],
      warnings: [],
      value: { name: "customer_details", value: "sender_name_email" },
    },
    {
      id: "grounding",
      kind: "grounding" as const,
      status: "resolved" as const,
      question: "grounding",
      reason: "test",
      required: true,
      allowNone: true,
      valueSchema: { type: "object" },
      validationErrors: [],
      warnings: [],
      value: { mode: "sources", sources: [{ type: "tallei_memory" }, { type: "workspace_memory" }] },
    },
    {
      id: "review_policy",
      kind: "review_policy" as const,
      status: "resolved" as const,
      question: "review",
      reason: "test",
      required: true,
      allowNone: false,
      valueSchema: { type: "object" },
      validationErrors: [],
      warnings: [],
      value: { mode: "approve_each_action" },
    },
  ],
};

const baseSpec = {
  version: "v1" as const,
  goal: "Monitor support tickets",
  title: "Support loop",
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  discoveredToolContracts: [],
  buildContract,
  artifacts: {
    mode: "supplied_template",
    templates: [{
      id: "t1",
      name: "Acknowledgment",
      templateId: "acknowledgment",
      subject: "Re: {{ticket_subject}}",
      html: "<p>Hi {{customer_name}}</p>",
      text: "Hi {{customer_name}}",
    }],
  },
} as any;

test("normalizeGmailTriggerPayload maps common fields", () => {
  const normalized = normalizeGmailTriggerPayload({
    subject: "Help needed",
    body: "My app is broken",
    from: "Jane Doe <jane@example.com>",
    thread_id: "abc123",
    message_id: "msg456",
  });
  assert.ok(normalized);
  assert.equal(normalized.subject, "Help needed");
  assert.equal(normalized.body, "My app is broken");
  assert.equal(normalized.fromName, "Jane Doe");
  assert.equal(normalized.fromEmail, "jane@example.com");
  assert.equal(normalized.threadId, "abc123");
  assert.equal(normalized.messageId, "msg456");
});

test("build contract selectors expose stable inputs and review policy", () => {
  assert.deepEqual(selectedStableInputs(buildContract), {
    ticket_content: "email_body",
    customer_details: "sender_name_email",
  });
  assert.equal(selectedReviewPolicy(buildContract), "approve_each_action");
  assert.deepEqual(selectedConnectorActionSlugs(buildContract), [
    "GMAIL_CREATE_EMAIL_DRAFT",
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    "GMAIL_LIST_THREADS",
  ]);
});

test("projectRunContext builds ticket from Gmail trigger payload", () => {
  const runContext = projectRunContext({
    spec: baseSpec,
    workflowId: "wf-1",
    trigger: { source: "event", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", eventId: "evt-1" },
    triggerPayload: {
      data: {
        subject: "Billing issue",
        body: "I was charged twice",
        from: "Pat <pat@example.com>",
        thread_id: "thread-1",
        message_id: "msg-1",
      },
      metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", trigger_id: "ti-1" },
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      triggerInstanceId: "ti-1",
      externalEventId: "evt-1",
    },
  });

  assert.equal(runContext.hasTriggerPayload, true);
  assert.equal(runContext.ticket?.subject, "Billing issue");
  assert.equal(runContext.ticket?.body, "I was charged twice");
  assert.equal(runContext.customer?.email, "pat@example.com");
  assert.equal(runContext.connectorAccountIds.gmail, "17e5327e-228e-4f0f-b555-9e71d4a21496");
});

test("buildRunSeedMessage includes ticket and forbids memory ticket search", () => {
  const runContext = projectRunContext({
    spec: baseSpec,
    workflowId: "wf-1",
    trigger: { source: "event", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
    triggerPayload: {
      data: { subject: "Hi", body: "Need help", from: "a@b.com", thread_id: "t1" },
      metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", trigger_id: "ti-1" },
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      triggerInstanceId: "ti-1",
      externalEventId: "evt-1",
    },
  });
  const seed = buildRunSeedMessage(runContext, baseSpec);
  assert.match(seed, /Need help/);
  assert.match(seed, /do NOT search memory to discover this ticket/i);
  assert.match(seed, /Thread ID: t1/);
});

test("buildRunSeedMessage without payload reports failure mode", () => {
  const runContext = projectRunContext({
    spec: baseSpec,
    workflowId: "wf-1",
    trigger: { source: "manual" },
    triggerPayload: null,
  });
  const seed = buildRunSeedMessage(runContext, baseSpec);
  assert.match(seed, /No new tickets found/i);
});
