/**
 * agent-runner.ts — Executes a single loop agent task (tools + LLM).
 *
 * Tool execution dispatches through the tool handler registry.
 */

import type { AuthContext } from "../../domain/auth/index.js";
import {
  actionableToolRefs,
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  getLoopTool,
  hasOnlyLlmTools,
} from "./tool-catalog.js";
import { getToolHandler, type ToolHandlerContext } from "./tool-handlers.js";
import { completeText } from "./agent-runner-internals.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

import { extractMemorySources, extractWebSearchSources, formatMemorySearchText } from "../loop-engine/contracts.js";
import { unwrapEmailMarkdownEnvelope } from "../loop-engine/email-output.js";

import "../loop-runtime/tool-registrations.js";

export { readMemorySearchConfig, readGatewaySearchConfig, runExaWebSearch, completeText } from "./agent-runner-internals.js";

export type RunLoopAgentInput = {
  auth: AuthContext;
  goal: string;
  agent: LoopRunAgent;
  assignedTools: LoopToolAssignment[];
  draftPolicy: LoopDefinition["draftPolicy"];
  priorComments: Array<{ author: string; body: string; taskId?: string | null; createdAt?: string }>;
  agentHandoff?: Record<string, unknown>;
  runId?: string;
  workflowId?: string;
  workflowTitle?: string;
  definition?: LoopDefinition;
};

export type RunLoopAgentResult = {
  text: string;
  data: Record<string, unknown>;
  draft?: unknown;
};

function buildHandlerCtx(input: RunLoopAgentInput, assignment: LoopToolAssignment): ToolHandlerContext {
  return {
    auth: input.auth,
    goal: input.goal,
    agent: input.agent,
    assignment,
    priorComments: input.priorComments.map((c) => ({ author: c.author, body: c.body })),
    runId: input.runId,
    workflowId: input.workflowId,
    workflowTitle: input.workflowTitle,
    definition: input.definition,
  };
}

async function runAssignedTools(input: RunLoopAgentInput) {
  const sections: string[] = [];
  const toolsUsed: string[] = [];
  const toolResults: Array<{
    ref: string;
    text: string;
    data?: Record<string, unknown>;
    shortCircuit?: boolean;
  }> = [];
  let draft: unknown;

  for (const assignment of input.assignedTools) {
    const entry = getLoopTool(assignment.ref);
    if (!entry?.isActionable || entry.ref === "internal.llm_only") continue;

    const handler = getToolHandler(assignment.ref);
    if (handler) {
      const ctx = buildHandlerCtx(input, assignment);
      const result = await handler(ctx);
      toolsUsed.push(entry.ref);
      if (result.text) sections.push(result.text);
      toolResults.push({
        ref: entry.ref,
        text: result.text,
        ...(result.data ? { data: result.data } : {}),
        ...(result.shortCircuit ? { shortCircuit: true } : {}),
      });
      if (result.draft) draft = result.draft;
      if (result.shortCircuit) {
        return { sections, draft, toolsUsed, toolResults, shortCircuit: true };
      }
      continue;
    }

    throw new Error(`No tool handler registered for actionable tool ${entry.ref}`);
  }

  return { sections, draft, toolsUsed, toolResults, shortCircuit: false };
}

/** Runs one agent: optional tools, then LLM synthesis unless a tool short-circuits. */
export async function runLoopAgent(input: RunLoopAgentInput): Promise<RunLoopAgentResult> {
  const bindCtx = {
    auth: input.auth,
    goal: input.goal,
    agentName: input.agent.name,
    agentTask: input.agent.task,
    priorComments: input.priorComments.map((c) => ({ author: c.author, body: c.body })),
    agentHandoff: input.agentHandoff,
    draftPolicy: input.draftPolicy,
    outputContract: input.agent.outputContract,
    doneCriteria: input.agent.doneCriteria,
    renderTarget: input.agent.renderTarget,
  };
  const system = buildAgentSystemPrompt(bindCtx);
  let user = buildAgentUserPrompt(bindCtx);
  let draft: unknown;
  let toolsUsed: string[] = [];

  if (!hasOnlyLlmTools(input.assignedTools)) {
    const toolRun = await runAssignedTools(input);
    toolsUsed = toolRun.toolsUsed;
    draft = toolRun.draft;
    if (toolRun.sections.length > 0) user = [user, "", ...toolRun.sections].join("\n");

    if (toolRun.toolsUsed.includes("internal.web_search")) {
      const webSearchTool = toolRun.toolResults.find((row) => row.ref === "internal.web_search");
      const sources = extractWebSearchSources(webSearchTool?.data ?? { sources: [] });
      const toolData = webSearchTool?.data && typeof webSearchTool.data === "object"
        ? webSearchTool.data as Record<string, unknown>
        : {};
      return {
        text: toolRun.sections.join("\n\n"),
        data: {
          model: typeof toolData.model === "string" ? toolData.model : "exa-search",
          ...(typeof toolData.provider === "string" ? { provider: toolData.provider } : {}),
          mode: "tool_output_only",
          sources,
          toolRefs: input.assignedTools.map((t) => t.ref),
          actionableToolRefs: actionableToolRefs(input.assignedTools),
          toolsUsed,
          toolResults: toolRun.toolResults,
        },
        draft,
      };
    }

    if (toolRun.toolsUsed.includes("internal.memory_search")) {
      const memoryTool = toolRun.toolResults.find((row) => row.ref === "internal.memory_search");
      const sources = extractMemorySources(memoryTool?.data ?? { sources: [] });
      const text = formatMemorySearchText(sources);
      return {
        text,
        data: {
          mode: "tool_output_only",
          sources,
          toolRefs: input.assignedTools.map((t) => t.ref),
          actionableToolRefs: actionableToolRefs(input.assignedTools),
          toolsUsed,
          toolResults: toolRun.toolResults,
        },
        draft,
      };
    }

    if (toolRun.shortCircuit) {
      return {
        text: toolRun.sections.join("\n\n"),
        data: {
          mode: "tool_output_only",
          toolRefs: input.assignedTools.map((t) => t.ref),
          actionableToolRefs: actionableToolRefs(input.assignedTools),
          toolsUsed,
          toolResults: toolRun.toolResults,
        },
        draft,
      };
    }
  }

  const llmResult = await completeText({ system, user, maxTokens: 1800 });
  const text = input.agent.renderTarget === "canvas.email" || input.agent.renderTarget === "canvas.preview"
    ? unwrapEmailMarkdownEnvelope(llmResult.text)
    : llmResult.text;
  return {
    text,
    data: {
      model: llmResult.model,
      mode: hasOnlyLlmTools(input.assignedTools) ? "llm_only" : "tool_assisted",
      toolRefs: input.assignedTools.map((t) => t.ref),
      actionableToolRefs: actionableToolRefs(input.assignedTools),
      toolsUsed,
      usage: llmResult.usage,
      llmInput: { system, user },
      llmOutput: text,
    },
    draft,
  };
}
