/**
 * contracts.ts — Typed contracts, validation, and helpers for the agentic loop engine.
 */

import { z } from "zod";

import {
  LOOP_ENGINE_VERSION,
  loopAgentGraphChildSchema,
  loopAgentGraphSchema,
  loopDeliveryRoutingSchema,
  loopDeliveryTargetSchema,
  loopGateTypeSchema,
  type LoopDefinition,
  type LoopDeliveryTarget,
} from "../loop-executor/types.js";

export const ENGINE_MAX_AGENTS = 8;
export const ENGINE_MAX_CRITIC_RETRIES = 2;
export const ENGINE_MAX_AGENT_RETRIES = 2;
export const DESIGNER_MEMORY_MIN_SCORE = 0.35;
export const DESIGNER_MEMORY_TOP_K = 8;

/** Valid delivery provider for each target. */
export const DELIVERY_PROVIDER_BY_TARGET: Record<LoopDeliveryTarget, string[]> = {
  subscriber_list: ["internal.resend_broadcast"],
  team_email: ["composio.gmail.send_email"],
  operator: ["internal.email_approval_request"],
  none: [],
};

export const loopArchitectAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().min(1),
  task: z.string().min(1),
  tool: z.string().min(1),
  inputContract: z.object({
    description: z.string().min(1),
    schema: z.record(z.unknown()).default({}),
  }),
  outputContract: z.object({
    description: z.string().min(1),
    schema: z.record(z.unknown()).default({}),
  }),
  doneCriteria: z.array(z.string().min(1)).min(1).max(3),
  gate: z.object({
    type: loopGateTypeSchema,
    question: z.string().min(1),
  }).optional(),
});

export const loopArchitectOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  strategyText: z.string().min(1),
  inputsRequired: z.array(z.string().min(1)).default([]),
  delivery: loopDeliveryRoutingSchema,
  schedule: z.object({
    cron: z.string().min(1),
    timezone: z.string().min(1).default("UTC"),
  }),
  agents: z.array(loopArchitectAgentSchema).min(2).max(ENGINE_MAX_AGENTS),
  rationale: z.array(z.string().min(1)).default([]),
  suggestedChannels: z.array(z.string().min(1)).default(["primary"]),
});

export type LoopArchitectOutput = z.infer<typeof loopArchitectOutputSchema>;
export type LoopArchitectAgent = z.infer<typeof loopArchitectAgentSchema>;

export const workflowCriticResultSchema = z.object({
  pass: z.boolean(),
  riskLevel: z.enum(["low", "medium", "high"]),
  issues: z.array(z.string()).default([]),
  requiredFixes: z.array(z.string()).default([]),
});

export type WorkflowCriticResult = z.infer<typeof workflowCriticResultSchema>;

export const goalEvalStatusSchema = z.enum(["pass", "fail", "needs_input"]);
export type GoalEvalStatus = z.infer<typeof goalEvalStatusSchema>;

export const goalEvalResultSchema = z.object({
  status: goalEvalStatusSchema,
  reason: z.string().min(1),
  blockers: z.array(z.string()).default([]),
  gateType: loopGateTypeSchema.optional(),
});

export type GoalEvalResult = z.infer<typeof goalEvalResultSchema>;

export function isEngineV3Definition(definition: LoopDefinition): boolean {
  return definition.engineVersion === LOOP_ENGINE_VERSION
    || definition.builderMeta?.engineVersion === LOOP_ENGINE_VERSION;
}

export function deliveryProviderMatchesTarget(provider: string, target: LoopDeliveryTarget): boolean {
  const allowed = DELIVERY_PROVIDER_BY_TARGET[target];
  if (target === "none") return true;
  return allowed.includes(provider.trim().toLowerCase());
}

export function assertDeliveryRouting(delivery: z.infer<typeof loopDeliveryRoutingSchema>): void {
  const provider = delivery.provider.trim().toLowerCase();
  const target = delivery.target;
  if (target === "none") return;
  if (!deliveryProviderMatchesTarget(provider, target)) {
    throw new Error(
      `Delivery routing error: target "${target}" requires one of [${DELIVERY_PROVIDER_BY_TARGET[target].join(", ")}], got "${provider}"`,
    );
  }
}

