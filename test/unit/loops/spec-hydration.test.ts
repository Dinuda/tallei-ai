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

test("hydrateStoredTrigger leaves schedule triggers unchanged", () => {
  const trigger = hydrateStoredTrigger({ kind: "schedule", cron: "0 7 * * *", timezone: "UTC" });
  assert.deepEqual(trigger, { kind: "schedule", cron: "0 7 * * *", timezone: "UTC" });
});
