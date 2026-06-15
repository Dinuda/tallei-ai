import { readMemorySearchConfig, runExaWebSearch } from "../loop-executor/agent-runner-internals.js";
import { registerToolHandler, type ToolHandlerContext } from "../loop-executor/tool-handlers.js";
import { getLoopTool } from "../loop-executor/tool-catalog.js";
import { runComposioToolkitPrompt } from "../connectors/composio.js";
import {
  selectedConnectorAccountId,
  selectedGroundingSources,
} from "../loop-engine/build-contract.js";
import { runGroundedKnowledgeSearch, type GroundingSource } from "../grounded-knowledge-search.js";
import { runCuratedMemorySearch } from "./curated-memory-search.js";

registerToolHandler("internal.workspace_memory_search", async (ctx: ToolHandlerContext) => {
  const sources: GroundingSource[] = [{ type: "workspace_memory" }];
  const result = await runGroundedKnowledgeSearch({
    auth: ctx.auth,
    goal: ctx.goal,
    sources,
    workflowId: ctx.workflowId,
  });
  return {
    text: result.sources.length > 0
      ? ["Workspace memory results:", ...result.sources.map((memory) => `- [${memory.id}] ${memory.text}`)].join("\n")
      : "No workspace memories found for this run intent.",
    data: { sources: result.sources },
  };
});

registerToolHandler("internal.knowledge_base_search", async (ctx: ToolHandlerContext) => {
  const groundingSources = selectedGroundingSources(ctx.definition?.buildContract);
  const kbSources = groundingSources.filter((source): source is Extract<GroundingSource, { type: "knowledge_base" }> => source.type === "knowledge_base");
  const result = await runGroundedKnowledgeSearch({
    auth: ctx.auth,
    goal: ctx.goal,
    sources: kbSources.length > 0 ? kbSources : [{ type: "tallei_memory" }, { type: "workspace_memory" }],
    workflowId: ctx.workflowId,
  });
  return {
    text: result.sources.length > 0
      ? ["Knowledge base results:", ...result.sources.map((memory) => `- [${memory.id}] ${memory.text}`)].join("\n")
      : "No knowledge base entries found for this run intent.",
    data: { sources: result.sources },
  };
});

registerToolHandler("internal.memory_search", async (ctx: ToolHandlerContext) => {
  const groundingSources = selectedGroundingSources(ctx.definition?.buildContract);
  if (groundingSources.length > 0) {
    const result = await runGroundedKnowledgeSearch({
      auth: ctx.auth,
      goal: ctx.goal,
      sources: groundingSources,
      workflowId: ctx.workflowId,
    });
    return {
      text: result.sources.length > 0
        ? ["Grounded knowledge results:", ...result.sources.map((memory) => `- [${memory.origin}:${memory.id}] ${memory.text}`)].join("\n")
        : "No grounded knowledge found for this run intent.",
      data: { sources: result.sources },
    };
  }

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

async function runConnectedAppSearch(ctx: ToolHandlerContext) {
  const entry = getLoopTool(ctx.assignment.ref);
  const dynamicToolkit = ctx.assignment.ref.match(/^composio\.([a-z0-9_-]+)\.search$/i)?.[1];
  const toolkit = entry?.toolkit ?? dynamicToolkit;
  if (!toolkit) throw new Error(`Tool ${ctx.assignment.ref} is not mapped to a Composio toolkit`);
  const configuredQuery = typeof ctx.assignment.config?.query === "string"
    ? ctx.assignment.config.query.trim()
    : "";
  const task = [
    configuredQuery || ctx.agent.task,
    "",
    `Loop goal: ${ctx.goal}`,
    ctx.workflowTitle ? `Workflow title: ${ctx.workflowTitle}` : "",
  ].filter(Boolean).join("\n");
  const result = await runComposioToolkitPrompt({
    auth: ctx.auth,
    toolkit,
    connectorAccountId: selectedConnectorAccountId(ctx.definition?.buildContract, toolkit),
    prompt: task,
  });
  return {
    text: [`Connected app results (${toolkit}):`, result.text].join("\n"),
    data: {
      provider: "composio",
      toolkit,
      connectorAccountId: result.accountId,
    },
    shortCircuit: true,
  };
}

registerToolHandler("composio.*.search", runConnectedAppSearch);

registerToolHandler("composio.*.action", async (ctx: ToolHandlerContext) => ({
  text: "Connector action prepared for runtime approval. The runtime will pause at a pre-send gate before executing this action.",
  data: {
    provider: "composio",
    toolRef: ctx.assignment.ref,
    requiresPreSendApproval: true,
  },
  shortCircuit: true,
}));
