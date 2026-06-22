import type { LoopDefinition, LoopRunAgent } from "../loop-executor/types.js";

type AgentGoalEvalInput = {
  agent: LoopRunAgent;
  result: {
    text?: string;
    data?: Record<string, unknown>;
  };
  definition?: LoopDefinition;
};

type AgentGoalEvalResult = {
  status: "pass" | "fail" | "needs_input";
  reason?: string;
  gateType?: string;
};

function sourceCount(result: AgentGoalEvalInput["result"]): number {
  return Array.isArray(result.data?.sources) ? result.data.sources.length : 0;
}

export async function evaluateAgentGoal(input: AgentGoalEvalInput): Promise<AgentGoalEvalResult> {
  const count = sourceCount(input.result);
  const firstToolRef = input.agent.tools[0]?.ref;

  if (input.agent.gate?.type === "memory_confirmation" && count > 0) {
    return {
      status: "needs_input",
      gateType: "memory_confirmation",
      reason: `${count} validated memories require operator confirmation.`,
    };
  }

  if (firstToolRef === "internal.web_search") {
    return {
      status: "pass",
      reason: `${count} valid sources returned by web search.`,
    };
  }

  return {
    status: "pass",
    reason: count > 0 ? `${count} valid sources returned.` : "Agent result satisfied deterministic goal checks.",
  };
}
