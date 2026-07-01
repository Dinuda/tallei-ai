import type { AuthContext } from "../../domain/auth/index.js";
import { normalizeToolkitSlug } from "./auth.js";
import { isComposioConfigured } from "./client.js";
import { createSession } from "./session.js";
import type { ComposioAgentSession } from "./types.js";
import type { ConnectorPlaybook, ToolBinding, LoopIntent } from "../../loops/spec.js";
import { buildPlannerCardFromSchemas } from "../../loops/tool-planner-card.js";
import type { ToolPlannerCard } from "../../loops/spec.js";
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

async function resolveSchemaRefsViaSession(
  session: ComposioAgentSession,
  slugs: string[],
): Promise<Record<string, { inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }>> {
  if (slugs.length === 0) return {};
  try {
    const result = await session.client.execute("COMPOSIO_GET_TOOL_SCHEMAS", {
      arguments: {
        tool_slugs: slugs,
        include: ["input_schema", "output_schema"],
      },
    });
    const row = asRecord(result) ?? {};
    const data = asRecord(row.data) ?? row;
    const schemas = asRecord(data.schemas ?? data.tool_schemas ?? data) ?? {};
    const resolved: Record<string, { inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }> = {};
    for (const [slug, raw] of Object.entries(schemas)) {
      const schema = asRecord(raw);
      if (!schema) continue;
      resolved[slug.toUpperCase()] = {
        inputSchema: asRecord(schema.input_schema ?? schema.inputSchema) ?? undefined,
        outputSchema: asRecord(schema.output_schema ?? schema.outputSchema) ?? undefined,
      };
    }
    return resolved;
  } catch (error) {
    console.warn("[integrations/composio] GET_TOOL_SCHEMAS failed:", error);
    return {};
  }
}

function buildSearchQuery(intent: LoopIntent, bindings: ToolBinding[]): string {
  const connectors = [...new Set(bindings.map((b) => b.connector))].join(" ");
  const capabilities = bindings.map((b) => b.capability.replace(/\./g, " ")).join(" ");
  return `${intent.outcome} ${intent.goal} ${connectors} ${capabilities}`.trim().replace(/\s+/g, " ");
}

function toolkitFromSlug(actionSlug: string): string {
  const part = actionSlug.split("_")[0] ?? "";
  return normalizeToolkitSlug(part);
}

export async function fetchConnectorPlaybook(
  auth: AuthContext,
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

  let session: ComposioAgentSession;
  try {
    session = await createSession(auth, {
      connectedAccounts: input.connectedAccounts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PlaybookFetchError("PLAYBOOK_SESSION_FAILED", `Composio session failed: ${message}`);
  }

  const searchQuery = buildSearchQuery(input.intent, input.bindings);
  let parsed = {
    toolSchemas: {} as ReturnType<typeof parseSearchResponse>["toolSchemas"],
    relatedSlugs: [] as string[],
    pitfalls: [] as string[],
    workflowSteps: [] as string[],
    sessionId: session.sessionId,
  };

  try {
    const searchResponse = await session.client.search({ query: searchQuery });
    parsed = { ...parseSearchResponse(searchResponse), sessionId: session.sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PlaybookFetchError("PLAYBOOK_SEARCH_FAILED", `Composio playbook search failed: ${message}`);
  }

  const schemaRefSlugs = Object.entries(parsed.toolSchemas)
    .filter(([, schema]) => schema.schemaRef && !schema.inputSchema)
    .map(([slug]) => slug);
  const missingBound = input.boundActionSlugs
    .map((s) => s.toUpperCase())
    .filter((slug) => !parsed.toolSchemas[slug]);
  const refsToResolve = [...new Set([...schemaRefSlugs, ...missingBound])];

  const resolvedRefs = await resolveSchemaRefsViaSession(session, refsToResolve.slice(0, 20));

  const toolsBySlug = new Map<string, PlaybookToolEntry>();
  const allSlugs = new Set([
    ...input.boundActionSlugs.map((s) => s.toUpperCase()),
    ...parsed.relatedSlugs,
    ...Object.keys(parsed.toolSchemas),
  ]);

  for (const slug of allSlugs) {
    const fromSearch = parsed.toolSchemas[slug];
    const fromResolve = resolvedRefs[slug];
    let inputSchema = fromSearch?.inputSchema ?? fromResolve?.inputSchema ?? {};
    let outputSchema = fromSearch?.outputSchema ?? fromResolve?.outputSchema;
    let description = fromSearch?.description ?? slug;
    let toolkit = fromSearch?.toolkit ? normalizeToolkitSlug(fromSearch.toolkit) : toolkitFromSlug(slug);

    if (Object.keys(inputSchema).length === 0) {
      const catalogue = await getAllTools(toolkit);
      const matched = catalogue.find((t) => t.actionSlug.toUpperCase() === slug);
      if (matched) {
        inputSchema = matched.inputSchema ?? {};
        outputSchema = outputSchema ?? matched.outputSchema;
        description = matched.description || description;
      }
    }

    toolsBySlug.set(slug, {
      actionSlug: slug,
      toolkit,
      description,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      relatedActionSlugs: parsed.relatedSlugs.filter((s) => s !== slug),
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
  for (const binding of input.bindings) {
    const toolkit = normalizeToolkitSlug(binding.connector);
    const tools = await getAllTools(toolkit);
    const version = tools.find((t) => t.toolkitVersion)?.toolkitVersion;
    if (version) toolkitVersions[toolkit] = version;
  }

  return {
    playbook: {
      composioSessionId: parsed.sessionId,
      compiledAt,
      useCase,
      ...(parsed.workflowSteps.length > 0 ? { workflowSteps: parsed.workflowSteps } : {}),
      ...(parsed.pitfalls.length > 0 ? { pitfalls: parsed.pitfalls } : {}),
      ...(Object.keys(toolkitVersions).length > 0 ? { toolkitVersions } : {}),
    },
    toolsBySlug,
    relatedSlugs: parsed.relatedSlugs,
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
