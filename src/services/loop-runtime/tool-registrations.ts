import { readMemorySearchConfig, runExaWebSearch } from "../loop-executor/agent-runner-internals.js";
import { registerToolHandler, type ToolHandlerContext } from "../loop-executor/tool-handlers.js";
import { runCuratedMemorySearch } from "./curated-memory-search.js";

registerToolHandler("internal.memory_search", async (ctx: ToolHandlerContext) => {
  const memoryConfig = readMemorySearchConfig(ctx.assignment.config, ctx.agent.task);
  const result = await runCuratedMemorySearch({
    auth: ctx.auth,
    goal: ctx.goal,
    agent: ctx.agent,
    configuredQuery: memoryConfig.query,
    workflowTitle: ctx.workflowTitle,
    priorComments: ctx.priorComments,
  });
  return {
    text: result.sources.length > 0
      ? [
        "Validated memory search results:",
        ...result.sources.map((memory) => `- [${memory.id}] ${memory.text}`),
      ].join("\n")
      : "No validated memories found for this run intent.",
    data: {
      query: memoryConfig.query,
      limit: memoryConfig.limit,
      queryPlan: result.queryPlan,
      confidence: result.confidence,
      rejectedCount: result.rejectedCount,
      noEvidenceReason: result.noEvidenceReason,
      usage: result.usage,
      trace: result.trace,
      sources: result.sources.map((memory) => ({
        id: memory.id,
        text: memory.text,
        score: memory.score,
        confidence: memory.confidence,
        reason: memory.reason,
        evidenceRole: memory.evidenceRole,
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
