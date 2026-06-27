import assert from "node:assert/strict";
import test from "node:test";

import { decomposeTask, isBlueprintComplete, validateConnectorChoicesBeforeSpecPatch } from "../../../src/loops/task-decomposition.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";
import type { TaskBlueprint } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("decomposeTask proposes source and destination for newsletter goals", () => {
  const blueprint = decomposeTask({
    goal: "Send a newsletter about what is new in AI",
    outcome: "Subscribers receive a curated AI update",
  });
  const roles = blueprint.outcomes.map((outcome) => outcome.role);
  assert.ok(roles.includes("source"));
  assert.ok(roles.includes("destination"));
  assert.equal(blueprint.version, 1);
});

test("decomposeTask adds trigger for event-driven goals", () => {
  const blueprint = decomposeTask({
    goal: "When a new support email arrives, classify and reply",
  });
  assert.ok(blueprint.outcomes.some((outcome) => outcome.role === "trigger"));
  assert.ok(blueprint.outcomes.some((outcome) => outcome.role === "source"));
});

test("isBlueprintComplete requires chosen connectors on required outcomes", () => {
  const pending: TaskBlueprint = {
    version: 1,
    summary: "test",
    outcomes: [
      {
        id: "a",
        role: "source",
        description: "source",
        candidates: [],
        status: "pending",
      },
      {
        id: "b",
        role: "destination",
        description: "dest",
        candidates: [],
        status: "chosen",
        selectedConnector: "gmail",
      },
    ],
  };
  assert.equal(isBlueprintComplete(pending), false);

  const done: TaskBlueprint = {
    ...pending,
    outcomes: [
      { ...pending.outcomes[0]!, status: "chosen", selectedConnector: "notion" },
      pending.outcomes[1]!,
    ],
  };
  assert.equal(isBlueprintComplete(done), true);
});

test("validateConnectorChoicesBeforeSpecPatch blocks bindings without blueprint", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  const result = validateConnectorChoicesBeforeSpecPatch(spec, {
    bindings: [{ connector: "gmail", capability: "email.read" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /decomposeTask/i);
  }
});

test("validateConnectorChoicesBeforeSpecPatch blocks bindings with pending outcomes", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  spec.taskBlueprint = {
    version: 1,
    summary: "Support tickets",
    outcomes: [{
      id: "t1",
      role: "trigger",
      description: "New email",
      candidates: [],
      status: "pending",
    }],
  };
  const result = validateConnectorChoicesBeforeSpecPatch(spec, {
    bindings: [{ connector: "gmail", capability: "email.read" }],
  });
  assert.equal(result.ok, false);
});

test("validateConnectorChoicesBeforeSpecPatch allows bindings when outcomes chosen", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  spec.taskBlueprint = {
    version: 1,
    summary: "Support tickets",
    outcomes: [{
      id: "t1",
      role: "trigger",
      description: "New email",
      candidates: [],
      status: "chosen",
      selectedConnector: "gmail",
    }],
  };
  const result = validateConnectorChoicesBeforeSpecPatch(spec, {
    bindings: [{ connector: "gmail", capability: "email.read", role: "trigger" }],
  });
  assert.equal(result.ok, true);
});
