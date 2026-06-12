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
import { loopExecutorOpenAiChat } from "./openai-chat.js";
import { validateConnectorReadiness, containsUnresolvedTemplate } from "../tool-spec/action-readiness.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

import { extractMemorySources, extractWebSearchSources, formatMemorySearchText } from "../loop-engine/contracts.js";
import { isInputValidationAgent } from "../loop-runtime/memory.js";
import { contractUsesJson } from "../loop-engine/data-contract.js";

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
  structuredOutput?: Record<string, unknown>;
};

function usesTextOutput(agent: LoopRunAgent): boolean {
  return !contractUsesJson(agent.outputContract);
}

function asksForOperatorContent(text: string): boolean {
  return /\b(please (provide|paste|send|share)|need you to (provide|paste|send|share)|(cannot|can't) (continue|complete|draft|generate) (without|until)|required input (is )?missing)\b/i.test(text);
}

async function repairInternalInputRequest(input: { text: string; user: string }) {
  const response = await loopExecutorOpenAiChat({
    temperature: 0,
    maxTokens: 1800,
    messages: [
      {
        role: "system",
        content: [
          "You are a minimal output fixer for an internal workflow step.",
          "Rewrite the output so it completes the assigned task from available source context instead of asking the operator for input.",
          "Preserve supported facts and useful content. Omit unavailable material. Do not invent anything.",
          "Return only the repaired output, with no explanation.",
        ].join(" "),
      },
      {
        role: "user",
        content: [`Invalid output: ${input.text}`, "Source context:", input.user.slice(0, 20_000)].join("\n\n"),
      },
    ],
  });
  return { text: response.text.trim(), model: response.model, usage: response.usage };
}

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
    nodeKind: input.agent.nodeKind ?? "agent",
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

  if (!usesTextOutput(input.agent)) {
    const outputContract = input.agent.outputContract!;
    let candidate: Record<string, unknown> = {};
    let validation = { valid: false, errors: [] as Array<{ path: string; message: string; keyword: string }> };
    let model = "";
    let usage: unknown;
    const configuredReadiness = input.assignedTools[0]?.config?.readiness;
    const semanticAssertions = configuredReadiness && typeof configuredReadiness === "object" && !Array.isArray(configuredReadiness)
      && Array.isArray((configuredReadiness as { semanticAssertions?: unknown }).semanticAssertions)
      ? (configuredReadiness as { semanticAssertions: Array<{ kind: "at_least_one" | "non_placeholder"; paths: string[]; message: string }> }).semanticAssertions
      : [{
          kind: "non_placeholder" as const,
          paths: ["/"],
          message: "Structured output must not contain unresolved templates.",
        }];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await loopExecutorOpenAiChat({
        responseFormat: "json_object",
        temperature: 0,
        maxTokens: 4096,
        messages: [
          {
            role: "system",
            content: [
              system,
              "Return only one JSON object matching the mandatory output schema.",
              "Never emit unresolved templates, invented identifiers, recipients, files, or credentials.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              user,
              "",
              `Exact output schema: ${JSON.stringify(outputContract.schema)}`,
              `Stable connector configuration: ${JSON.stringify(input.assignedTools[0]?.config?.stableConfig ?? {})}`,
              attempt > 1 ? `Previous invalid output: ${JSON.stringify(candidate)}` : "",
              attempt > 1 ? `Validation errors: ${JSON.stringify(validation.errors)}` : "",
            ].filter(Boolean).join("\n"),
          },
        ],
      });
      model = response.model;
      usage = response.usage;
      try {
        const parsed = JSON.parse(response.text);
        candidate = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        candidate = {};
      }
      validation = validateConnectorReadiness({
        effectiveInputSchema: outputContract.schema,
        semanticAssertions,
      }, candidate);
      if (validation.valid && !containsUnresolvedTemplate(candidate)) {
        return {
          text: JSON.stringify(candidate, null, 2),
          structuredOutput: candidate,
          data: {
            model,
            mode: "structured_json",
            attempts: attempt,
            validation,
            toolRefs: input.assignedTools.map((tool) => tool.ref),
            usage,
          },
        };
      }
    }
    throw new Error(`Structured output failed validation: ${validation.errors.map((error) => `${error.path} ${error.message}`).join("; ")}`);
  }

  const llmResult = await completeText({ system, user, maxTokens: 1800 });
  let text = llmResult.text;
  let fixer: { model: string; usage: unknown } | null = null;
  if (!isInputValidationAgent(input.agent) && asksForOperatorContent(text)) {
    const repaired = await repairInternalInputRequest({ text, user });
    if (repaired.text) {
      text = repaired.text;
      fixer = { model: repaired.model, usage: repaired.usage };
    }
  }
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
      ...(fixer ? { fixerApplied: true, fixer } : {}),
    },
    draft,
  };
}
