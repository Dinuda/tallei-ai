import assert from "node:assert/strict";
import test from "node:test";

import { suggestSessionRoles } from "../../../src/services/orchestrator.js";

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
