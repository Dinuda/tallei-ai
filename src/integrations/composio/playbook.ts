import type { AuthContext } from "../../domain/auth/index.js";
import { normalizeToolkitSlug } from "./auth.js";
import { isComposioConfigured } from "./client.js";
import type { ConnectorPlaybook, ToolBinding, LoopIntent, ToolPlannerCard } from "../../loops/spec.js";
import { buildPlannerCardFromSchemas } from "../../loops/tool-planner-card.js";
import { getAllTools } from "./tools.js";

export type PlaybookToolEntry = {
  actionSlug: string;
  toolkit: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  relatedActionSlugs: string[];
};

export class PlaybookFetchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlaybookFetchError";
  }
}

export type FetchConnectorPlaybookResult = {
  playbook: ConnectorPlaybook;
  toolsBySlug: Map<string, PlaybookToolEntry>;
  relatedSlugs: string[];
};

const MAX_PLAYBOOK_PITFALLS = 8;
const MAX_WORKFLOW_STEPS = 12;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === "string" && value.trim() ? [value.trim()] : [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function extractStringList(...candidates: unknown[]): string[] {
  for (const candidate of candidates) {
    const rows = asStringArray(candidate);
    if (rows.length > 0) return rows;
  }
  return [];
}

function parseSearchResponse(response: unknown): {
  toolSchemas: Record<string, {
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    schemaRef?: string;
    toolkit?: string;
  }>;
  relatedSlugs: string[];
  pitfalls: string[];
  workflowSteps: string[];
  sessionId?: string;
} {
  const row = asRecord(response) ?? {};
  const data = asRecord(row.data) ?? row;
  const toolSchemasRaw = row.toolSchemas ?? data.toolSchemas ?? {};
  const toolSchemas = asRecord(toolSchemasRaw) ?? {};

  const relatedSlugs = new Set<string>();
  const results = Array.isArray(row.results) ? row.results : Array.isArray(data.results) ? data.results : [];
  for (const item of results) {
    const result = asRecord(item);
    if (!result) continue;
    for (const slug of [...asStringArray(result.primaryToolSlugs), ...asStringArray(result.relatedToolSlugs)]) {
      relatedSlugs.add(slug.toUpperCase());
    }
  }

  const pitfalls = extractStringList(
    data.pitfalls,
    data.common_pitfalls,
    data.commonPitfalls,
    row.pitfalls,
  ).slice(0, MAX_PLAYBOOK_PITFALLS);

  const workflowSteps = extractStringList(
    data.workflow_steps,
    data.workflowSteps,
    data.plan,
    data.execution_plan,
    data.executionPlan,
  ).slice(0, MAX_WORKFLOW_STEPS);

  const sessionId = String(
    data.session_id ?? data.sessionId ?? row.session_id ?? row.sessionId ?? "",
  ).trim() || undefined;

  const parsedSchemas: Record<string, {
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    schemaRef?: string;
    toolkit?: string;
  }> = {};

  for (const [slug, raw] of Object.entries(toolSchemas)) {
    const schema = asRecord(raw);
    if (!schema) continue;
    const inputSchema = asRecord(
      schema.inputSchema ?? schema.input_schema ?? schema.parameters,
    ) ?? undefined;
    const outputSchema = asRecord(
      schema.outputSchema ?? schema.output_schema,
    ) ?? undefined;
    parsedSchemas[slug.toUpperCase()] = {
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      ...(inputSchema ? { inputSchema } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      ...(typeof schema.schemaRef === "string" ? { schemaRef: schema.schemaRef } : {}),
      ...(typeof schema.toolkit === "string" ? { toolkit: schema.toolkit } : {}),
    };
  }

  return {
    toolSchemas: parsedSchemas,
    relatedSlugs: [...relatedSlugs],
    pitfalls,
    workflowSteps,
    sessionId,
  };
}

function toolkitFromSlug(actionSlug: string): string {
  const part = actionSlug.split("_")[0] ?? "";
  return normalizeToolkitSlug(part);
}

export async function fetchConnectorPlaybook(
  _auth: AuthContext,
  input: {
    intent: LoopIntent;
    bindings: ToolBinding[];
    connectedAccounts: Record<string, string>;
    boundActionSlugs: string[];
  },
): Promise<FetchConnectorPlaybookResult> {
  const compiledAt = new Date().toISOString();
  const useCase = input.intent.outcome;

  if (input.boundActionSlugs.length === 0) {
    return {
      playbook: { compiledAt, useCase },
      toolsBySlug: new Map(),
      relatedSlugs: [],
    };
  }

  if (!isComposioConfigured()) {
    throw new PlaybookFetchError(
      "COMPOSIO_NOT_CONFIGURED",
      "Composio is not configured — set TALLEI_CONNECTORS__COMPOSIO_API_KEY to compile tool playbooks",
    );
  }

  const toolsBySlug = new Map<string, PlaybookToolEntry>();
  const toolkits = [...new Set(input.bindings.map((binding) => normalizeToolkitSlug(binding.connector)))];
  const catalogues = new Map(
    await Promise.all(toolkits.map(async (toolkit) => [toolkit, await getAllTools(toolkit)] as const)),
  );

  for (const slug of new Set(input.boundActionSlugs.map((value) => value.toUpperCase()))) {
    const binding = input.bindings.find((row) => row.actionSlug?.toUpperCase() === slug);
    const toolkit = binding ? normalizeToolkitSlug(binding.connector) : toolkitFromSlug(slug);
    const matched = catalogues.get(toolkit)?.find((tool) => tool.actionSlug.toUpperCase() === slug);
    if (!matched) continue;

    toolsBySlug.set(slug, {
      actionSlug: slug,
      toolkit,
      description: matched.description || matched.name || slug,
      inputSchema: matched.inputSchema ?? {},
      ...(matched.outputSchema ? { outputSchema: matched.outputSchema } : {}),
      relatedActionSlugs: [],
    });
  }

  for (const slug of input.boundActionSlugs.map((s) => s.toUpperCase())) {
    const entry = toolsBySlug.get(slug);
    if (!entry || Object.keys(entry.inputSchema).length === 0) {
      throw new PlaybookFetchError(
        "PLAYBOOK_SCHEMA_MISSING",
        `Could not resolve input schema for bound action ${slug}`,
      );
    }
  }

  const toolkitVersions: Record<string, string> = {};
  for (const [toolkit, tools] of catalogues) {
    const version = tools.find((t) => t.toolkitVersion)?.toolkitVersion;
    if (version) toolkitVersions[toolkit] = version;
  }

  return {
    playbook: {
      compiledAt,
      useCase,
      ...(Object.keys(toolkitVersions).length > 0 ? { toolkitVersions } : {}),
    },
    toolsBySlug,
    relatedSlugs: [],
  };
}

export function buildPlannerCardForTool(
  tool: {
    actionSlug: string;
    capability: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  },
  entry: PlaybookToolEntry | undefined,
  playbook: ConnectorPlaybook,
): ToolPlannerCard {
  return buildPlannerCardFromSchemas({
    actionSlug: tool.actionSlug,
    capability: tool.capability,
    description: entry?.description ?? tool.actionSlug,
    inputSchema: entry?.inputSchema ?? tool.inputSchema,
    outputSchema: entry?.outputSchema ?? tool.outputSchema,
    relatedActionSlugs: entry?.relatedActionSlugs,
    pitfalls: playbook.pitfalls,
  });
}

export { parseSearchResponse };
