import assert from "node:assert/strict";
import test from "node:test";

import { applySpecPatch, getMissingSlots, isReadyToCompile, seedSpecFromTemplate } from "../../../src/loops/patch.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

test("seedSpecFromTemplate research_digest fills intent", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const spec = seedSpecFromTemplate(workspaceId, "research_digest");
  assert.equal(spec.profile, "agentic");
  assert.ok(spec.intent.goal.includes("digest"));
});

test("seedSpecFromTemplate uses mixed destination approval for review-first loops", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const spec = seedSpecFromTemplate(workspaceId, "support_auto_reply");
  assert.equal(spec.approval.mode, "mixed");
  assert.deepEqual(spec.approval.sensitiveRoles, ["destination"]);
});

test("applySpecPatch updates bindings", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const base = seedSpecFromTemplate(workspaceId, "research_digest");
  const updated = applySpecPatch(base, {
    bindings: [{ capability: "email.read", connector: "outlook", role: "source" }],
  });
  assert.equal(updated.bindings[0]?.connector, "outlook");
  assert.equal(updated.bindings[0]?.role, "source");
});

test("applySpecPatch preserves an explicit Composio action slug", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const base = seedSpecFromTemplate(workspaceId, "research_digest");
  const updated = applySpecPatch(base, {
    bindings: [{
      capability: "records.read",
      connector: "generic",
      actionSlug: "GENERIC_FETCH_RECORDS_EXACT",
      role: "source",
    }],
  });

  assert.equal(updated.bindings[0]?.actionSlug, "GENERIC_FETCH_RECORDS_EXACT");
});

test("applySpecPatch round-trips taskBlueprint", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const base = seedSpecFromTemplate(workspaceId, "research_digest");
  const updated = applySpecPatch(base, {
    taskBlueprint: {
      version: 1,
      summary: "Newsletter",
      outcomes: [{
        id: "dest",
        role: "destination",
        description: "Send newsletter",
        selectedConnector: "mailchimp",
        status: "chosen",
      }],
    },
  });
  assert.equal(updated.taskBlueprint?.summary, "Newsletter");
  assert.equal(updated.taskBlueprint?.outcomes[0]?.status, "chosen");
  assert.equal(updated.taskBlueprint?.outcomes[0]?.selectedConnector, "mailchimp");
});

test("applySpecPatch preserves blueprint order when executionOrder matches", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const executionOrder = [
    { role: "trigger", description: "New support tickets arrive in Gmail" },
    { role: "transform", description: "Classify priority and draft replies" },
    { role: "destination", description: "Send drafted replies" },
  ] as const;
  const base = applySpecPatch(createEmptyLoopSpec(workspaceId), {
    intentDiscovery: {
      status: "ready",
      analysis: {
        outcome: "Classified tickets with drafts ready for review",
        trigger: "When a new support ticket arrives",
        executionOrder: [...executionOrder],
        questions: [{
          id: "confirm-outcome",
          question: "Does this outcome look right?",
          options: [
            { id: "yes", label: "Yes", value: "yes" },
            { id: "change", label: "Change it", value: "change" },
          ],
        }],
        decisions: [],
      },
      decisions: [],
      askedQuestionIds: [],
    },
  });
  const updated = applySpecPatch(base, {
    taskBlueprint: {
      version: 1,
      summary: "Support triage",
      outcomes: executionOrder.map((step, index) => ({
        id: `out-${index}`,
        role: step.role,
        description: step.description,
        status: "pending" as const,
      })),
    },
  });
  assert.deepEqual(
    updated.taskBlueprint?.outcomes.map((outcome) => outcome.role),
    ["trigger", "transform", "destination"],
  );
});

test("changing a connector invalidates only dependent generated configuration", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const base = seedSpecFromTemplate(workspaceId, "research_digest");
  base.taskBlueprint = {
    version: 1,
    summary: "Digest",
    outcomes: [
      { id: "source", role: "source", description: "Read mail", selectedConnector: "gmail", status: "chosen" },
      { id: "destination", role: "destination", description: "Post alert", selectedConnector: "slack", status: "chosen" },
    ],
  };
  base.bindings = [
    { capability: "email.read", connector: "gmail", role: "source" },
    { capability: "chat.send", connector: "slack", role: "destination" },
  ];
  base.composioActions = [
    { toolkit: "gmail", actionSlug: "GMAIL_FETCH", inputInstructions: [], outputInstructions: [], dependsOn: [] },
    { toolkit: "slack", actionSlug: "SLACK_SEND", inputInstructions: [], outputInstructions: [], dependsOn: [] },
  ];

  const updated = applySpecPatch(base, {
    taskBlueprint: {
      ...base.taskBlueprint,
      outcomes: [
        { ...base.taskBlueprint.outcomes[0]!, selectedConnector: "outlook" },
        base.taskBlueprint.outcomes[1]!,
      ],
    },
  });

  assert.deepEqual(updated.bindings.map((binding) => binding.connector), ["slack"]);
  assert.deepEqual(updated.composioActions.map((action) => action.toolkit), ["slack"]);
});

test("getMissingSlots detects empty bindings on draft template", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const spec = seedSpecFromTemplate(workspaceId, "");
  const missing = getMissingSlots(spec);
  assert.ok(missing.includes("bindings"));
});

test("getMissingSlots requires composioSlug for event triggers", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const spec = seedSpecFromTemplate(workspaceId, "lead_scoring");
  spec.trigger = { kind: "event", source: "hubspot", composioSlug: "" };
  const missing = getMissingSlots(spec);
  assert.ok(missing.includes("trigger.composioSlug"));
});

test("isReadyToCompile false until required slots filled", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const spec = seedSpecFromTemplate(workspaceId, "");
  assert.equal(isReadyToCompile(spec), false);
  spec.bindings = [{ capability: "web.search", connector: "composio" }];
  spec.trigger = { kind: "schedule", cron: "0 7 * * 1-5", timezone: "UTC" };
  spec.output = { kind: "chat", target: "#general", connector: "slack" };
  assert.equal(isReadyToCompile(spec), true);
});
