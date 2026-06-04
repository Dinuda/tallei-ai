/**
 * run-strategy.ts — CEO strategy generation and task materialization.
 */

import { randomUUID } from "crypto";
import { pool } from "../../infrastructure/db/index.js";
import { loopExecutorOpenAiChat } from "./openai-chat.js";
import { resolveLoopPreset } from "./presets/registry.js";
import {
  dynamicPlanRoster,
  isDynamicPlanDefinition,
  normalizeRosterAgents,
  planStrategyText,
} from "./plan.js";
import type { LoopRunContext } from "./run-context.js";
import { getEffectiveLoopConstraints, listAllowedLoopTools } from "./tool-catalog.js";
import { ceoStrategyOutputSchema, type LoopDefinition, type LoopPlan, type LoopRunAgent } from "./types.js";

function rosterFromAgentGraph(definition: LoopDefinition): { strategyText: string; agents: LoopRunAgent[] } {
  const agents = normalizeRosterAgents(
    (definition.agentGraph?.children ?? []).map((child) => ({
      id: child.id,
      name: child.name,
      task: child.task,
      tools: child.tools,
    }))
  );
  return {
    strategyText: [
      "Using the loop's configured agent roster (no re-planning).",
      `Goal: ${definition.goal}`,
      ...agents.map((agent, index) => `${index + 1}. ${agent.name} — ${agent.task}`),
    ].join("\n"),
    agents,
  };
}

/**
 * Builds CEO strategy text and proposed agent roster for a run.
 * Prefers stored agent graph, then preset, then plan stages, then LLM.
 */
export async function buildCeoStrategyOutput(context: LoopRunContext) {
  if (context.definition.agentGraph?.children?.length) {
    return rosterFromAgentGraph(context.definition);
  }

  const preset = resolveLoopPreset(context.definition);
  if (preset) {
    return preset.buildRoster(context.definition.goal);
  }

  if (isDynamicPlanDefinition(context.definition)) {
    return {
      strategyText: planStrategyText(context.definition.plan!),
      agents: dynamicPlanRoster(context.definition.plan!),
    };
  }

  const constraints = getEffectiveLoopConstraints(context.definition);
  const allowedTools = listAllowedLoopTools(context.definition);
  const catalogSummary = allowedTools
    .map((tool) => `- ${tool.ref}: ${tool.description}${tool.requiresConnector ? " (requires connector)" : ""}`)
    .join("\n");

  const response = await loopExecutorOpenAiChat({
    responseFormat: "json_object",
    temperature: 0.2,
    maxTokens: 2200,
    messages: [
      {
        role: "system",
        content: [
          "You are the Parent Agent / CEO coordinator for a recurring multi-agent loop.",
          "Spawn the smallest useful roster of child agents for this run.",
          'Return JSON only: {"strategyText":"...","agents":[{"id":"snake_case","name":"Role","task":"...","tools":[{"ref":"internal.llm_only"}]}]}',
          "Allowed tool catalog:",
          catalogSummary,
          `Allowed integrations: ${constraints.allowedIntegrations.join(", ")}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: [`Loop goal: ${context.definition.goal}`, `CEO policy: ${context.definition.ceo.policy}`].join("\n"),
      },
    ],
  });

  const parsed = ceoStrategyOutputSchema.parse(JSON.parse(response.text));
  return {
    strategyText: parsed.strategyText.trim(),
    agents: normalizeRosterAgents(parsed.agents),
  };
}

/** Inserts loop_run_tasks from an approved plan's agent/external_action stages. */
export async function materializeTasksFromPlan(input: {
  context: LoopRunContext;
  plan: LoopPlan;
  strategyOutput: string;
}) {
  for (const [seq, stage] of input.plan.stages.entries()) {
    if (stage.kind !== "agent" && stage.kind !== "external_action") continue;
    const agent = stage.kind === "agent"
      ? { id: stage.id, name: stage.name, task: stage.task, tools: stage.toolRef ? [{ ref: stage.toolRef }] : [] }
      : { id: stage.id, name: stage.label, task: `Execute external action: ${stage.label}`, tools: [{ ref: stage.toolRef }] };
    await pool.query(
      `INSERT INTO loop_run_tasks
       (id, tenant_id, user_id, workflow_run_id, seq, agent_id, agent_name, tool_key, agent_spec, assigned_tools, status, input_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'todo', $11::jsonb)
       ON CONFLICT (tenant_id, user_id, workflow_run_id, seq) DO UPDATE
         SET agent_id = EXCLUDED.agent_id, agent_name = EXCLUDED.agent_name, tool_key = EXCLUDED.tool_key,
             agent_spec = EXCLUDED.agent_spec, assigned_tools = EXCLUDED.assigned_tools,
             input_json = EXCLUDED.input_json, updated_at = NOW()`,
      [
        randomUUID(),
        input.context.tenantId,
        input.context.userId,
        input.context.runId,
        seq,
        agent.id,
        agent.name,
        agent.tools[0]?.ref ?? "internal.llm_only",
        JSON.stringify(agent),
        JSON.stringify(agent.tools),
        JSON.stringify({ agent, stage, strategyOutput: input.strategyOutput }),
      ]
    );
  }
}

/** Inserts loop_run_tasks from an approved dynamic roster. */
export async function materializeTasksFromRoster(input: {
  context: LoopRunContext;
  roster: LoopRunAgent[];
  strategyOutput: string;
}) {
  for (const [seq, agent] of input.roster.entries()) {
    await pool.query(
      `INSERT INTO loop_run_tasks
       (id, tenant_id, user_id, workflow_run_id, seq, agent_id, agent_name, tool_key, agent_spec, assigned_tools, status, input_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'todo', $11::jsonb)
       ON CONFLICT (tenant_id, user_id, workflow_run_id, seq) DO UPDATE
         SET agent_id = EXCLUDED.agent_id, agent_name = EXCLUDED.agent_name, tool_key = EXCLUDED.tool_key,
             agent_spec = EXCLUDED.agent_spec, assigned_tools = EXCLUDED.assigned_tools,
             input_json = EXCLUDED.input_json, updated_at = NOW()`,
      [
        randomUUID(),
        input.context.tenantId,
        input.context.userId,
        input.context.runId,
        seq,
        agent.id,
        agent.name,
        agent.tools[0]?.ref ?? "internal.llm_only",
        JSON.stringify(agent),
        JSON.stringify(agent.tools),
        JSON.stringify({ agent, strategyOutput: input.strategyOutput }),
      ]
    );
  }
}
