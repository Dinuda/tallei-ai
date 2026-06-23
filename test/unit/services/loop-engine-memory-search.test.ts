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
    import("../../../src/services/conductor/workflow/agent-runner.js"),
    import("../../../src/services/conductor/workflow/tool-handlers.js"),
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
        gate: { type: "approval", question: "Use these memories?", approval: { surface: "review.memories" } },
      },
      assignedTools: [{ ref: "internal.memory_search" }],
      draftPolicy: "approval_required",
      priorComments: [{
        author: "writer",
        body: "Subject: This prior comment must not cause the memory agent to draft an email.",
      }],
    });

    assert.equal(result.text, "Found 1 validated memories (id + excerpt):\n- [memory-1] Shipped persistent storage endpoints.");
    assert.equal(result.data.mode, "tool_output_only");
    assert.deepEqual(result.data.sources, [
      { id: "memory-1", text: "Shipped persistent storage endpoints.", score: 0.91 },
    ]);
    assert.equal(result.data.llmOutput, undefined);
  } finally {
    registerToolHandler("internal.memory_search", originalHandler);
  }
});

test("web search returns sources at top level for handoff", async () => {
  const [{ runLoopAgent }, { getToolHandler, registerToolHandler }] = await Promise.all([
    import("../../../src/services/conductor/workflow/agent-runner.js"),
    import("../../../src/services/conductor/workflow/tool-handlers.js"),
  ]);
  const originalHandler = getToolHandler("internal.web_search");
  assert.ok(originalHandler);

  registerToolHandler("internal.web_search", async () => ({
    text: "Web search results (exa-search):\nTop themes:\n- Apple AI update",
    data: {
      model: "exa-search",
      provider: "exa_web_search",
      sources: [{
        title: "Apple AI update",
        url: "https://example.com/apple-ai",
        snippet: "Apple revealed a new AI architecture.",
      }],
    },
    shortCircuit: true,
  }));

  try {
    const result = await runLoopAgent({
      auth,
      goal: "Write a weekly AI industry newsletter.",
      agent: {
        id: "web_research",
        name: "Research Agent",
        task: "Find recent AI industry news with URLs.",
        goal: "Return recent web sources with title, url, and snippet.",
        tools: [{ ref: "internal.web_search" }],
      },
      assignedTools: [{ ref: "internal.web_search" }],
      draftPolicy: "approval_required",
      priorComments: [],
    });

    assert.equal(result.data.mode, "tool_output_only");
    assert.deepEqual(result.data.sources, [{
      title: "Apple AI update",
      url: "https://example.com/apple-ai",
      snippet: "Apple revealed a new AI architecture.",
    }]);
  } finally {
    registerToolHandler("internal.web_search", originalHandler);
  }
});
