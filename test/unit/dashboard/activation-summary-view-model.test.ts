import assert from "node:assert/strict";
import test from "node:test";

import type { PresentAgentTeamOutput } from "../../../dashboard/src/components/conductor/conductor-shared";
import { buildActivationSummaryViewModel } from "../../../dashboard/src/components/conductor/activation-summary-view-model";

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
        { outcomeId: "source-1", role: "source", description: "Retrieve full email content and sender info.", connector: "gmail" },
        { outcomeId: "transform-1", role: "transform", description: "Classify priority and draft a personalized reply." },
      ],
    },
    {
      id: "spec-2",
      name: "Bellamy",
      roleTitle: "Delivery Coordinator",
      description: "Creates the draft in Gmail.",
      avatarSeed: "bellamy-seed",
      ownershipSummary: "Create the draft in Gmail for review.",
      steps: [
        { outcomeId: "destination-1", role: "destination", description: "Create the draft in Gmail for your review.", connector: "gmail" },
      ],
    },
  ],
  reviewer: {
    roleTitle: "Reviewer",
    description: "Reviews sensitive actions before they run.",
  },
  reviewerInsertIndex: 1,
};

test("buildActivationSummaryViewModel orders trigger, specialist steps, reviewer, and delivery", () => {
  const viewModel = buildActivationSummaryViewModel({
    team: sampleTeam,
    spec: {
      approval: { mode: "mixed", sensitiveRoles: ["destination"] },
      intentDiscovery: { assumptions: ["Unclassifiable tickets default to medium priority."] },
    },
    output: { ok: true, eventTrigger: { subscribed: true } },
  });

  assert.equal(viewModel.title, "Support ticket workflow");
  assert.equal(viewModel.alreadyActive, false);
  assert.equal(viewModel.steps.length, 5);
  assert.equal(viewModel.steps[0]?.who, "Trigger");
  assert.match(viewModel.steps[1]?.who ?? "", /Tatum/);
  assert.match(viewModel.steps[2]?.who ?? "", /Tatum/);
  assert.equal(viewModel.steps[3]?.who, "You");
  assert.match(viewModel.steps[4]?.who ?? "", /Bellamy/);
  assert.match(viewModel.preferences.join(" "), /approval before sensitive actions/i);
  assert.match(viewModel.preferences.join(" "), /medium priority/i);
  assert.equal(viewModel.monitoringNote, "Monitoring your inbox for new events.");
});

test("buildActivationSummaryViewModel falls back to spec outcomes when roster is missing", () => {
  const viewModel = buildActivationSummaryViewModel({
    team: null,
    spec: {
      intent: { outcome: "Triage support email" },
      taskBlueprint: {
        summary: "Support triage",
        outcomes: [
          { id: "t1", role: "trigger", description: "New email arrives in inbox.", selectedConnector: "gmail" },
          { id: "t2", role: "transform", description: "Classify ticket priority." },
          { id: "t3", role: "destination", description: "Create a Gmail draft.", selectedConnector: "gmail" },
        ],
      },
      approval: { mode: "auto" },
    },
    output: { ok: true, alreadyActive: true },
  });

  assert.equal(viewModel.title, "Support triage");
  assert.equal(viewModel.alreadyActive, true);
  assert.equal(viewModel.steps.length, 3);
  assert.equal(viewModel.steps[0]?.who, "Trigger");
  assert.equal(viewModel.steps[1]?.who, "Tallei");
  assert.match(viewModel.preferences[0] ?? "", /automatically without an approval step/i);
  assert.equal(viewModel.monitoringNote, undefined);
});
