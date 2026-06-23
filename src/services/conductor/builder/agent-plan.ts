import type { NoSlopSpec, NoSlopSpecSnapshot } from "../contracts/spec-contracts.js";
import { slugifyAgentId } from "../services/personas/agent-personas.js";

export type AgentPlanStep = {
  index: number;
  id: string;
  name: string;
  goal: string;
  tools: string[];
  seesFrom: Array<{ agentId: string; paths: string[] }>;
};

export function formatAgentPlan(spec: Pick<NoSlopSpec, "agents" | "purpose">): {
  purpose: string;
  agentCount: number;
  steps: AgentPlanStep[];
} {
  return {
    purpose: spec.purpose,
    agentCount: spec.agents.length,
    steps: spec.agents.map((agent, index) => {
      const id = slugifyAgentId(agent.name, index);
      const seesFrom = (agent.handoffBindings ?? []).flatMap((binding) => {
        const agentId = binding.source.agentId?.trim();
        if (!agentId) return [];
        return [{ agentId, paths: [binding.source.path] }];
      });
      return {
        index: index + 1,
        id,
        name: agent.name,
        goal: agent.goal,
        tools: agent.tools ?? [],
        seesFrom,
      };
    }),
  };
}

export function formatAgentPlanFromSnapshot(snapshot: NoSlopSpecSnapshot): {
  title: string;
  preview: true;
  plan: ReturnType<typeof formatAgentPlan>;
  spec: NoSlopSpecSnapshot;
} {
  return {
    title: snapshot.title,
    preview: true,
    plan: formatAgentPlan(snapshot.specJson),
    spec: snapshot,
  };
}
