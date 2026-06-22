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
  type LoopDefinition,
} from "../loop-executor/types.js";
import { inputRequirementSchema } from "./input-surfaces.js";
import { dataContractSchema, normalizeContractSchema } from "./data-contract.js";
import { parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";

export {
  noSlopSpecAgentSchema,
  noSlopSpecDraftSchema,
  noSlopSpecSchema,
  noSlopSpecSnapshotSchema,
  noSlopSpecStatusSchema,
  type NoSlopSpec,
  type NoSlopSpecAgent,
  type NoSlopSpecSnapshot,
  type NoSlopSpecStatus,
} from "./spec-contracts.js";

const ENGINE_MAX_AGENTS = 12;
const ENGINE_MAX_CRITIC_RETRIES = 2;
const ENGINE_MAX_AGENT_RETRIES = 2;
export const DESIGNER_MEMORY_TOP_K = 8;

const loopArchitectAgentSchema = z.object({
  nodeKind: z.enum(["agent", "transform", "operator_input", "action", "checkpoint"]).optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().min(1),
  task: z.string().min(1),
  tool: z.string().min(1),
  toolConfig: z.record(z.unknown()).optional(),
  inputContract: z.object({
    description: z.string().min(1),
    schema: z.record(z.unknown()).default({}),
  }),
  outputContract: dataContractSchema,
  handoffBindings: z.array(z.object({
    source: z.object({
      kind: z.enum(["agent_output", "operator_input", "stable_config", "artifact"]),
      agentId: z.string().min(1).optional(),
      key: z.string().min(1).optional(),
      path: z.string().min(1).default("/"),
    }),
    targetPath: z.string().min(1),
    required: z.boolean().default(true),
    valuePolicy: z.enum(["derivable", "passthrough"]).optional(),
    provenance: z.enum(["agent_output", "operator_input", "stable_config", "artifact", "connector_output"]).optional(),
    transformation: z.enum(["direct", "merge", "transform"]).default("direct").optional(),
  })).default([]),
  doneCriteria: z.preprocess(
    (v) => Array.isArray(v) ? v.slice(0, 8) : v,
    z.array(z.string().min(1)).min(1),
  ),
  gate: z.object({
    type: loopGateTypeSchema,
    question: z.string().min(1),
  }).optional(),
  artifactRole: z.enum([
    "source_evidence",
    "draft_body",
    "final_preview",
    "delivery",
  ]).optional(),
});

function parseArchitectJsonField(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : fallback;
  } catch {
    return fallback;
  }
}

function normalizeArchitectDataContract(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const contract = { ...(value as Record<string, unknown>) };
  contract.schema = normalizeContractSchema(parseArchitectJsonField(contract.schema));
  const representation = typeof contract.representation === "string" ? contract.representation : "text";
  const mediaType = typeof contract.mediaType === "string" ? contract.mediaType : undefined;
  if (representation !== "json" && mediaType === "application/json") {
    contract.mediaType = "text/plain";
  }
  if (representation === "json" && mediaType !== "application/json") {
    contract.mediaType = "application/json";
  }
  if (contract.mediaType === null) delete contract.mediaType;
  if (contract.visibility === null) delete contract.visibility;
  if (contract.renderer === null) delete contract.renderer;
  return contract;
}

function normalizeArchitectInputContract(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const contract = { ...(value as Record<string, unknown>) };
  contract.schema = normalizeContractSchema(parseArchitectJsonField(contract.schema));
  return contract;
}

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHandoffBindingSource(source: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    kind: source.kind,
    path: trimOptionalString(source.path) ?? "/",
  };
  const agentId = trimOptionalString(source.agentId);
  const key = trimOptionalString(source.key);
  if (agentId) normalized.agentId = agentId;
  if (key) normalized.key = key;
  return normalized;
}

