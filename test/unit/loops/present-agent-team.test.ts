import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAgentTeam } from "../../../src/loops/present-agent-team.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

function buildSpec(outcomes: Array<{
  id: string;
  role: "trigger" | "source" | "transform" | "destination";
  description: string;
  selectedConnector?: string;
}>) {
  const spec = createEmptyLoopSpec(workspaceId);
  spec.intent.goal = "Support inbox automation";
  spec.intent.outcome = "Triage and draft support replies";
  spec.taskBlueprint = {
    version: 1,
    summary: "Support inbox helper",
    outcomes: outcomes.map((outcome) => ({
      ...outcome,
      status: "chosen" as const,
    })),
  };
  spec.approval = {
    mode: "mixed",
    sensitiveRoles: ["destination"],
    sensitiveCapabilities: [],
  };
  return spec;
}

test("normalizeAgentTeam groups adjacent retrieval and classification into one persona", () => {
  const spec = buildSpec([
    { id: "trigger", role: "trigger", description: "Watch for new support messages", selectedConnector: "zendesk" },
    { id: "read", role: "source", description: "Retrieve ticket", selectedConnector: "zendesk" },
    { id: "classify", role: "transform", description: "Classify priority" },
    { id: "draft", role: "transform", description: "Draft a personalized reply" },
    { id: "send", role: "destination", description: "Send the reply through Gmail", selectedConnector: "gmail" },
  ]);

  const team = normalizeAgentTeam({
    groups: [
      { outcomeIds: ["trigger"] },
      {
        outcomeIds: ["read", "classify"],
        roleTitle: "Intake Specialist",
        ownershipSummary: "Retrieve and classify incoming tickets",
      },
      {
        outcomeIds: ["draft"],
        roleTitle: "Reply Specialist",
        ownershipSummary: "Draft a personalized reply",
      },
      { outcomeIds: ["send"], roleTitle: "Delivery Specialist" },
    ],
  }, spec);

  assert.equal(team.fallbackApplied, undefined);
  assert.equal(team.triggers?.length, 1);
  assert.equal(team.specialists.length, 3);
  assert.deepEqual(team.specialists[0]?.steps.map((step) => step.outcomeId), ["read", "classify"]);
  assert.equal(team.specialists[0]?.roleTitle, "Support Operations Analyst");
  assert.deepEqual(team.specialists[1]?.steps.map((step) => step.outcomeId), ["draft"]);
  assert.equal(team.specialists[1]?.roleTitle, "Response Specialist");
  assert.deepEqual(team.specialists[2]?.steps.map((step) => step.outcomeId), ["send"]);
  assert.equal(team.specialists[2]?.roleTitle, "Communications Coordinator");
  assert.equal(team.reviewerInsertIndex, 2);
});

test("normalizeAgentTeam assigns professional job roles instead of model task labels", () => {
  const spec = buildSpec([
    { id: "draft", role: "transform", description: "Draft a personalized reply" },
    {
      id: "send",
      role: "destination",
      description: "Send the drafted reply email to the customer",
      selectedConnector: "gmail",
    },
  ]);

  const team = normalizeAgentTeam({
    groups: [
      { outcomeIds: ["draft"], roleTitle: "Reply Specialist", ownershipSummary: "Drafts personalized replies" },
      {
        outcomeIds: ["send"],
        roleTitle: "Reply Sender",
        ownershipSummary: "Sends the drafted reply email to the customer (after your review)",
      },
    ],
  }, spec);

  assert.equal(team.specialists[0]?.roleTitle, "Response Specialist");
  assert.equal(team.specialists[1]?.roleTitle, "Customer Outreach Coordinator");
  assert.notEqual(team.specialists[1]?.roleTitle, "Reply Sender");
});

test("normalizeAgentTeam maps support inbox personas to customer-facing job roles", () => {
  const spec = buildSpec([
    { id: "trigger", role: "trigger", description: "Detect a new incoming support ticket", selectedConnector: "gmail" },
    { id: "read", role: "source", description: "Read the ticket details (subject, message, customer info)", selectedConnector: "gmail" },
    { id: "classify", role: "transform", description: "Classify the ticket priority (urgent, high, normal, low)" },
    { id: "draft", role: "transform", description: "Draft a personalized reply based on priority and ticket content" },
    { id: "send", role: "destination", description: "Send the drafted reply email to the customer", selectedConnector: "gmail" },
  ]);

  const team = normalizeAgentTeam({
    groups: [
      { outcomeIds: ["trigger"] },
      {
        outcomeIds: ["read", "classify", "draft"],
        roleTitle: "Ticket Analyst & Drafter",
        ownershipSummary: "Reads the ticket, classifies its priority (urgent/high/normal/low), and drafts a personalized reply",
      },
      {
        outcomeIds: ["send"],
        roleTitle: "Reply Sender",
        ownershipSummary: "Sends the drafted reply email to the customer (after your review)",
      },
    ],
  }, spec);

  assert.equal(team.specialists[0]?.roleTitle, "Customer Support Analyst");
  assert.equal(team.specialists[1]?.roleTitle, "Customer Outreach Coordinator");
});

