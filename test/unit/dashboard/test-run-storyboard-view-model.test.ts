import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import type { PresentAgentTeamOutput } from "../../../dashboard/src/components/conductor/conductor-shared";
import {
  applyPlaybackIndex,
  buildTestRunStoryboardViewModel,
} from "../../../dashboard/src/components/conductor/test-run-storyboard-view-model";
import {
  buildBeatStepData,
  normalizeTriggerTestData,
} from "../../../dashboard/src/components/conductor/test-run-step-data";

const sampleTeam: PresentAgentTeamOutput = {
  title: "Support ticket workflow",
  triggers: [{
    outcomeId: "trigger-1",
    description: "Detect when a new support ticket arrives.",
    connector: "gmail",
  }],
  specialists: [
    {
      id: "spec-1",
      name: "Tatum",
      roleTitle: "Business Analyst",
      description: "Classifies and drafts replies.",
      avatarSeed: "tatum-seed",
      ownershipSummary: "Retrieve ticket details, classify priority, and draft a personalized reply.",
      steps: [
        { outcomeId: "trigger-1", role: "trigger", description: "Detect when a new support ticket arrives." },
        { outcomeId: "transform-1", role: "transform", description: "Classify priority and draft reply." },
      ],
    },
    {
      id: "spec-2",
      name: "Bellamy",
      roleTitle: "Delivery Coordinator",
      description: "Sends the reply.",
      avatarSeed: "bellamy-seed",
      ownershipSummary: "Send the drafted reply email to the ticket sender.",
      steps: [
        { outcomeId: "destination-1", role: "destination", description: "Send the drafted reply email to the ticket sender." },
      ],
    },
  ],
  reviewer: {
    roleTitle: "Reviewer",
    description: "Reviews sensitive actions before they run.",
  },
  reviewerInsertIndex: 1,
};

test("buildTestRunStoryboardViewModel orders trigger, specialists, reviewer, and result", () => {
  const viewModel = buildTestRunStoryboardViewModel({
    team: sampleTeam,
    scenario: { label: "Incoming billing question" },
  });

  assert.deepEqual(
    viewModel.beats.map((beat) => beat.id),
    ["trigger", "specialist-spec-1", "approval", "specialist-spec-2", "result"],
  );
});

test("buildTestRunStoryboardViewModel maps failed test output to a failed beat with all errors", () => {
  const viewModel = buildTestRunStoryboardViewModel({
    team: sampleTeam,
    scenario: { label: "Incoming billing question" },
    output: {
      ok: false,
      error: "SCHEMA_MISMATCH",
      preview: "Cannot retrieve new ticket details: no available tool.",
      steps: [{ kind: "error", code: "SCHEMA_MISMATCH", message: "Missing required fields: body" }],
    },
    resolvedFromOutput: true,
  });

  assert.equal(viewModel.footer, "failed");
  assert.equal(viewModel.errors?.length, 3);
  assert.equal(viewModel.beats.some((beat) => beat.status === "failed"), true);
});

test("normalizeTriggerTestData extracts email fields from gmail-style payload", () => {
  const ticket = normalizeTriggerTestData({
    data: {
      subject: "Billing issue",
      body: "I was charged twice",
      from: "Pat <pat@example.com>",
      thread_id: "thread-1",
      message_id: "msg-1",
    },
    metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
  });

  assert.equal(ticket?.subject, "Billing issue");
  assert.equal(ticket?.body, "I was charged twice");
  assert.equal(ticket?.threadId, "thread-1");
});

test("buildTestRunStoryboardViewModel attaches realistic test data per step", () => {
  const viewModel = buildTestRunStoryboardViewModel({
    team: sampleTeam,
    scenario: {
      label: "New support ticket arrives in Gmail inbox",
      context: "Simulate a new support email arriving in the inbox.",
      triggerPayload: {
        data: {
          subject: "Need help with billing",
          body: "I was charged twice this month.",
          from: "customer@example.com",
          thread_id: "thread-abc",
        },
      },
    },
    output: {
      ok: true,
      preview: "Validated gmail.send against the scenario.",
      steps: [
        { kind: "plan", decision: { kind: "call_tool", toolId: "spec-1", args: { threadId: "thread-abc" } } },
        {
          kind: "tool",
          toolId: "spec-1",
          capability: "gmail.read",
          args: { threadId: "thread-abc" },
          result: {
            priority: "High",
            subject: "Re: Need help with billing",
            body: "Thanks for reaching out. We are reviewing your billing issue.",
          },
        },
      ],
    },
    resolvedFromOutput: true,
  });

  const trigger = viewModel.beats.find((beat) => beat.kind === "trigger");
  const specialist = viewModel.beats.find((beat) => beat.id === "specialist-spec-1");

  assert.ok(trigger?.stepData?.some((section) => section.title === "Incoming email"));
  assert.ok(specialist?.stepData?.some((section) => section.title === "Ticket received"));
  assert.ok(specialist?.stepData?.some((section) => section.title === "Classification & draft"));
});

test("applyPlaybackIndex marks prior beats completed and current beat active", () => {
  const base = buildTestRunStoryboardViewModel({ team: sampleTeam }).beats;
  const beats = applyPlaybackIndex(base, 2, false);

  assert.equal(beats[0]?.status, "completed");
  assert.equal(beats[2]?.status, "active");
});

test("conductor-tool-part renders TestRunStoryboardCard for testRunLoop", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-tool-part.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /toolName === "testRunLoop"/);
  assert.match(source, /<TestRunStoryboardCard/);
});
