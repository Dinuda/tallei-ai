import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFirstTurnContinueCommand,
  compactCollabTransportPayload,
  extractDocumentRefsFromText,
  type CollabTask,
} from "../../../src/services/collab.js";

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
