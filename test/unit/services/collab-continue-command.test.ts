import assert from "node:assert/strict";
import test from "node:test";

import { buildFirstTurnContinueCommand, type CollabTask } from "../../../src/services/collab.js";

function task(overrides: Partial<CollabTask>): CollabTask {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tenantId: "tenant_1",
    userId: "user_1",
    title: "Week 2 AI course content",
    brief: null,
    state: "TECHNICAL",
    lastActor: "chatgpt",
    iteration: 1,
    maxIterations: 4,
    context: {},
    transcript: [],
    errorMessage: null,
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

test("buildFirstTurnContinueCommand asks for Claude handoff with short command", () => {
  const command = buildFirstTurnContinueCommand(task({ state: "TECHNICAL", lastActor: "chatgpt" }));

  assert.equal(command?.target_actor, "claude");
  assert.equal(command?.command, "continue task 00000000-0000-4000-8000-000000000001");
  assert.match(command?.instruction ?? "", /Do you want to hand off to Claude now/);
  assert.doesNotMatch(command?.instruction ?? "", /handoff prompt/i);
});
