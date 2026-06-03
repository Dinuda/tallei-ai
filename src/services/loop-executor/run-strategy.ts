import { randomUUID } from "crypto";

import { pool } from "../../infrastructure/db/index.js";
import { loopExecutorOpenAiChat } from "./openai-chat.js";
import {
  dynamicPlanRoster,
  executableStageToAgent,
  isDynamicPlanDefinition,
  normalizeRosterAgents,
  planStrategyText,
} from "./plan.js";
import type { LoopRunContext } from "./run-context.js";
import { getEffectiveLoopConstraints, listAllowedLoopTools } from "./tool-catalog.js";
import { ceoStrategyOutputSchema, type LoopPlan, type LoopRunAgent } from "./types.js";

const NEWSLETTER_MEMORY_RECORDS = [
  {
    id: "newsletter-memory-2026-05-26",
    title: "Essential books for product builders",
    summary: "Timeless reading recommendations across writing, execution, strategy, leadership, product craft, and distribution.",
  },
  {
    id: "newsletter-memory-2026-05-25",
    title: "How I AI weekly roundup",
    summary: "Felix Rieseberg's Claude workflows and Google I/O 2026 launch analysis with practical implications for builders.",
  },
];

function buildLegacyNewsletterPresetRoster(goal: string) {
  const memoryContext = NEWSLETTER_MEMORY_RECORDS
    .map((record, index) => `${index + 1}. ${record.title}: ${record.summary}`)
    .join("\n");
  return {
    strategyText: [
      "CEO strategy: run a fixed weekly newsletter pipeline for Lenny.",
      "Order: Search Agent -> Web Search Agent -> Research Agent -> Writer -> Publicist.",
      "Pinned memory records to ground this run:",
      memoryContext,
      "Outcome requirement: final output must include a publish-ready draft, an operator approval email, contact list upload, and a Resend broadcast to subscribers.",
    ].join("\n"),
    agents: normalizeRosterAgents([
      {
        id: "search_agent",
        name: "Search Agent",
        task: [
          "Find timely themes for this week's newsletter and surface high-signal internal source material.",
          "Start from pinned memory records, then identify angles worth expanding this week.",
          "Output: ranked topic candidates with source notes and why each matters now.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.memory_search" }],
      },
      {
        id: "web_search_agent",
        name: "Web Search Agent",
        task: [
          "Run live web search for this week's priority themes and gather source-grounded evidence.",
          "Focus on recent, credible, high-signal updates that strengthen the newsletter's arguments.",
          "Output: concise findings with URLs and recommended narrative angles for research and writing.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.web_search", config: { searchContextSize: "high", country: "US" } }],
      },
      {
        id: "research_agent",
        name: "Research Agent",
        task: [
          "Take Search Agent and Web Search Agent outputs and produce concise research notes for the top topics.",
          "Highlight insights, risks, contrarian takes, and references worth citing in the newsletter.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.llm_only" }],
      },
      {
        id: "writer",
        name: "Writer",
        task: [
          "Write the full newsletter draft in Lenny's practical voice using search and research outputs.",
          "Keep structure scannable, specific, and useful for product builders.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.llm_only" }],
      },
      {
        id: "publicist",
        name: "Publicist",
        task: [
          "Send the final newsletter draft to the operator via the email adapter for approval.",
          "After approval, the operator uploads a contact list and the distribution runner sends a Resend broadcast to that segment.",
          "Do not send to the list until the broadcast is created.",
          `Goal: ${goal}`,
        ].join(" "),
        tools: [{ ref: "internal.email_approval_request" }],
      },
    ]),
  };
}

export async function buildCeoStrategyOutput(context: LoopRunContext) {
  if (isDynamicPlanDefinition(context.definition)) {
    return {
      strategyText: planStrategyText(context.definition.plan!),
      agents: dynamicPlanRoster(context.definition.plan!),
    };
  }
  if (context.definition.template?.id === "newsletter_v1") {
    return buildLegacyNewsletterPresetRoster(context.definition.goal);
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
          "Your job is to spawn the smallest useful roster of child agents for this run, not to do their work yourself.",
          "Create child agents dynamically from the loop goal, available tools, and constraints. Do not use fixed default roles unless the goal actually requires them.",
          "Each child agent must have one clear responsibility, a concrete task, and only the tools it needs.",
          "If the work needs user/project context, spawn an agent with a memory/search tool when available. Do not assume user-specific facts are known.",
          "If the work needs current or external information, spawn a research/search-capable agent when available. Do not invent current facts.",
          "If the work needs an external app action, spawn a specialist that prepares a draft or approval-gated payload. Do not claim the action was completed.",
          "Integration capability rule: only rely on the tool refs in the allowed catalog. Do not infer that a brand/toolkit supports actions not listed here.",
          "Approval rule: any send, publish, post, calendar mutation, or external side effect must be represented as a draft or approval-gated step.",
          "Dependency rule: if a required capability is missing from the catalog, say so in strategyText and spawn only agents that can safely prepare or research the work.",
          'Return JSON only: {"strategyText":"...","agents":[{"id":"snake_case","name":"Role Name","task":"specific task","tools":[{"ref":"internal.llm_only"}]}]}',
          "Allowed tool catalog:",
          catalogSummary,
          `Allowed integrations: ${constraints.allowedIntegrations.join(", ")}`,
          "Only assign tool refs listed above. Do not invent tool names.",
          "Prefer 1-4 agents. Use more only when dependencies or independent workstreams justify it.",
          "Order agents by execution dependency. Put approval/draft handoff agents after the agents that produce the content they need.",
          "strategyText must explain: why these agents were spawned, what each one depends on, where approval is required, and any missing capabilities.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Loop goal: ${context.definition.goal}`,
          `CEO policy: ${context.definition.ceo.policy}`,
        ].join("\n"),
      },
    ],
  });
  const parsed = ceoStrategyOutputSchema.parse(JSON.parse(response.text));
  return {
    strategyText: parsed.strategyText.trim(),
    agents: normalizeRosterAgents(parsed.agents),
  };
}

export async function materializeTasksFromPlan(input: {
  context: LoopRunContext;
  plan: LoopPlan;
  strategyOutput: string;
}) {
  for (const [seq, stage] of input.plan.stages.entries()) {
    if (stage.kind !== "agent" && stage.kind !== "external_action") continue;
    const agent = executableStageToAgent(stage);
    await pool.query(
      `INSERT INTO loop_run_tasks
       (id, tenant_id, user_id, workflow_run_id, seq, agent_id, agent_name, tool_key, agent_spec, assigned_tools, status, input_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'todo', $11::jsonb)
       ON CONFLICT (tenant_id, user_id, workflow_run_id, seq) DO UPDATE
         SET agent_id = EXCLUDED.agent_id,
             agent_name = EXCLUDED.agent_name,
             tool_key = EXCLUDED.tool_key,
             agent_spec = EXCLUDED.agent_spec,
             assigned_tools = EXCLUDED.assigned_tools,
             input_json = EXCLUDED.input_json,
             updated_at = NOW()`,
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
         SET agent_id = EXCLUDED.agent_id,
             agent_name = EXCLUDED.agent_name,
             tool_key = EXCLUDED.tool_key,
             agent_spec = EXCLUDED.agent_spec,
             assigned_tools = EXCLUDED.assigned_tools,
             input_json = EXCLUDED.input_json,
             updated_at = NOW()`,
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