function slugArtifactId(agentId: string): string {
  return `${agentId.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 40) || "agent"}_output`;
}

export function architectOutputToAgentGraph(output: LoopArchitectOutput): z.infer<typeof loopAgentGraphSchema> {
  const goal = output.strategyText.split("\n")[0] ?? output.summary;
  return loopAgentGraphSchema.parse({
    parent: {
      id: "parent_agent",
      name: "Parent Agent",
      task: [
        "Orchestrate the loop: evaluate each child agent's goal before proceeding.",
        "Pass structured outputs forward; pause at gates when human input is required.",
        `Loop outcome: ${output.summary}`,
      ].join(" "),
      policy: [
        "Never advance on placeholder or missing required input.",
        "Validate child outputs against their stated goals.",
        "Route delivery only through the declared provider after pre-send confirmation.",
      ].join(" "),
      connectorHub: {
        provider: "composio",
        label: "Composio",
        description: "Connector hub for external integrations.",
      },
    },
    children: output.agents.map((agent) => loopAgentGraphChildSchema.parse({
      id: agent.id,
      name: agent.name,
      task: agent.task,
      goal: agent.goal,
      tools: [{ ref: agent.tool }],
      doneCriteria: agent.doneCriteria,
      inputContract: agent.inputContract,
      outputContract: agent.outputContract,
      ...(agent.gate ? { gate: agent.gate } : {}),
      outputArtifactId: slugArtifactId(agent.id),
      outputArtifactKind: "structured_output",
    })),
  });
}

export function deliveryTypeFromRouting(delivery: z.infer<typeof loopDeliveryRoutingSchema>): string | undefined {
  if (delivery.target === "subscriber_list") return "newsletter";
  if (delivery.target === "team_email" || delivery.target === "operator") return "plain";
  return undefined;
}

export function detectPlaceholderText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  if (/\[(?:paste|tbd|todo|fill|insert)[^\]]*\]/i.test(normalized)) return true;
  if (/\b(?:tbd|pending|details pending|to be determined|placeholder)\b/i.test(normalized)) return true;
  return false;
}

function readMemorySourceRow(row: unknown): { id: string; text: string; score?: number } | null {
  const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
  const id = typeof item.id === "string" ? item.id : "";
  const text = typeof item.text === "string" ? item.text : "";
  if (!id || !text) return null;
  return {
    id,
    text,
    ...(typeof item.score === "number" ? { score: item.score } : {}),
  };
}

export function extractMemorySources(data: unknown): Array<{ id: string; text: string; score?: number }> {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const rows: Array<{ id: string; text: string; score?: number }> = [];
  const seen = new Set<string>();

  const pushRow = (row: unknown) => {
    const parsed = readMemorySourceRow(row);
    if (!parsed || seen.has(parsed.id)) return;
    seen.add(parsed.id);
    rows.push(parsed);
  };

  for (const row of Array.isArray(root.sources) ? root.sources : []) {
    pushRow(row);
  }

  for (const toolResult of Array.isArray(root.toolResults) ? root.toolResults : []) {
    const item = toolResult && typeof toolResult === "object" ? toolResult as Record<string, unknown> : {};
    if (item.ref !== "internal.memory_search") continue;
    const toolData = item.data && typeof item.data === "object" ? item.data as Record<string, unknown> : {};
    for (const row of Array.isArray(toolData.sources) ? toolData.sources : []) {
      pushRow(row);
    }
  }

  return rows;
}

export function formatMemorySearchText(sources: Array<{ id: string; text: string; score?: number }>): string {
  if (sources.length === 0) {
    return "No relevant memories found for this query.";
  }
  return [
    `Found ${sources.length} memories (id + excerpt):`,
    ...sources.map((source) => {
      const excerpt = source.text.trim().replace(/\s+/g, " ");
      const clipped = excerpt.length > 280 ? `${excerpt.slice(0, 280)}…` : excerpt;
      return `- [${source.id}] ${clipped}`;
    }),
  ].join("\n");
}
