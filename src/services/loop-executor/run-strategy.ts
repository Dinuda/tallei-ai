/**
 * run-strategy.ts — CEO strategy generation and task materialization.
 */

import { randomUUID } from "crypto";
import { pool } from "../../infrastructure/db/index.js";
import { listPreferences, recallMemories } from "../memory.js";
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

function isNewsletterDeliveryDefinition(definition: LoopDefinition): boolean {
  return definition.deliveryType?.trim().toLowerCase() === "newsletter"
    || definition.presetId === "newsletter"
    || definition.presetId === "newsletter_v1";
}

function normalizeOneResponsibilityAgent(agent: LoopRunAgent, definition: LoopDefinition): LoopRunAgent {
  const refs = agent.tools.map((tool) => tool.ref.trim().toLowerCase());
  const key = `${agent.id} ${agent.name} ${agent.task}`.toLowerCase();
  const roleKey = `${agent.id} ${agent.name}`.toLowerCase();
  const isApprovalEmailBuild = refs.includes("internal.email_approval_request")
    || refs.includes("internal.email_builder_compose")
    || refs.includes("internal.email_builder_render")
    || roleKey.includes("approval");
  const isBroadcastDelivery = isNewsletterDeliveryDefinition(definition)
    && (refs.includes("internal.resend_broadcast") || key.includes("broadcast") || key.includes("delivery"));
  const isWriter = isNewsletterDeliveryDefinition(definition)
    && (key.includes("writer") || key.includes("write") || key.includes("draft"));

  if (isApprovalEmailBuild) {
    return {
      ...agent,
      name: "Approval & Email Build Agent",
      task: [
        "Review the producer's final draft, ask the operator any approval questions, compose/render the email, and send the approval email only.",
        "Do not sync recipients, upload contacts, submit a Resend broadcast, or describe broadcast delivery as your responsibility.",
      ].join(" "),
      tools: agent.tools.filter((tool) => [
        "internal.email_approval_request",
        "internal.email_builder_compose",
        "internal.email_builder_render",
      ].includes(tool.ref)),
    };
  }

  if (isBroadcastDelivery) {
    return {
      ...agent,
      name: "Broadcast Delivery Agent",
      task: [
        "After operator approval and recipient upload, sync contacts and submit the approved Resend broadcast only.",
        "Do not write, edit, build the approval email, ask approval questions, or send the approval email.",
      ].join(" "),
      tools: agent.tools.filter((tool) => tool.ref !== "internal.email_approval_request"
        && tool.ref !== "internal.email_builder_compose"
        && tool.ref !== "internal.email_builder_render"),
    };
  }

  if (isWriter) {
    return {
      ...agent,
      name: /newsletter/i.test(agent.name) ? agent.name : "Newsletter Writer",
      task: [
        "Write one subscriber-ready newsletter draft only, grounded in prior research and verified facts.",
        "Do not ask approval questions, prepare email builder output, upload contacts, or send/broadcast anything.",
      ].join(" "),
    };
  }

  return agent;
}

function normalizeOneResponsibilityRoster(agents: LoopRunAgent[], definition: LoopDefinition): LoopRunAgent[] {
  const normalized = agents.map((agent) => normalizeOneResponsibilityAgent(agent, definition));
  const hasBroadcastDelivery = normalized.some((agent) => {
    const refs = agent.tools.map((tool) => tool.ref.trim().toLowerCase());
    const roleKey = `${agent.id} ${agent.name}`.toLowerCase();
    return refs.includes("internal.resend_broadcast") || roleKey.includes("broadcast") || roleKey.includes("delivery");
  });
  if (isNewsletterDeliveryDefinition(definition) && !hasBroadcastDelivery) {
    normalized.push({
      id: "broadcast_delivery",
      name: "Broadcast Delivery Agent",
      task: [
        "After operator approval and recipient upload, sync contacts and submit the approved Resend broadcast only.",
        "Do not write, edit, build the approval email, ask approval questions, or send the approval email.",
      ].join(" "),
      tools: [{ ref: "internal.resend_broadcast" }],
    });
  }
  return normalizeRosterAgents(normalized);
}

function rosterFromAgentGraph(definition: LoopDefinition): { strategyText: string; agents: LoopRunAgent[] } {
  const agents = normalizeOneResponsibilityRoster(
    (definition.agentGraph?.children ?? []).map((child) => ({
      id: child.id,
      name: child.name,
      task: child.task,
      tools: child.tools,
    })),
    definition
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

  const auth = { tenantId: context.tenantId, userId: context.userId, authMode: "internal" as const, plan: "pro" as const };
  const [memoryResult, preferences] = await Promise.all([
    recallMemories(context.definition.goal, auth, 8).catch(() => ({ memories: [] })),
    listPreferences(auth).catch(() => []),
  ]);
  const memoryBlock = (memoryResult.memories ?? []).length > 0
    ? (memoryResult.memories ?? []).map((memory, index) => `${index + 1}. ${memory.text}`).join("\n")
    : "No relevant memories.";
  const preferenceBlock = preferences.length > 0
    ? preferences.slice(0, 6).map((pref, index) => `${index + 1}. ${pref.text}`).join("\n")
    : "No saved preferences.";

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
          "Each child agent must do exactly one thing. Do not combine writer, approval/email build, and broadcast delivery responsibilities.",
          "If a subscriber broadcast is needed: writer writes only; Approval & Email Build Agent uses email approval/build tools and does not broadcast; Broadcast Delivery Agent only handles post-approval recipient sync and broadcast delivery.",
          'Return JSON only: {"strategyText":"...","agents":[{"id":"snake_case","name":"Role","task":"...","tools":[{"ref":"internal.llm_only"}]}]}',
          "Allowed tool catalog:",
          catalogSummary,
          `Allowed integrations: ${constraints.allowedIntegrations.join(", ")}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Loop goal: ${context.definition.goal}`,
          `CEO policy: ${context.definition.ceo.policy}`,
          `User memories:\n${memoryBlock}`,
          `User preferences:\n${preferenceBlock}`,
        ].join("\n\n"),
      },
    ],
  });

  const parsed = ceoStrategyOutputSchema.parse(JSON.parse(response.text));
  return {
    strategyText: parsed.strategyText.trim(),
    agents: normalizeOneResponsibilityRoster(parsed.agents, context.definition),
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
