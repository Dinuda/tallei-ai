import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCollabPlan,
  buildFirstTurnContinueCommand,
  claimTurn,
  compactCollabTransportPayload,
  createTask,
  deleteTask,
  extendIterations,
  extractDocumentRefsFromText,
  finishTask,
  submitTurn,
  type CollabTask,
} from "../../../src/services/collab.js";
import { assertPro as assertDocumentPlan } from "../../../src/services/documents.js";
import {
  approvePlan,
  startSession,
  submitAnswer,
} from "../../../src/services/orchestrator.js";
import { PlanRequiredError } from "../../../src/shared/errors/index.js";
import type { AuthContext } from "../../../src/domain/auth/index.js";

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

function auth(plan: AuthContext["plan"]): AuthContext {
  return {
    userId: "00000000-0000-4000-8000-000000000002",
    tenantId: "00000000-0000-4000-8000-000000000003",
    authMode: "oauth",
    plan,
  };
}

test("documents are available to free-plan users", () => {
  assert.doesNotThrow(() => assertDocumentPlan(auth("free")));
});

test("collab active-use guard requires pro or power", () => {
  assert.throws(() => assertCollabPlan(auth("free")), PlanRequiredError);
  assert.doesNotThrow(() => assertCollabPlan(auth("pro")));
  assert.doesNotThrow(() => assertCollabPlan(auth("power")));
});

test("free-plan users are blocked from active collab service methods before database work", async () => {
  const freeAuth = auth("free");
  await assert.rejects(
    () => createTask({ title: "Blocked", firstActor: "chatgpt" }, freeAuth),
    PlanRequiredError
  );
  await assert.rejects(
    () => claimTurn("00000000-0000-4000-8000-000000000001", "chatgpt", freeAuth),
    PlanRequiredError
  );
  await assert.rejects(
    () => submitTurn("00000000-0000-4000-8000-000000000001", "chatgpt", "draft", freeAuth),
    PlanRequiredError
  );
  await assert.rejects(
    () => finishTask("00000000-0000-4000-8000-000000000001", freeAuth),
    PlanRequiredError
  );
  await assert.rejects(
    () => extendIterations("00000000-0000-4000-8000-000000000001", 1, freeAuth),
    PlanRequiredError
  );
  await assert.rejects(
    () => deleteTask("00000000-0000-4000-8000-000000000001", freeAuth),
    PlanRequiredError
  );
  await assert.rejects(
    () => startSession({ goal: "Blocked planning", sourcePlatform: "dashboard" }, freeAuth),
    PlanRequiredError
  );
  await assert.rejects(
    () => submitAnswer("00000000-0000-4000-8000-000000000001", "answer", freeAuth),
    PlanRequiredError
  );
  await assert.rejects(
    () => approvePlan("00000000-0000-4000-8000-000000000001", freeAuth),
    PlanRequiredError
  );
});

test("buildFirstTurnContinueCommand gives direct Claude handoff instructions with short command", () => {
  const command = buildFirstTurnContinueCommand(task({ state: "TECHNICAL", lastActor: "chatgpt" }));

  assert.equal(command?.target_actor, "claude");
  assert.equal(command?.command, "continue task 00000000-0000-4000-8000-000000000001");
  assert.match(command?.instruction ?? "", /Paste this in Claude/);
  assert.match(command?.instruction ?? "", /return here and say "continue"/);
  assert.doesNotMatch(command?.instruction ?? "", /Do you want to hand off/i);
  assert.doesNotMatch(command?.instruction ?? "", /handoff prompt/i);
});

test("extractDocumentRefsFromText finds unique saved document handles", () => {
  assert.deepEqual(
    extractDocumentRefsFromText("Auto-saved as @doc:week2-polished-slides-ab12 and attached @doc:week2-polished-slides-ab12."),
    ["@doc:week2-polished-slides-ab12"]
  );
});

test("compactCollabTransportPayload keeps large collab responses under budget", () => {
  const largeContent = "x".repeat(25_000);
  const largeTask = task({
    transcript: Array.from({ length: 10 }, (_, index) => ({
      actor: index % 2 === 0 ? "chatgpt" : "claude",
      iteration: index + 1,
      content: largeContent,
      ts: `2026-04-29T00:00:${String(index).padStart(2, "0")}.000Z`,
    })),
  });
  const payload = compactCollabTransportPayload({
    ok: true,
    task_id: largeTask.id,
    recent_transcript: largeTask.transcript,
    fallback_context: {
      task_id: largeTask.id,
      title: largeTask.title,
      brief: largeTask.brief,
      state: largeTask.state,
      iteration: largeTask.iteration,
      max_iterations: largeTask.maxIterations,
      waiting_on: "claude",
      your_actor: "chatgpt",
      last_message: largeTask.transcript[largeTask.transcript.length - 1],
      last_chatgpt_entry: largeTask.transcript[8],
      last_claude_entry: largeTask.transcript[9],
      recent_transcript: largeTask.transcript,
    },
    inline_documents: [{
      ref: "doc_1",
      title: "Huge doc",
      filename: "huge.txt",
      content: largeContent,
      status: "ready",
      conversation_id: null,
    }],
  }, { maxResponseChars: 60_000 });

  assert.ok(JSON.stringify(payload).length <= 60_000);
  assert.ok(payload.payload_compacted);
  assert.match(JSON.stringify(payload), /truncated/);
});
