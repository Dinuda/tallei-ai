import assert from "node:assert/strict";
import test from "node:test";

import { isBlueprintComplete, normalizeTaskBlueprint, validateConnectorChoicesBeforeSpecPatch } from "../../../src/loops/task-decomposition.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";
import type { TaskBlueprint } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("normalizeTaskBlueprint assigns ids and defaults", () => {
  const normalized = normalizeTaskBlueprint({
    version: 1,
    summary: "Support triage",
    outcomes: [{
      role: "source",
      description: "Ticket content available",
    } as TaskBlueprint["outcomes"][number]],
  });
  assert.equal(normalized.outcomes[0]!.id.length > 0, true);
  assert.equal(normalized.outcomes[0]!.status, "pending");
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
        status: "pending",
      },
      {
        id: "b",
        role: "destination",
        description: "dest",
        status: "chosen",
        selectedConnector: "zendesk",
      },
    ],
  };
  assert.equal(isBlueprintComplete(pending), false);

  const done: TaskBlueprint = {
    ...pending,
    outcomes: [
      { ...pending.outcomes[0]!, status: "chosen", selectedConnector: "gmail" },
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
    assert.match(result.error, /taskBlueprint/i);
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
      status: "chosen",
      selectedConnector: "gmail",
    }],
  };
  const result = validateConnectorChoicesBeforeSpecPatch(spec, {
    bindings: [{ connector: "gmail", capability: "email.read", role: "trigger" }],
  });
  assert.equal(result.ok, true);
});