function normalizeHandoffBinding(binding: unknown): Record<string, unknown> | null {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
  const row = { ...(binding as Record<string, unknown>) };
  if (!row.source || typeof row.source !== "object" || Array.isArray(row.source)) return null;

  const source = normalizeHandoffBindingSource(row.source as Record<string, unknown>);
  const targetPath = trimOptionalString(row.targetPath);
  if (!targetPath) return null;

  const kind = source.kind;
  if (kind === "agent_output" && typeof source.agentId !== "string") return null;
  if (kind === "operator_input" && typeof source.key !== "string") return null;
  if (kind === "artifact" && typeof source.key !== "string") return null;

  const normalized: Record<string, unknown> = {
    source,
    targetPath,
    required: typeof row.required === "boolean" ? row.required : true,
  };
  const valuePolicy = trimOptionalString(row.valuePolicy);
  const provenance = trimOptionalString(row.provenance);
  const transformation = trimOptionalString(row.transformation);
  if (valuePolicy === "derivable" || valuePolicy === "passthrough") normalized.valuePolicy = valuePolicy;
  if (
    provenance === "agent_output"
    || provenance === "operator_input"
    || provenance === "stable_config"
    || provenance === "artifact"
    || provenance === "connector_output"
  ) {
    normalized.provenance = provenance;
  }
  if (transformation === "direct" || transformation === "merge" || transformation === "transform") {
    normalized.transformation = transformation;
  }
  return normalized;
}

function normalizeArchitectAgent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const agent = { ...(value as Record<string, unknown>) };
  if (agent.gate === null || agent.gate === undefined) {
    delete agent.gate;
  } else if (agent.gate && typeof agent.gate === "object" && !Array.isArray(agent.gate)) {
    const gate = agent.gate as Record<string, unknown>;
    const gateType = typeof gate.type === "string" ? gate.type.trim().toLowerCase() : "";
    if (!gateType || gateType === "none") {
      delete agent.gate;
    }
  }
  if (agent.toolConfig === null) {
    delete agent.toolConfig;
  } else if (typeof agent.toolConfig === "string") {
    const parsed = parseArchitectJsonField(agent.toolConfig);
    agent.toolConfig = Object.keys(parsed).length > 0 ? parsed : undefined;
    if (!agent.toolConfig) delete agent.toolConfig;
  }
  if (agent.nodeKind === null) delete agent.nodeKind;
  if (agent.artifactRole === null) delete agent.artifactRole;
  if (agent.inputContract) {
    agent.inputContract = normalizeArchitectInputContract(agent.inputContract);
  }
  if (agent.outputContract) {
    agent.outputContract = normalizeArchitectDataContract(agent.outputContract);
  }
  if (Array.isArray(agent.handoffBindings)) {
    agent.handoffBindings = agent.handoffBindings
      .map((binding) => normalizeHandoffBinding(binding))
      .filter((binding): binding is Record<string, unknown> => binding !== null);
  }
  return agent;
}

/** Coerce common architect LLM shape mistakes before strict schema validation. */
export function preprocessArchitectOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const next: Record<string, unknown> = { ...root };

  if (Array.isArray(root.rationale)) {
    next.rationale = root.rationale.filter((line): line is string => typeof line === "string" && line.trim().length > 0);
  }

  if (Array.isArray(root.suggestedChannels)) {
    next.suggestedChannels = root.suggestedChannels
      .filter((channel): channel is string => typeof channel === "string" && channel.trim().length > 0);
  }

  if (root.delivery && typeof root.delivery === "object" && !Array.isArray(root.delivery)) {
    const delivery = { ...(root.delivery as Record<string, unknown>) };
    const provider = typeof delivery.provider === "string" ? delivery.provider.trim() : "";
    if (provider) {
      next.delivery = { provider };
    } else throw new Error("Architect delivery requires an explicit provider.");
  }

  if (Array.isArray(root.inputRequirements)) {
    next.inputRequirements = root.inputRequirements.map((requirement) => {
      if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) return requirement;
      const row = { ...(requirement as Record<string, unknown>) };
      if (row.label === null) delete row.label;
      if (row.description === null) delete row.description;
      return row;
    });
  }

  if (Array.isArray(root.agents)) {
    next.agents = root.agents.map(normalizeArchitectAgent);
  }

  return next;
}

const loopArchitectOutputBaseSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  strategyText: z.string().min(1),
  inputRequirements: z.array(inputRequirementSchema).default([]),
  delivery: loopDeliveryRoutingSchema,
  schedule: z.object({
    cron: z.string().min(1),
    timezone: z.string().min(1).default("UTC"),
  }),
  agents: z.array(loopArchitectAgentSchema).min(2).max(ENGINE_MAX_AGENTS),
  rationale: z.array(z.string().min(1)).default([]),
  suggestedChannels: z.array(z.string().min(1)).default(["primary"]),
});

const loopArchitectOutputSchema = z.preprocess(
  preprocessArchitectOutput,
  loopArchitectOutputBaseSchema,
);

