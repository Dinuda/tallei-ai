import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionFallbackContext,
  suggestSessionRoles,
  type OrchestrationSession,
} from "../../../src/services/orchestrator.js";

test("suggestSessionRoles rejects missing title", async () => {
  await assert.rejects(
    () => suggestSessionRoles({ title: "   " }),
    /title is required/
  );
});

test("suggestSessionRoles returns fallback defaults when planner call is unavailable", async () => {
  const result = await suggestSessionRoles({
    title: "Launch creator growth experiments",
    brief: "Need ideas and concrete weekly execution",
  });

  assert.equal(typeof result.chatgpt_role, "string");
  assert.equal(typeof result.claude_role, "string");
  assert.ok(result.chatgpt_role.length > 0);
  assert.ok(result.claude_role.length > 0);
  assert.equal(result.first_actor_recommendation, "chatgpt");
});

test("suggestSessionRoles returns a valid starter recommendation for technical prompts", async () => {
  const result = await suggestSessionRoles({
    title: "Implement auth migration",
    brief: "Define API schema updates and database migration test plan",
  });

  assert.ok(result.first_actor_recommendation === "chatgpt" || result.first_actor_recommendation === "claude");
});

test("buildSessionFallbackContext exposes persisted role selection", () => {
  const session: OrchestrationSession = {
    id: "00000000-0000-4000-8000-000000000001",
    tenantId: "tenant-1",
    userId: "user-1",
    goal: "Create week 2 AI course content",
    status: "INTERVIEWING",
    transcript: [
      {
        role: "planner",
        content: "What outcome should week 2 produce?",
        ts: "2026-04-29T00:00:00.000Z",
      },
    ],
    plan: null,
    collabTaskId: null,
    metadata: {
      role_selection: {
        chatgpt_role: "Draft creative lesson options.",
        claude_role: "Stress-test structure and learning objectives.",
        first_actor_recommendation: "chatgpt",
        selected_first_actor: "chatgpt",
        selection_mode: "auto",
      },
    },
    errorMessage: null,
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
  };

  const context = buildSessionFallbackContext(session);

  assert.deepEqual(context.role_selection, {
    chatgpt_role: "Draft creative lesson options.",
    claude_role: "Stress-test structure and learning objectives.",
    first_actor_recommendation: "chatgpt",
    selected_first_actor: "chatgpt",
    selection_mode: "auto",
  });
});
