import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.OPENAI_API_KEY ??= "test-openai-key";
process.env.DATABASE_URL ??= "postgresql://tallei:tallei@127.0.0.1:5432/tallei";
process.env.DATABASE_URL_FALLBACK ??= process.env.DATABASE_URL;
process.env.REDIS_URL = "";

const auth = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  authMode: "internal" as const,
  plan: "pro" as const,
};

test("memory search returns verified tool output without LLM synthesis", async () => {
  const [{ runLoopAgent }, { getToolHandler, registerToolHandler }] = await Promise.all([
    import("../../../src/services/loop-executor/agent-runner.js"),
    import("../../../src/services/loop-executor/tool-handlers.js"),
  ]);
  const originalHandler = getToolHandler("internal.memory_search");
  assert.ok(originalHandler);

  registerToolHandler("internal.memory_search", async () => ({
    text: "Memory search results:\n- [memory-1] Shipped persistent storage endpoints.",
    data: {
      query: "this week's product updates",
      sources: [{ id: "memory-1", text: "Shipped persistent storage endpoints.", score: 0.91 }],
    },
  }));

  try {
    const result = await runLoopAgent({
      auth,
      goal: "Write and send a weekly product sync email.",
      agent: {
        id: "memory_search",
        name: "Memory Search Agent",
        task: "Search memories for this week's product updates.",
        goal: "Return relevant memories with ids and excerpts.",
        tools: [{ ref: "internal.memory_search" }],
        gate: { type: "memory_confirmation", question: "Use these memories?" },
      },
      assignedTools: [{ ref: "internal.memory_search" }],
      draftPolicy: "approval_required",
      priorComments: [{
        author: "writer",
        body: "Subject: This prior comment must not cause the memory agent to draft an email.",
      }],
    });

    assert.equal(result.text, "Memory search results:\n- [memory-1] Shipped persistent storage endpoints.");
    assert.equal(result.data.mode, "tool_output_only");
    assert.deepEqual(result.data.sources, [
      { id: "memory-1", text: "Shipped persistent storage endpoints.", score: 0.91 },
    ]);
    assert.equal(result.data.llmOutput, undefined);
  } finally {
    registerToolHandler("internal.memory_search", originalHandler);
  }
});

test("memory search sources trigger confirmation gate", async () => {
  const { evaluateAgentGoal } = await import("../../../src/services/loop-engine/goal-eval.js");
  const result = await evaluateAgentGoal({
    agent: {
      id: "memory_search",
      name: "Memory Search Agent",
      task: "Search memories for this week's product updates.",
      goal: "Return relevant memories with ids and excerpts.",
      tools: [{ ref: "internal.memory_search" }],
      gate: { type: "memory_confirmation", question: "Use these memories?" },
    },
    result: {
      text: "Memory search results:\n- [memory-1] Shipped persistent storage endpoints.",
      data: {
        sources: [{ id: "memory-1", text: "Shipped persistent storage endpoints.", score: 0.91 }],
      },
    },
    definition: {
      goal: "Write and send a weekly product sync email.",
    } as never,
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.gateType, "memory_confirmation");
});
