import type { AuthContext } from "../../domain/auth/index.js";
import type { AgentPersona, NoSlopSpec, NoSlopSpecAgent } from "../loop-engine/spec-contracts.js";
import { agentPersonaSchema } from "../loop-engine/spec-contracts.js";
import { allocateAgentAvatars, bindAgentAvatar } from "./agent-avatars.js";
import {
  displayNameFromSeed,
  inferActionLabelsFromToolRefs,
  resolveAgentRole,
  slugifyAgentId,
} from "./agent-personas.js";
import { reportLoopBuilderProgress } from "./progress.js";

function agentToolRefsForDisplay(agent: NoSlopSpecAgent): string[] {
  return agent.tools ?? [];
}

function personaFromAgent(agent: NoSlopSpecAgent, index: number): { agentId: string; persona: AgentPersona | undefined } {
  const agentId = slugifyAgentId(agent.name, index);
  const persona = agent.persona ? agentPersonaSchema.parse(agent.persona) : undefined;
  return { agentId, persona };
}

export async function enrichSpecAgentsWithPersonas(input: {
  auth: AuthContext;
  specId: string;
  specJson: NoSlopSpec;
  previousAgents?: NoSlopSpecAgent[];
}): Promise<NoSlopSpec> {
  const previousById = new Map<string, AgentPersona>();
  for (const [index, agent] of (input.previousAgents ?? []).entries()) {
    const { agentId, persona } = personaFromAgent(agent, index);
    if (persona) previousById.set(agentId, persona);
  }

  const enrichedAgents: NoSlopSpecAgent[] = [];
  const pendingNew: Array<{ index: number; agent: NoSlopSpecAgent; agentId: string }> = [];

  for (const [index, agent] of input.specJson.agents.entries()) {
    const agentId = slugifyAgentId(agent.name, index);
    const existingPersona = previousById.get(agentId);

    if (existingPersona) {
      enrichedAgents[index] = { ...agent, persona: existingPersona };
      reportLoopBuilderProgress({
        stage: "agent_spawn",
        message: `Spawning ${existingPersona.displayName} — ${existingPersona.roleLabel}`,
        status: "completed",
        details: {
          agentIndex: index,
          agentId,
          persona: existingPersona,
          inferredActions: inferActionLabelsFromToolRefs(agentToolRefsForDisplay(agent)),
        },
      });
      continue;
    }

    pendingNew.push({ index, agent, agentId });
  }

  if (pendingNew.length > 0) {
    const avatars = await allocateAgentAvatars(input.auth, pendingNew.length);
    await Promise.all(pendingNew.map(async ({ index, agent, agentId }, avatarIndex) => {
      const avatar = avatars[avatarIndex];
      if (!avatar) return;
      const role = resolveAgentRole(agent.name, agent.goal);
      const displayName = displayNameFromSeed(avatar.seed);
      const persona: AgentPersona = {
        displayName,
        roleKey: role.roleKey,
        roleLabel: role.roleLabel,
        avatarId: avatar.id,
        avatarSeed: avatar.seed,
      };

      await bindAgentAvatar(input.auth, avatar.id, { specId: input.specId, agentId });
      enrichedAgents[index] = { ...agent, persona };

      reportLoopBuilderProgress({
        stage: "agent_spawn",
        message: `Spawning ${displayName} — ${role.roleLabel}`,
        status: "completed",
        details: {
          agentIndex: index,
          agentId,
          persona,
          inferredActions: inferActionLabelsFromToolRefs(agentToolRefsForDisplay(agent)),
        },
      });
    }));
  }

  return {
    ...input.specJson,
    agents: input.specJson.agents.map((agent, index) => enrichedAgents[index] ?? agent),
  };
}