export type LoopArchitectOutput = z.infer<typeof loopArchitectOutputSchema>;
type LoopArchitectAgent = z.infer<typeof loopArchitectAgentSchema>;

const workflowCriticResultSchema = z.object({
  pass: z.boolean(),
  riskLevel: z.enum(["low", "medium", "high"]),
  issues: z.array(z.string()).default([]),
  requiredFixes: z.array(z.string()).default([]),
});

export type WorkflowCriticResult = z.infer<typeof workflowCriticResultSchema>;

const goalEvalStatusSchema = z.enum(["pass", "fail", "needs_input", "retry"]);
type GoalEvalStatus = z.infer<typeof goalEvalStatusSchema>;

export const goalEvalResultSchema = z.object({
  status: goalEvalStatusSchema,
  reason: z.string().min(1),
  blockers: z.array(z.string()).default([]),
  gateType: loopGateTypeSchema.optional(),
  missingRequired: z.array(z.string()).optional(),
  normalizedOutput: z.record(z.unknown()).optional(),
  normalizedHandoff: z.record(z.unknown()).optional(),
});

export type GoalEvalResult = z.infer<typeof goalEvalResultSchema>;

function isEngineV3Definition(definition: LoopDefinition): boolean {
  return definition.engineVersion === LOOP_ENGINE_VERSION
    || definition.builderMeta?.engineVersion === LOOP_ENGINE_VERSION;
}

function assertDeliveryRouting(delivery: z.infer<typeof loopDeliveryRoutingSchema>): void {
  const provider = delivery.provider.trim();
  if (!provider) throw new Error("Delivery routing error: provider is required");
  if (provider.toLowerCase() === "none") return;
  if (!/^composio\.[a-z0-9_-]+\.action\./.test(provider.toLowerCase())) {
    throw new Error(`Delivery routing error: provider must be "none" or a composio action ref, got "${provider}"`);
  }
}

function slugArtifactId(agentId: string): string {
  return `${agentId.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 40) || "agent"}_output`;
}

function architectOutputToAgentGraph(output: LoopArchitectOutput): z.infer<typeof loopAgentGraphSchema> {
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
      nodeKind: agent.nodeKind ?? (agent.tool === "internal.operator_input"
        ? "operator_input"
        : agent.tool === "internal.json_transform"
          ? "transform"
          : parseConnectorActionToolRef(agent.tool)
            ? "action"
            : "agent"),
      task: agent.task,
      goal: agent.goal,
      tools: [{ ref: agent.tool, ...(agent.toolConfig ? { config: agent.toolConfig } : {}) }],
      doneCriteria: agent.doneCriteria,
      inputContract: agent.inputContract,
      outputContract: agent.outputContract,
      handoffBindings: agent.handoffBindings,
      ...(agent.gate ? { gate: agent.gate } : {}),
      outputArtifactId: slugArtifactId(agent.id),
      outputArtifactKind: agent.outputContract.renderer === "canvas.preview"
        ? "canvas_preview"
        : agent.outputContract.renderer === "canvas.email"
          ? "canvas_email"
          : "structured_output",
    })),
  });
}

export function deliveryTypeFromRouting(delivery: z.infer<typeof loopDeliveryRoutingSchema>): string | undefined {
  return delivery.provider.toLowerCase() === "none" ? undefined : "external_action";
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

export type WebSearchSource = {
  title: string;
  url: string;
  snippet: string;
};

function readWebSearchSourceRow(row: unknown): WebSearchSource | null {
  const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
  const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "";
  const url = typeof item.url === "string" && item.url.trim() ? item.url.trim() : "";
  const snippet = typeof item.snippet === "string" && item.snippet.trim() ? item.snippet.trim() : "";
  if (!title || !url || !snippet) return null;
  return { title, url, snippet };
}

export function extractWebSearchSources(data: unknown): WebSearchSource[] {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const rows: WebSearchSource[] = [];
  const seen = new Set<string>();

  const pushRow = (row: unknown) => {
    const parsed = readWebSearchSourceRow(row);
    if (!parsed || seen.has(parsed.url)) return;
    seen.add(parsed.url);
    rows.push(parsed);
  };

  for (const row of Array.isArray(root.sources) ? root.sources : []) {
    pushRow(row);
  }

  for (const toolResult of Array.isArray(root.toolResults) ? root.toolResults : []) {
    const item = toolResult && typeof toolResult === "object" ? toolResult as Record<string, unknown> : {};
    if (item.ref !== "internal.web_search") continue;
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
