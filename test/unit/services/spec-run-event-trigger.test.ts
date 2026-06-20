import assert from "node:assert/strict";
import test from "node:test";

import { buildSpecRunTools } from "../../../src/services/loop-runtime/spec-run-tools.js";
import { buildSpecRunSystemPrompt } from "../../../src/services/loop-runtime/spec-run-prompt.js";
import { projectRunContext } from "../../../src/services/loop-runtime/build-run-context.js";
import { gmailTriggerDedupeKey } from "../../../src/services/loop-runtime/trigger-normalizers/gmail.js";
import type { RunnableSpec } from "../../../src/services/loop-runtime/spec-run-types.js";
import type { AuthContext } from "../../../src/domain/auth/index.js";

const auth = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
} satisfies AuthContext;

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
            "GMAIL_SEND_DRAFT",
            "GMAIL_LIST_THREADS",
          ],
        }],
      },
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
      value: { mode: "draft_only" },
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
      value: { mode: "sources", sources: [{ type: "tallei_memory" }] },
    },
  ],
};

const spec: RunnableSpec = {
  version: "v1",
  goal: "Support loop",
  title: "Support",
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  buildContract,
  discoveredToolContracts: [
    {
      toolRef: "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT",
      provider: "composio",
      name: "Create draft",
      description: "Create draft",
      skillTags: [],
      effect: "write_external",
      resources: [],
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      executionMode: "approval_executed",
      approval: { required: true },
      renderRecommendations: [],
      constraints: { toolkit: "gmail", actionSlug: "GMAIL_CREATE_EMAIL_DRAFT", connected: true },
      source: "composio_sdk",
    },
    {
      toolRef: "composio.gmail.action.GMAIL_SEND_DRAFT",
      provider: "composio",
      name: "Send draft",
      description: "Send draft",
      skillTags: [],
      effect: "write_external",
      resources: [],
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      executionMode: "approval_executed",
      approval: { required: true },
      renderRecommendations: [],
      constraints: { toolkit: "gmail", actionSlug: "GMAIL_SEND_DRAFT", connected: true },
      source: "composio_sdk",
    },
    {
      toolRef: "composio.gmail.action.GMAIL_LIST_THREADS",
      provider: "composio",
      name: "List threads",
      description: "List threads",
      skillTags: [],
      effect: "read_external",
      resources: [],
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      executionMode: "short_circuit",
      approval: { required: false },
      renderRecommendations: [],
      constraints: { toolkit: "gmail", actionSlug: "GMAIL_LIST_THREADS", connected: true },
      source: "composio_sdk",
    },
  ],
  noSlopSpec: {
    id: "spec-id",
    slug: "support",
    title: "Support",
    version: 1,
    bodyMarkdown: "",
    approvedAt: "2026-06-17T16:40:46.916Z",
    buildContract,
    specJson: {
      purpose: "Support loop",
      agents: [{ name: "A", goal: "G", tools: [], guardrails: [], doneWhen: [], failureModes: [] }],
      guardrails: [],
      successCriteria: [],
      failureModes: [],
      delivery: { provider: "none", description: "none" },
      schedule: { description: "daily" },
      connectorPolicy: { allowedReadActions: [], allowedWriteActions: [] },
      inputRequirements: [],
      buildContract,
    },
  },
};

test("buildSpecRunTools exposes connector_selection read and write actions", () => {
  const { tools } = buildSpecRunTools({
    auth,
    spec,
    runId: "run-1",
    workflowId: "wf-1",
    workflowTitle: "Support",
  });
  assert.ok(tools.action_gmail_GMAIL_CREATE_EMAIL_DRAFT);
  assert.ok(tools.action_gmail_GMAIL_LIST_THREADS);
});

test("draft_only review policy hides send actions", () => {
  const { tools } = buildSpecRunTools({
    auth,
    spec,
    runId: "run-1",
    workflowId: "wf-1",
    workflowTitle: "Support",
  });
  assert.ok(tools.action_gmail_GMAIL_CREATE_EMAIL_DRAFT);
  assert.equal(tools.action_gmail_GMAIL_SEND_DRAFT, undefined);
});

test("event run with payload exposes getTriggerTicket tool", () => {
  const runContext = projectRunContext({
    spec,
    workflowId: "wf-1",
    trigger: { source: "event", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
    triggerPayload: {
      data: { subject: "Hi", body: "Help", from: "a@b.com" },
      metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", trigger_id: "ti-1" },
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      triggerInstanceId: "ti-1",
      externalEventId: "evt-1",
    },
  });
  const { tools } = buildSpecRunTools({
    auth,
    spec,
    runId: "run-1",
    workflowId: "wf-1",
    workflowTitle: "Support",
    runContext,
  });
  assert.ok(tools.getTriggerTicket);
});

test("buildSpecRunSystemPrompt includes runtime policies for event runs", () => {
  const runContext = projectRunContext({
    spec,
    workflowId: "wf-1",
    trigger: { source: "event", triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
    triggerPayload: {
      data: { subject: "Hi", body: "Help", from: "a@b.com" },
      metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", trigger_id: "ti-1" },
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      triggerInstanceId: "ti-1",
      externalEventId: "evt-1",
    },
  });
  const prompt = buildSpecRunSystemPrompt(spec, runContext);
  assert.match(prompt, /Runtime policies/);
  assert.match(prompt, /do NOT search memory to discover the ticket/i);
  assert.match(prompt, /Draft-only mode/);
});

test("gmail trigger dedupe prefers message id", () => {
  const left = gmailTriggerDedupeKey({
    id: "msg-123",
    threadId: "thread-1",
    from: "Customer <customer@example.com>",
    subject: "Site down",
    body: "The site seems down.",
  });
  const right = gmailTriggerDedupeKey({
    message_id: "msg-123",
    thread_id: "thread-2",
    from_email: "other@example.com",
    subject: "Different envelope",
    body: "Different body",
  });

  assert.equal(left, "gmail:message:msg-123");
  assert.equal(right, left);
});

test("gmail trigger dedupe falls back to stable message fields", () => {
  const left = gmailTriggerDedupeKey({
    threadId: "thread-1",
    from: "Customer <customer@example.com>",
    subject: "Site down",
    body: "The site seems down.",
  });
  const right = gmailTriggerDedupeKey({
    thread_id: "thread-1",
    from_email: "customer@example.com",
    subject: "SITE DOWN",
    body: "The site seems down.",
  });

  assert.ok(left?.startsWith("gmail:fallback:"));
  assert.equal(right, left);
});
