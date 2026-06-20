import assert from "node:assert/strict";
import test from "node:test";

import { compileSpecRunPlan } from "../../../src/services/loop-runtime/spec-run-plan.js";
import { buildSpecRunSystemPrompt } from "../../../src/services/loop-runtime/spec-run-prompt.js";
import { projectRunContext } from "../../../src/services/loop-runtime/build-run-context.js";
import { gmailTriggerDedupeKey } from "../../../src/services/loop-runtime/trigger-normalizers/gmail.js";

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

const spec = {
  version: "v1",
  goal: "Support loop",
  title: "Support",
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  definitionVersion: "loop_executor_v2",
  schedulerTarget: "internal",
  allowedIntegrations: ["internal"],
  ceo: { name: "CEO", task: "Support loop", policy: "Support loop" },
  draftPolicy: { requireDraftBeforeExternalAction: true, approvalRequiredFor: ["publish", "send", "external_action"] },
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
  builderMeta: {
    designedBy: "loop_architect",
    preApproved: true,
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
  },
  agentGraph: {
    parent: { id: "orchestrator", name: "Orchestrator", task: "Support loop", policy: "Support loop" },
    children: [
      {
        id: "context-reader",
        name: "Context Reader",
        goal: "Read context, search history, and collect source facts.",
        task: "Read context, search history, and collect source facts.",
        tools: ["internal.memory_search", "composio.crm.search", "composio.mail.action.GMAIL_FETCH_MESSAGE_BY_THREAD_ID"],
        guardrails: [],
        doneCriteria: ["Ticket context is ready."],
        failureModes: [],
      },
      {
        id: "draft-writer",
        name: "Draft Writer",
        goal: "Draft reply, create the draft artifact, and request approval for writes.",
        task: "Draft reply, create the draft artifact, and request approval for writes.",
        tools: ["composio.mail.action.GMAIL_CREATE_EMAIL_DRAFT", "composio.mail.action.GMAIL_SEND_DRAFT"],
        guardrails: ["Do not send directly."],
        doneCriteria: ["Draft is ready for review."],
        failureModes: [],
      },
    ],
  },
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
} as any;

test("compileSpecRunPlan exposes only build-contract selected connector actions", () => {
  const plan = compileSpecRunPlan(spec);

  assert.ok(plan.writeTools.some((tool) => tool.actionSlug === "GMAIL_CREATE_EMAIL_DRAFT"));
  assert.ok(plan.readTools.some((tool) => tool.actionSlug === "GMAIL_LIST_THREADS"));
});

test("draft_only review policy hides send actions", () => {
  const plan = compileSpecRunPlan(spec);

  assert.ok(plan.writeTools.some((tool) => tool.actionSlug === "GMAIL_CREATE_EMAIL_DRAFT"));
  assert.equal(plan.writeTools.some((tool) => tool.actionSlug === "GMAIL_SEND_DRAFT"), false);
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