test("normalizeAgentTeam derives job roles when the model omits suggestions", () => {
  const spec = buildSpec([
    { id: "send", role: "destination", description: "Send the reply as email", selectedConnector: "gmail" },
  ]);

  const team = normalizeAgentTeam({
    groups: [{ outcomeIds: ["send"] }],
  }, spec);

  assert.equal(team.specialists[0]?.roleTitle, "Communications Coordinator");
});

test("normalizeAgentTeam falls back to one persona per outcome on invalid grouping", () => {
  const spec = buildSpec([
    { id: "a", role: "trigger", description: "Start on new message", selectedConnector: "gmail" },
    { id: "b", role: "transform", description: "Summarize the thread" },
    { id: "c", role: "destination", description: "Post the summary", selectedConnector: "slack" },
  ]);

  const team = normalizeAgentTeam({
    groups: [
      { outcomeIds: ["a", "c"] },
      { outcomeIds: ["b"] },
    ],
  }, spec);

  assert.equal(team.fallbackApplied, true);
  assert.equal(team.triggers?.length, 1);
  assert.equal(team.specialists.length, 2);
  assert.deepEqual(team.specialists[0]?.steps.map((step) => step.outcomeId), ["b"]);
  assert.deepEqual(team.specialists[1]?.steps.map((step) => step.outcomeId), ["c"]);
});

test("normalizeAgentTeam falls back when outcome ids are hallucinated", () => {
  const spec = buildSpec([
    { id: "only", role: "transform", description: "Process the request" },
  ]);

  const team = normalizeAgentTeam({
    groups: [{ outcomeIds: ["missing"] }],
  }, spec);

  assert.equal(team.fallbackApplied, true);
  assert.equal(team.specialists.length, 1);
  assert.equal(team.specialists[0]?.steps[0]?.outcomeId, "only");
});

test("normalizeAgentTeam falls back when grouping crosses the approval boundary", () => {
  const spec = buildSpec([
    { id: "draft", role: "transform", description: "Draft a personalized reply" },
    { id: "send", role: "destination", description: "Send the reply through Gmail", selectedConnector: "gmail" },
  ]);

  const team = normalizeAgentTeam({
    groups: [{ outcomeIds: ["draft", "send"] }],
  }, spec);

  assert.equal(team.fallbackApplied, true);
  assert.equal(team.specialists.length, 2);
  assert.deepEqual(team.specialists[0]?.steps.map((step) => step.outcomeId), ["draft"]);
  assert.deepEqual(team.specialists[1]?.steps.map((step) => step.outcomeId), ["send"]);
});

test("normalizeAgentTeam keeps specialist names and avatar seeds stable", () => {
  const spec = buildSpec([
    { id: "a", role: "source", description: "Read records", selectedConnector: "notion" },
    { id: "b", role: "destination", description: "Send update", selectedConnector: "slack" },
  ]);

  const first = normalizeAgentTeam({ groups: [{ outcomeIds: ["a"] }, { outcomeIds: ["b"] }] }, spec);
  const second = normalizeAgentTeam({ groups: [{ outcomeIds: ["a"] }, { outcomeIds: ["b"] }] }, spec);

  assert.equal(first.specialists[0]?.name, second.specialists[0]?.name);
  assert.equal(first.specialists[0]?.avatarSeed, second.specialists[0]?.avatarSeed);
  assert.equal(first.specialists[1]?.avatarSeed, second.specialists[1]?.avatarSeed);
});

test("normalizeAgentTeam creates unique first-name identities per persona", () => {
  const spec = buildSpec([
    { id: "a", role: "transform", description: "Classify tickets" },
    { id: "b", role: "transform", description: "Draft replies" },
    { id: "c", role: "destination", description: "Send email", selectedConnector: "gmail" },
  ]);

  const team = normalizeAgentTeam({
    groups: [{ outcomeIds: ["a"] }, { outcomeIds: ["b"] }, { outcomeIds: ["c"] }],
  }, spec);

  const names = team.specialists.map((specialist) => specialist.name);
  assert.equal(names.length, 3);
  assert.ok(names.every((name) => !name.includes(" ")));
  assert.equal(new Set(names).size, 3);
});

