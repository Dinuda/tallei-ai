import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOutcomesFromExecutionOrder,
  isBlueprintComplete,
  isMultiPhaseBlueprint,
  normalizeBlueprintOutcomeOrder,
  normalizeTaskBlueprint,
  orderBlueprintOutcomes,
  outcomesMatchExecutionOrder,
  validateConnectorChoicesBeforeSpecPatch,
} from "../../../src/loops/task-decomposition.js";
import { applySpecPatch } from "../../../src/loops/patch.js";
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

test("orderBlueprintOutcomes fixes single-pass misorder", () => {
  const ordered = orderBlueprintOutcomes([
    { role: "trigger", description: "Start" },
    { role: "destination", description: "Send" },
    { role: "transform", description: "Draft" },
  ] as TaskBlueprint["outcomes"]);
  assert.deepEqual(ordered.map((outcome) => outcome.role), ["trigger", "transform", "destination"]);
});

test("isMultiPhaseBlueprint detects source after destination", () => {
  const outcomes = [
    { role: "source", description: "Read Gmail" },
    { role: "transform", description: "Summarize" },
    { role: "destination", description: "Post Slack" },
    { role: "source", description: "Re-read Gmail" },
    { role: "transform", description: "Draft reply" },
    { role: "destination", description: "Send Gmail" },
  ] as TaskBlueprint["outcomes"];
  assert.equal(isMultiPhaseBlueprint(outcomes), true);
  assert.deepEqual(
    normalizeBlueprintOutcomeOrder(outcomes).map((outcome) => outcome.role),
    outcomes.map((outcome) => outcome.role),
  );
});

test("normalizeBlueprintOutcomeOrder preserves order when executionOrder matches", () => {
  const executionOrder = [
    { role: "trigger", description: "New support tickets arrive in Gmail" },
    { role: "transform", description: "Classify priority and draft replies" },
    { role: "destination", description: "Send drafted replies" },
  ] as const;
  const outcomes = executionOrder.map((step, index) => ({
    id: `out-${index}`,
    role: step.role,
    description: step.description,
    status: "pending" as const,
  }));
  assert.equal(outcomesMatchExecutionOrder(outcomes, [...executionOrder]), true);
  assert.deepEqual(
    normalizeBlueprintOutcomeOrder(outcomes, [...executionOrder]).map((outcome) => outcome.role),
    ["trigger", "transform", "destination"],
  );
});

test("buildOutcomesFromExecutionOrder preserves order and reuses existing outcomes", () => {
  const executionOrder = [
    { role: "source", description: "Read Gmail" },
    { role: "transform", description: "Draft reply" },
    { role: "destination", description: "Send Gmail" },
  ] as const;
  const existing = [{
    id: "read-1",
    role: "source",
    description: "Read Gmail",
    status: "chosen",
    selectedConnector: "gmail",
  }] as TaskBlueprint["outcomes"];
  const built = buildOutcomesFromExecutionOrder([...executionOrder], existing);
  assert.deepEqual(built.map((outcome) => outcome.role), ["source", "transform", "destination"]);
  assert.equal(built[0]?.id, "read-1");
  assert.equal(built[0]?.selectedConnector, "gmail");
});

test("applySpecPatch applies fallback reorder for legacy single-pass misorder", () => {
  const spec = applySpecPatch(createEmptyLoopSpec(workspaceId), {
    taskBlueprint: {
      version: 1,
      summary: "Support triage",
      outcomes: [
        { id: "t", role: "trigger", description: "New tickets", status: "pending" },
        { id: "d", role: "destination", description: "Send replies", status: "pending" },
        { id: "x", role: "transform", description: "Classify and draft", status: "pending" },
      ],
    },
  });
  assert.deepEqual(
    spec.taskBlueprint?.outcomes.map((outcome) => outcome.role),
    ["trigger", "transform", "destination"],
  );
});

test("applySpecPatch preserves multi-phase order without executionOrder", () => {
  const outcomes = [
    { id: "read1", role: "source", description: "Read Gmail", status: "pending" },
    { id: "llm1", role: "transform", description: "Summarize for Slack", status: "pending" },
    { id: "slack", role: "destination", description: "Post Slack", status: "pending" },
    { id: "read2", role: "source", description: "Re-read Gmail", status: "pending" },
    { id: "llm2", role: "transform", description: "Draft reply", status: "pending" },
    { id: "send", role: "destination", description: "Send Gmail", status: "pending" },
  ] as TaskBlueprint["outcomes"];
  const spec = applySpecPatch(createEmptyLoopSpec(workspaceId), { taskBlueprint: {
    version: 1,
    summary: "Cross-app workflow",
    outcomes,
  } });
  assert.deepEqual(spec.taskBlueprint?.outcomes.map((outcome) => outcome.id), outcomes.map((outcome) => outcome.id));
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
