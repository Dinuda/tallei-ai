import assert from "node:assert/strict";
import test from "node:test";

import { hydrateStoredTrigger, parseStoredLoopSpec } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("parseStoredLoopSpec hydrates legacy event trigger with slug in eventType", () => {
  const spec = parseStoredLoopSpec({
    workspaceId,
    intent: { goal: "g", outcome: "o", successCriteria: [] },
    trigger: {
      kind: "event",
      source: "gmail",
      eventType: "GMAIL_NEW_GMAIL_MESSAGE",
    },
    profile: "agentic",
    bindings: [{ capability: "email.read", connector: "gmail" }],
    output: { kind: "none" },
  });
  assert.equal(spec.trigger.kind, "event");
  if (spec.trigger.kind === "event") {
    assert.equal(spec.trigger.composioSlug, "GMAIL_NEW_GMAIL_MESSAGE");
    assert.equal(spec.trigger.eventType, "GMAIL_NEW_GMAIL_MESSAGE");
  }
});

test("parseStoredLoopSpec accepts missing composioSlug for draft event loops", () => {
  const spec = parseStoredLoopSpec({
    workspaceId,
    intent: { goal: "g", outcome: "o", successCriteria: [] },
    trigger: {
      kind: "event",
      source: "gmail",
      eventType: "new_message",
    },
    profile: "agentic",
    bindings: [],
    output: { kind: "none" },
  });
  assert.equal(spec.trigger.kind, "event");
  if (spec.trigger.kind === "event") {
    assert.equal(spec.trigger.composioSlug, "");
    assert.equal(spec.trigger.eventType, "new_message");
  }
});

test("parseStoredLoopSpec hydrates legacy blueprint connector selection into chosen status", () => {
  const spec = parseStoredLoopSpec({
    workspaceId,
    intent: { goal: "g", outcome: "o", successCriteria: [] },
    trigger: { kind: "manual" },
    profile: "agentic",
    bindings: [],
    taskBlueprint: {
      version: 1,
      summary: "Support triage",
      outcomes: [{
        id: "out-1",
        role: "source",
        description: "Read email",
        status: "pending",
        selectedConnector: "gmail",
      }],
    },
    output: { kind: "none" },
  });

  assert.equal(spec.taskBlueprint?.outcomes[0]?.status, "chosen");
  assert.equal(spec.taskBlueprint?.outcomes[0]?.selectedConnector, "gmail");
});

test("parseStoredLoopSpec infers one legacy role connector from bindings", () => {
  const spec = parseStoredLoopSpec({
    workspaceId,
    intent: { goal: "g", outcome: "o", successCriteria: [] },
    trigger: { kind: "manual" },
    profile: "agentic",
    bindings: [{ capability: "email.read", connector: "outlook", role: "source" }],
    taskBlueprint: {
      version: 1,
      summary: "Support triage",
      outcomes: [{ id: "out-1", role: "source", description: "Read email", status: "chosen" }],
    },
    output: { kind: "none" },
  });

  assert.equal(spec.taskBlueprint?.outcomes[0]?.status, "chosen");
  assert.equal(spec.taskBlueprint?.outcomes[0]?.selectedConnector, "outlook");
});

test("parseStoredLoopSpec does not reorder legacy multi-phase blueprints on hydrate", () => {
  const outcomes = [
    { id: "read1", role: "source", description: "Read Gmail", status: "pending", selectedConnector: "gmail" },
    { id: "llm1", role: "transform", description: "Summarize for Slack", status: "pending" },
    { id: "slack", role: "destination", description: "Post Slack", status: "pending", selectedConnector: "slack" },
    { id: "read2", role: "source", description: "Re-read Gmail", status: "pending", selectedConnector: "gmail" },
    { id: "llm2", role: "transform", description: "Draft reply", status: "pending" },
    { id: "send", role: "destination", description: "Send Gmail", status: "pending", selectedConnector: "gmail" },
  ];
  const spec = parseStoredLoopSpec({
    workspaceId,
    intent: { goal: "g", outcome: "o", successCriteria: [] },
    trigger: { kind: "manual" },
    profile: "agentic",
    bindings: [],
    taskBlueprint: {
      version: 1,
      summary: "Cross-app workflow",
      outcomes,
    },
    output: { kind: "none" },
  });

  assert.deepEqual(spec.taskBlueprint?.outcomes.map((outcome) => outcome.id), outcomes.map((outcome) => outcome.id));
});

test("hydrateStoredTrigger leaves schedule triggers unchanged", () => {
  const trigger = hydrateStoredTrigger({ kind: "schedule", cron: "0 7 * * *", timezone: "UTC" });
  assert.deepEqual(trigger, { kind: "schedule", cron: "0 7 * * *", timezone: "UTC" });
});