test("normalizeAgentTeam extracts triggers into a lab section payload", () => {
  const spec = buildSpec([
    { id: "trigger", role: "trigger", description: "Receive incoming support tickets", selectedConnector: "gmail" },
    { id: "classify", role: "transform", description: "Classify ticket priority" },
    { id: "send", role: "destination", description: "Send the reply as email", selectedConnector: "gmail" },
  ]);

  const team = normalizeAgentTeam({
    groups: [
      { outcomeIds: ["trigger"] },
      { outcomeIds: ["classify"] },
      { outcomeIds: ["send"] },
    ],
  }, spec);

  assert.equal(team.triggers?.length, 1);
  assert.equal(team.triggers?.[0]?.connector, "gmail");
  assert.equal(team.triggers?.[0]?.description, "Receive incoming support tickets");
  assert.equal(team.specialists.length, 2);
  assert.ok(team.specialists.every((specialist) => specialist.steps.every((step) => step.role !== "trigger")));
});

test("normalizeAgentTeam includes reviewer only when approval is configured", () => {
  const autoSpec = buildSpec([{ id: "a", role: "transform", description: "Run automatically" }]);
  autoSpec.approval.mode = "auto";

  const autoTeam = normalizeAgentTeam({ groups: [{ outcomeIds: ["a"] }] }, autoSpec);
  assert.equal(autoTeam.reviewer, undefined);
  assert.equal(autoTeam.reviewerInsertIndex, undefined);

  const mixedTeam = normalizeAgentTeam({ groups: [{ outcomeIds: ["a"] }] }, buildSpec([
    { id: "a", role: "transform", description: "Run with review" },
  ]));
  assert.ok(mixedTeam.reviewer);
  assert.equal(mixedTeam.reviewer?.roleTitle, "Reviewer");
});

test("normalizeAgentTeam derives reviewer placement from approval policy", () => {
  const spec = buildSpec([
    { id: "trigger", role: "trigger", description: "Watch for new support messages", selectedConnector: "gmail" },
    { id: "classify", role: "transform", description: "Classify ticket priority" },
    { id: "draft", role: "transform", description: "Draft a personalized reply" },
    { id: "send", role: "destination", description: "Send the reply as email", selectedConnector: "gmail" },
  ]);

  const team = normalizeAgentTeam({
    groups: [
      { outcomeIds: ["trigger"] },
      { outcomeIds: ["classify", "draft"] },
      { outcomeIds: ["send"] },
    ],
    reviewerBeforeSpecialistIndex: 0,
  }, spec);

  assert.equal(team.specialists.length, 2);
  assert.equal(team.reviewerInsertIndex, 1);
  assert.deepEqual(team.specialists[0]?.steps.map((step) => step.role), ["transform", "transform"]);
});

test("normalizeAgentTeam places reviewer before all specialists in ask mode", () => {
  const spec = buildSpec([
    { id: "a", role: "transform", description: "Process" },
    { id: "b", role: "destination", description: "Send", selectedConnector: "gmail" },
  ]);
  spec.approval.mode = "ask";

  const team = normalizeAgentTeam({
    groups: [{ outcomeIds: ["a"] }, { outcomeIds: ["b"] }],
    reviewerBeforeSpecialistIndex: 99,
  }, spec);

  assert.equal(team.reviewerInsertIndex, 0);
});

test("normalizeAgentTeam covers every outcome exactly once in fallback mode", () => {
  const spec = buildSpec([
    { id: "one", role: "trigger", description: "Start", selectedConnector: "gmail" },
    { id: "two", role: "transform", description: "Process" },
    { id: "three", role: "destination", description: "Deliver", selectedConnector: "slack" },
  ]);

  const team = normalizeAgentTeam({
    groups: [
      { outcomeIds: ["one"] },
      { outcomeIds: ["two", "three", "extra"] },
    ],
  }, spec);

  const covered = [
    ...(team.triggers?.map((trigger) => trigger.outcomeId) ?? []),
    ...team.specialists.flatMap((specialist) => specialist.steps.map((step) => step.outcomeId)),
  ];
  assert.deepEqual(covered, ["one", "two", "three"]);
});

test("normalizeAgentTeam falls back on duplicated outcome ids", () => {
  const spec = buildSpec([
    { id: "a", role: "transform", description: "First step" },
    { id: "b", role: "transform", description: "Second step" },
  ]);

  const team = normalizeAgentTeam({
    groups: [
      { outcomeIds: ["a", "b"] },
      { outcomeIds: ["b"] },
    ],
  }, spec);

  assert.equal(team.fallbackApplied, true);
  assert.equal(team.specialists.length, 2);
});

test("normalizeAgentTeam falls back on reordered outcome ids", () => {
  const spec = buildSpec([
    { id: "a", role: "transform", description: "First step" },
    { id: "b", role: "transform", description: "Second step" },
  ]);

  const team = normalizeAgentTeam({
    groups: [{ outcomeIds: ["b", "a"] }],
  }, spec);

  assert.equal(team.fallbackApplied, true);
  assert.deepEqual(team.specialists[0]?.steps.map((step) => step.outcomeId), ["a"]);
  assert.deepEqual(team.specialists[1]?.steps.map((step) => step.outcomeId), ["b"]);
});
