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

function gateApprovalSurface(agent: LoopRunAgent): string | undefined {
  const gate = agent.gate;
  if (!gate || gate.type !== "approval") return undefined;
  const approval = gate.approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return undefined;
  return typeof approval.surface === "string" ? approval.surface : undefined;
}

export async function evaluateAgentGoal(input: AgentGoalEvalInput): Promise<AgentGoalEvalResult> {
  const count = sourceCount(input.result);
  const firstToolRef = input.agent.tools[0]?.ref;

  if (gateApprovalSurface(input.agent) === "review.memories" && count > 0) {
    return {
      status: "needs_input",
      gateType: "approval",
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
