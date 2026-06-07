import { recallMemories } from "../memory.js";
import { readMemorySearchConfig, runExaWebSearch } from "../loop-executor/agent-runner-internals.js";
import { registerToolHandler, type ToolHandlerContext } from "../loop-executor/tool-handlers.js";

registerToolHandler("internal.memory_search", async (ctx: ToolHandlerContext) => {
  const memoryConfig = readMemorySearchConfig(ctx.assignment.config, ctx.agent.task);
  const result = await recallMemories(memoryConfig.query, ctx.auth, memoryConfig.limit);
  return {
    text: [
      "Memory search results:",
      ...result.memories.map((memory) => `- [${memory.id}] ${memory.text}`),
    ].join("\n"),
    data: {
      query: memoryConfig.query,
      limit: memoryConfig.limit,
      sources: result.memories.map((memory) => ({
        id: memory.id,
        text: memory.text,
        score: memory.score,
        metadata: memory.metadata,
      })),
    },
  };
});

registerToolHandler("internal.web_search", async (ctx: ToolHandlerContext) => {
  const result = await runExaWebSearch({
    goal: ctx.goal,
    task: ctx.agent.task,
    config: ctx.assignment.config,
  });
  return {
    text: [`Web search results (${result.model}):`, result.text].join("\n"),
    data: { model: result.model, provider: result.provider, sources: result.sources },
    shortCircuit: true,
  };
});
