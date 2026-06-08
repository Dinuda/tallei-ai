/**
 * contracts.ts — Typed contracts, validation, and helpers for the agentic loop engine.
 */

import { z } from "zod";

import {
  LOOP_ENGINE_VERSION,
  loopAgentGraphChildSchema,
  loopAgentGraphSchema,
  loopDeliveryRoutingSchema,
  loopGateTypeSchema,
  loopRenderTargetSchema,
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
  subscriber_list: [],
  team_email: [],
  operator: [],
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
  renderTarget: loopRenderTargetSchema.optional(),
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
  if (target === "none") return provider.trim().toLowerCase() === "none";
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
      ...(agent.renderTarget ? { renderTarget: agent.renderTarget } : {}),
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
  if (/\b(?:tbd|details pending|to be determined|placeholder)\b/i.test(normalized)) return true;
  return false;
}

export type MemorySearchSource = {
  id: string;
  text: string;
  score?: number;
  confidence?: number;
  reason?: string;
  evidenceRole?: string;
  metadata?: Record<string, unknown>;
};

export type MemorySearchTrace = {
  query: string | null;
  queryPlan: Record<string, unknown> | null;
  retrieval: {
    vectorQueries: Array<{
      query: string;
      hitCount: number;
      topMatches: Array<{ id: string; score: number }>;
    }>;
    lexicalMatchCount: number;
    mergedCandidateCount: number;
  } | null;
  validation: {
    acceptedCount: number;
    acceptedIds: string[];
    rejectedCount: number;
    confidence: string | null;
    noEvidenceReason: string | null;
  } | null;
  sources: MemorySearchSource[];
};

function readMemorySourceRow(row: unknown): MemorySearchSource | null {
  const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
  const id = typeof item.id === "string" ? item.id : "";
  const text = typeof item.text === "string" ? item.text : "";
  if (!id || !text) return null;
  return {
    id,
    text,
    ...(typeof item.score === "number" ? { score: item.score } : {}),
    ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
    ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    ...(typeof item.evidenceRole === "string" ? { evidenceRole: item.evidenceRole } : {}),
    ...(item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? { metadata: item.metadata as Record<string, unknown> }
      : {}),
  };
}

export function extractMemorySources(data: unknown): MemorySearchSource[] {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const rows: MemorySearchSource[] = [];
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

function readMemorySearchTrace(data: unknown): MemorySearchTrace | null {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const trace = root.trace && typeof root.trace === "object" && !Array.isArray(root.trace)
    ? root.trace as Record<string, unknown>
    : {};
  const queryPlan = trace.queryPlan && typeof trace.queryPlan === "object" && !Array.isArray(trace.queryPlan)
    ? trace.queryPlan as Record<string, unknown>
    : (root.queryPlan && typeof root.queryPlan === "object" && !Array.isArray(root.queryPlan)
      ? root.queryPlan as Record<string, unknown>
      : null);
  const retrieval = trace.retrieval && typeof trace.retrieval === "object" && !Array.isArray(trace.retrieval)
    ? trace.retrieval as Record<string, unknown>
    : null;
  const validation = trace.validation && typeof trace.validation === "object" && !Array.isArray(trace.validation)
    ? trace.validation as Record<string, unknown>
    : null;
  const sources = Array.isArray(root.sources)
    ? root.sources.map((row) => readMemorySourceRow(row)).filter((row): row is MemorySearchSource => row !== null)
    : [];

  if (!queryPlan && !retrieval && !validation && sources.length === 0) {
    return null;
  }

  const vectorQueries = Array.isArray(retrieval?.vectorQueries)
    ? retrieval.vectorQueries
      .map((query) => {
        const item = query && typeof query === "object" && !Array.isArray(query)
          ? query as Record<string, unknown>
          : {};
        const matches = Array.isArray(item.topMatches)
          ? item.topMatches
            .map((match) => {
              const entry = match && typeof match === "object" && !Array.isArray(match)
                ? match as Record<string, unknown>
                : {};
              return {
                id: typeof entry.id === "string" ? entry.id : "",
                score: typeof entry.score === "number" ? entry.score : 0,
              };
            })
            .filter((match) => Boolean(match.id))
          : [];
        return {
          query: typeof item.query === "string" ? item.query : "",
          hitCount: typeof item.hitCount === "number" ? item.hitCount : matches.length,
          topMatches: matches,
        };
      })
      .filter((entry) => Boolean(entry.query))
    : [];

  return {
    query: typeof trace.query === "string" ? trace.query : (typeof root.query === "string" ? root.query : null),
    queryPlan: queryPlan && Object.keys(queryPlan).length > 0 ? queryPlan : null,
    retrieval: retrieval || vectorQueries.length > 0
      ? {
          vectorQueries,
          lexicalMatchCount: typeof retrieval?.lexicalMatchCount === "number" ? retrieval.lexicalMatchCount : 0,
          mergedCandidateCount: typeof retrieval?.mergedCandidateCount === "number" ? retrieval.mergedCandidateCount : sources.length,
        }
      : null,
    validation: validation || sources.length > 0
      ? {
          acceptedCount: typeof validation?.acceptedCount === "number" ? validation.acceptedCount : sources.length,
          acceptedIds: Array.isArray(validation?.acceptedIds)
            ? validation.acceptedIds.filter((id): id is string => typeof id === "string" && id.length > 0)
            : sources.map((source) => source.id),
          rejectedCount: typeof validation?.rejectedCount === "number" ? validation.rejectedCount : 0,
          confidence: typeof validation?.confidence === "string" ? validation.confidence : null,
          noEvidenceReason: typeof validation?.noEvidenceReason === "string" ? validation.noEvidenceReason : null,
        }
      : null,
    sources,
  };
}

export function extractMemorySearchTraces(data: unknown): MemorySearchTrace[] {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const traces: MemorySearchTrace[] = [];

  for (const toolResult of Array.isArray(root.toolResults) ? root.toolResults : []) {
    const item = toolResult && typeof toolResult === "object" ? toolResult as Record<string, unknown> : {};
    if (item.ref !== "internal.memory_search") continue;
    const trace = readMemorySearchTrace(item.data);
    if (trace) traces.push(trace);
  }

  const directTrace = readMemorySearchTrace(root);
  if (directTrace && traces.length === 0) {
    traces.push(directTrace);
  }

  return traces;
}

export function formatMemorySearchText(sources: MemorySearchSource[]): string {
  if (sources.length === 0) {
    return "No relevant memories found for this query.";
  }
  return [
    `Found ${sources.length} validated memories (id + excerpt):`,
    ...sources.map((source) => {
      const excerpt = source.text.trim().replace(/\s+/g, " ");
      const clipped = excerpt.length > 280 ? `${excerpt.slice(0, 280)}…` : excerpt;
      return `- [${source.id}] ${clipped}`;
    }),
  ].join("\n");
}
