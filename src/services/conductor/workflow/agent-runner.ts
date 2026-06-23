import type { AuthContext } from "../../../domain/auth/index.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";
import { getToolHandler, registerToolHandler } from "./tool-handlers.js";

type PriorComment = { author: string; body: string };

type RunLoopAgentInput = {
  auth: AuthContext;
  goal: string;
  agent: LoopRunAgent;
  assignedTools?: LoopToolAssignment[];
  draftPolicy?: unknown;
  priorComments?: PriorComment[];
  runId?: string;
  workflowId?: string;
  workflowTitle?: string;
  definition?: LoopDefinition;
};

type RunLoopAgentResult = {
  text: string;
  data: Record<string, unknown>;
};

function registerDefaultShortCircuitHandlers(): void {
  if (!getToolHandler("internal.memory_search")) {
    registerToolHandler("internal.memory_search", async () => ({
      text: "No validated memories found for this run intent.",
      data: { sources: [], confidence: "none" },
      shortCircuit: true,
    }));
  }
  if (!getToolHandler("internal.web_search")) {
    registerToolHandler("internal.web_search", async () => ({
      text: "No web sources found for this run intent.",
      data: { sources: [] },
      shortCircuit: true,
    }));
  }
}

registerDefaultShortCircuitHandlers();

function formatMemorySearchResult(data: Record<string, unknown>, fallbackText: string): string {
  const sources = Array.isArray(data.sources) ? data.sources : [];
  if (sources.length === 0) return fallbackText;
  const lines = sources.map((source) => {
    const row = source && typeof source === "object" && !Array.isArray(source)
      ? source as Record<string, unknown>
      : {};
    const id = typeof row.id === "string" ? row.id : "memory";
    const text = typeof row.text === "string"
      ? row.text
      : typeof row.snippet === "string"
        ? row.snippet
        : "";
    return `- [${id}] ${text}`.trim();
  });
  return `Found ${sources.length} validated memories (id + excerpt):\n${lines.join("\n")}`;
}

export async function runLoopAgent(input: RunLoopAgentInput): Promise<RunLoopAgentResult> {
  const assignedTools = input.assignedTools?.length ? input.assignedTools : input.agent.tools;
  const assignment = assignedTools[0];
  if (!assignment) {
    return {
      text: "No tool assignment available.",
      data: { mode: "no_tool" },
    };
  }

  const handler = getToolHandler(assignment.ref);
  if (!handler) {
    throw new Error(`No tool handler registered for ${assignment.ref}`);
  }

  const result = await handler({
    auth: input.auth,
    goal: input.goal,
    agent: input.agent,
    assignment,
    priorComments: input.priorComments ?? [],
    runId: input.runId,
    workflowId: input.workflowId,
    workflowTitle: input.workflowTitle,
    definition: input.definition,
  });

  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data
    : {};
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const text = assignment.ref === "internal.memory_search"
    ? formatMemorySearchResult(data, result.text)
    : result.text;

  if (result.shortCircuit || assignment.ref === "internal.memory_search" || assignment.ref === "internal.web_search") {
    return {
      text,
      data: {
        ...data,
        sources,
        mode: "tool_output_only",
      },
    };
  }

  return {
    text,
    data: {
      ...data,
      mode: "tool_output",
    },
  };
}
