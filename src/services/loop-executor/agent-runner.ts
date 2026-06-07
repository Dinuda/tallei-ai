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
import { loopExecutorOpenAiChat, loopExecutorOpenAiModel } from "./openai-chat.js";
import { completeText } from "./agent-runner-internals.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

import { extractMemorySources, formatMemorySearchText } from "../loop-engine/contracts.js";

import "./tool-handler-registrations.js";

export { readMemorySearchConfig, readGatewaySearchConfig, runExaWebSearch, completeText } from "./agent-runner-internals.js";

const APPROVAL_TOOL_REF = "internal.email_approval_request";

/** Run compose/render before approval so a render failure cannot block the approval request. */
function sortToolsForExecution(tools: LoopToolAssignment[]): LoopToolAssignment[] {
  return [...tools].sort((left, right) => {
    if (left.ref === APPROVAL_TOOL_REF) return 1;
    if (right.ref === APPROVAL_TOOL_REF) return -1;
    return 0;
  });
}

export type RunLoopAgentInput = {
  auth: AuthContext;
  goal: string;
  agent: LoopRunAgent;
  assignedTools: LoopToolAssignment[];
  draftPolicy: LoopDefinition["draftPolicy"];
  priorComments: Array<{ author: string; body: string; taskId?: string | null; createdAt?: string }>;
  runId?: string;
  workflowId?: string;
  workflowTitle?: string;
  definition?: LoopDefinition;
};

export type RunLoopAgentResult = {
  text: string;
  data: Record<string, unknown>;
  draft?: unknown;
  emailApprovalSent?: boolean;
  approvalRequest?: { to: string; approvalUrl: string; token: string; sentAt: string; channel?: string };
  artifactBody?: string;
  emailTemplate?: { html: string; text?: string; design?: unknown; subject?: string | null; updatedAt?: string; source?: string };
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
  let emailTemplate: RunLoopAgentResult["emailTemplate"];

  for (const assignment of sortToolsForExecution(input.assignedTools)) {
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
      if (result.emailTemplate) emailTemplate = result.emailTemplate;

      if (result.emailApprovalSent) {
        return {
          sections,
          draft,
          emailTemplate,
          toolsUsed,
          toolResults,
          emailApprovalSent: true,
          approvalRequest: result.approvalRequest!,
          artifactBody: result.artifactBody,
        };
      }

      if (result.shortCircuit) {
        return { sections, draft, emailTemplate, toolsUsed, toolResults, emailApprovalSent: false as const };
      }
      continue;
    }

    throw new Error(`No tool handler registered for actionable tool ${entry.ref}`);
  }

  return { sections, draft, emailTemplate, toolsUsed, toolResults, emailApprovalSent: false as const };
}

/** Runs one agent: optional tools, then LLM synthesis unless a tool short-circuits. */
export async function runLoopAgent(input: RunLoopAgentInput): Promise<RunLoopAgentResult> {
  const bindCtx = {
    auth: input.auth,
    goal: input.goal,
    agentName: input.agent.name,
    agentTask: input.agent.task,
    priorComments: input.priorComments.map((c) => ({ author: c.author, body: c.body })),
    draftPolicy: input.draftPolicy,
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
      return {
        text: toolRun.sections.join("\n\n"),
        data: {
          model: "exa-search",
          mode: "tool_output_only",
          toolRefs: input.assignedTools.map((t) => t.ref),
          actionableToolRefs: actionableToolRefs(input.assignedTools),
          toolsUsed,
          toolResults: toolRun.toolResults,
        },
        draft,
        emailTemplate: toolRun.emailTemplate,
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
        emailTemplate: toolRun.emailTemplate,
      };
    }

    if (toolRun.emailTemplate && !toolRun.emailApprovalSent) {
      const text = toolRun.sections.join("\n\n") || "Email build complete.";
      return {
        text,
        data: { model: loopExecutorOpenAiModel(), mode: "tool_assisted", toolsUsed, toolResults: toolRun.toolResults, emailBuilt: true },
        draft,
        emailTemplate: toolRun.emailTemplate,
      };
    }

    if (toolRun.emailApprovalSent) {
      return {
        text: toolRun.sections.join("\n\n") || "Approval request sent.",
        data: { model: loopExecutorOpenAiModel(), mode: "tool_assisted", toolsUsed, toolResults: toolRun.toolResults, emailApprovalSent: true },
        draft,
        emailApprovalSent: true,
        approvalRequest: toolRun.approvalRequest,
        artifactBody: toolRun.artifactBody,
        emailTemplate: toolRun.emailTemplate,
      };
    }
  }

  const text = await completeText({ system, user, maxTokens: 1800 });
  return {
    text,
    data: {
      model: loopExecutorOpenAiModel(),
      mode: hasOnlyLlmTools(input.assignedTools) ? "llm_only" : "tool_assisted",
      toolRefs: input.assignedTools.map((t) => t.ref),
      actionableToolRefs: actionableToolRefs(input.assignedTools),
      toolsUsed,
      llmInput: { system, user },
      llmOutput: text,
    },
    draft,
  };
}
