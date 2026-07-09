import { getConnectorProvider } from "../integrations/connectors/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { normalizeToolkitSlug, resolveToolkitSlug } from "../integrations/composio/auth.js";
import {
  capabilityForAction,
  scoreSchemaFieldRelevance,
  scoreTriggerFieldOverlap,
  summarizeInputSchema,
  type SchemaFieldSummary,
} from "@tallei/composio-tools/tool-schema.js";

export const MIN_CAPABILITY_SCORE = 2;
/** Top candidates within this score gap are treated as ambiguous (user picks outcome-framed option). */
export const BINDING_AMBIGUITY_SCORE_GAP = 1;

export type ConfigurableField = {
  key: string;
  label: string;
  description: string;
  type: "string" | "array" | "boolean" | "number";
  options: Array<{ label: string; value: string | number | boolean }>;
};

function schemaRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fieldLabel(key: string, schema: Record<string, unknown>): string {
  const title = typeof schema.title === "string" ? schema.title.trim() : "";
  if (title) return title;
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Return only optional fields that materially scope which records a trigger observes. */
export function extractConfigurableFields(schema: Record<string, unknown>): ConfigurableField[] {
  const properties = schemaRecord(schema.properties) ?? schema;
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : []);
  const scopePattern = /(label|folder|filter|query|channel|category|mailbox|scope|status|project|list|board|calendar)/i;
  return Object.entries(properties).flatMap(([key, raw]) => {
    if (required.has(key)) return [];
    const field = schemaRecord(raw);
    if (!field) return [];
    const description = typeof field.description === "string" ? field.description.trim() : "";
    const title = typeof field.title === "string" ? field.title.trim() : "";
    const type = field.type === "integer" ? "number" : field.type;
    const enumValues = Array.isArray(field.enum)
      ? field.enum
      : Array.isArray(schemaRecord(field.items)?.enum) ? schemaRecord(field.items)!.enum as unknown[] : [];
    if (!scopePattern.test(`${key} ${title} ${description}`)) return [];
    if (!["string", "array", "boolean", "number"].includes(String(type))) return [];
    const options = enumValues
      .filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value))
      .map((value) => ({ label: String(value), value }));
    return [{
      key,
      label: fieldLabel(key, field),
      description,
      type: type as ConfigurableField["type"],
      options,
    }];
  }).sort((left, right) => {
    const score = (field: ConfigurableField) =>
      (/label|folder|mailbox|channel/i.test(field.key) ? 4 : 0)
      + (field.options.length > 0 ? 2 : 0)
      + (field.description ? 1 : 0);
    return score(right) - score(left);
  }).slice(0, 1);
}

export function validateConfigAgainstSchema(
  schema: Record<string, unknown>,
  config: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  const properties = schemaRecord(schema.properties) ?? {};
  for (const [key, value] of Object.entries(config)) {
    const field = schemaRecord(properties[key]);
    if (!field) return { ok: false, error: `Unknown trigger configuration field ${key}` };
    const expected = field.type;
    const valid = expected === "array" ? Array.isArray(value)
      : expected === "integer" || expected === "number" ? typeof value === "number"
        : expected === "boolean" ? typeof value === "boolean"
          : expected === "string" ? typeof value === "string" : true;
    if (!valid) return { ok: false, error: `Invalid value for trigger configuration field ${key}` };
    const allowed = Array.isArray(field.enum) ? field.enum : null;
    if (allowed && !allowed.includes(value)) return { ok: false, error: `Unsupported value for trigger configuration field ${key}` };
  }
  return { ok: true };
}

function findNamedOptions(value: unknown): Array<{ label: string; value: string }> {
  if (Array.isArray(value)) {
    const options = value.flatMap((item) => {
      const row = schemaRecord(item);
      if (!row) return [];
      const id = String(row.id ?? row.value ?? "").trim();
      const label = String(row.name ?? row.label ?? "").trim();
      return id && label ? [{ label, value: id }] : [];
    });
    if (options.length > 0) return options;
    return value.flatMap(findNamedOptions);
  }
  const row = schemaRecord(value);
  if (!row) return [];
  for (const child of Object.values(row)) {
    const options = findNamedOptions(child);
    if (options.length > 0) return options;
  }
  return [];
}

/** Resolve opaque label identifiers through a safe catalogue read so users see names, not provider IDs. */
export async function resolveConfigurableFieldOptions(
  auth: AuthContext,
  toolkit: string,
  fields: ConfigurableField[],
): Promise<ConfigurableField[]> {
  if (!fields.some((field) => /label/i.test(field.key) && field.options.length === 0)) return fields;
  try {
    const provider = getConnectorProvider();
    const [actions, connection] = await Promise.all([
      provider.listActions(toolkit),
      provider.getConnection(auth, toolkit),
    ]);
    if (!connection.connectedAccountId) return fields;
    const listLabels = actions.find((action) =>
      /(?:LIST|GET).*LABELS|LABELS.*(?:LIST|GET)/i.test(action.actionSlug)
      && /list|get|fetch/i.test(`${action.name} ${action.description}`));
    if (!listLabels) return fields;
    const output = await provider.execute({
      auth,
      toolkit,
      actionSlug: listLabels.actionSlug,
      connectedAccountId: connection.connectedAccountId,
      args: {},
      ...(listLabels.toolkitVersion ? { toolkitVersion: listLabels.toolkitVersion } : {}),
    });
    const options = findNamedOptions(output).filter((option, index, all) =>
      all.findIndex((candidate) => candidate.value === option.value) === index);
    if (options.length === 0) return fields;
    return fields.map((field) => /label/i.test(field.key) && field.options.length === 0
      ? { ...field, options }
      : field);
  } catch (error) {
    console.warn("[loops/binding-discovery] failed to resolve trigger configuration choices", {
      toolkit,
      error: error instanceof Error ? error.message : String(error),
    });
    return fields;
  }
}

export type BindingCandidate = {
  /** Same as actionSlug — kept for spec/API compatibility. */
  capability: string;
  actionSlug: string;
  name: string;
  description: string;
  score: number;
  schemaSummary: SchemaFieldSummary;
  inputSchema: Record<string, unknown>;
};

export type BindingAskOption = {
  id: string;
  label: string;
  value: string;
  description: string;
};

const STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "that", "this", "into", "when", "each", "agent", "loop",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

/**
 * Count how many non-trivial words from the outcome appear in the action's
 * slug, name, description, and schema field text.
 */
export function scoreOutcomeRelevance(
  outcomeDescription: string,
  actionSlug: string,
  name: string,
  description: string,
  inputSchema: Record<string, unknown> = {},
): number {
  const haystack = `${actionSlug} ${name} ${description}`.toLowerCase();
  const fromText = tokenize(outcomeDescription).reduce(
    (score, word) => (haystack.includes(word) ? score + 1 : score),
    0,
  );
  return fromText + scoreSchemaFieldRelevance(outcomeDescription, inputSchema);
}

function scoreAction(
  outcomeDescription: string,
  action: { actionSlug: string; name: string; description: string; inputSchema?: Record<string, unknown> },
  triggerFields?: Record<string, unknown>,
): number {
  const inputSchema = action.inputSchema ?? {};
  let score = scoreOutcomeRelevance(
    outcomeDescription,
    action.actionSlug,
    action.name,
    action.description,
    inputSchema,
  );
  if (triggerFields && Object.keys(triggerFields).length > 0) {
    score += scoreTriggerFieldOverlap(triggerFields, inputSchema) * 2;
  }
  return score;
}

/** True when close-scoring candidates represent meaningfully different operations (not implementation variants). */
export function pickRecommendedBinding(
  candidates: BindingCandidate[],
  triggerFields?: Record<string, unknown>,
): BindingCandidate | null {
  const ranked = candidates
    .filter((candidate) => candidate.score >= MIN_CAPABILITY_SCORE)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;

  const topScore = ranked[0]!.score;
  const tied = ranked.filter((candidate) => candidate.score >= topScore - BINDING_AMBIGUITY_SCORE_GAP);
  if (tied.length === 1 || !triggerFields) return ranked[0]!;

  return tied
    .slice()
    .sort((left, right) =>
      scoreTriggerFieldOverlap(triggerFields, right.inputSchema)
      - scoreTriggerFieldOverlap(triggerFields, left.inputSchema),
    )[0] ?? ranked[0]!;
}

export function looksLikeComposioActionSlug(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value.trim());
}

function mergeCandidates(existing: Map<string, BindingCandidate>, candidate: BindingCandidate): void {
  const key = candidate.actionSlug.toUpperCase();
  const prior = existing.get(key);
  if (!prior || candidate.score > prior.score) {
    existing.set(key, candidate);
  }
}

function toCandidate(
  action: { actionSlug: string; name: string; description: string; inputSchema?: Record<string, unknown> },
  score: number,
): BindingCandidate {
  const inputSchema = action.inputSchema ?? {};
  const actionSlug = action.actionSlug;
  return {
    capability: capabilityForAction(actionSlug),
    actionSlug,
    name: action.name,
    description: action.description,
    score,
    schemaSummary: summarizeInputSchema(inputSchema),
    inputSchema,
  };
}

/**
 * Rank Composio actions for a connector against an outcome description.
 * Scoring uses only outcome text overlap with action metadata + schema fields.
 */
export async function rankBindingCandidates(
  connector: string,
  outcomeDescription: string,
  options?: { triggerFields?: Record<string, unknown> },
): Promise<BindingCandidate[]> {
  const normalizedConnector = await resolveToolkitSlug(connector);
  const byAction = new Map<string, BindingCandidate>();
  const triggerFields = options?.triggerFields;

  if (looksLikeComposioActionSlug(outcomeDescription)) {
    const tools = await getConnectorProvider().listActions(normalizedConnector);
    const direct = tools.find((tool) => tool.actionSlug.toUpperCase() === outcomeDescription.toUpperCase());
    if (direct) {
      mergeCandidates(byAction, toCandidate(direct, MIN_CAPABILITY_SCORE + 4));
    }
  }

  const searchResults = await getConnectorProvider().searchActions(`${normalizedConnector} ${outcomeDescription}`, 24);
  for (const result of searchResults) {
    if (normalizeToolkitSlug(result.toolkit) !== normalizeToolkitSlug(normalizedConnector)) continue;
    const score = scoreAction(outcomeDescription, result, triggerFields);
    if (score <= 0) continue;
    mergeCandidates(byAction, toCandidate(result, score));
  }

  const toolkitTools = await getConnectorProvider().listActions(normalizedConnector);
  for (const tool of toolkitTools) {
    const score = scoreAction(outcomeDescription, tool, triggerFields);
    if (score <= 0) continue;
    mergeCandidates(byAction, toCandidate(tool, score));
  }

  return [...byAction.values()]
    .filter((candidate) => candidate.score >= MIN_CAPABILITY_SCORE)
    .sort((a, b) => b.score - a.score);
}

export type ExplicitActionResolution =
  | {
      ok: true;
      action: {
        actionSlug: string;
        inputSchema: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        toolkitVersion?: string;
      };
    }
  | { ok: false; code: "ACTION_NOT_FOUND" | "ACTION_TOOLKIT_MISMATCH"; actualToolkit?: string };

export function selectExplicitBindingAction(input: {
  connector: string;
  actionSlug: string;
  scopedTools: Array<{
    actionSlug: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    toolkitVersion?: string;
  }>;
  globalMatches: Array<{ actionSlug: string; toolkit: string }>;
}): ExplicitActionResolution {
  const requestedSlug = input.actionSlug.trim().toUpperCase();
  const exact = input.scopedTools.find((tool) => tool.actionSlug.toUpperCase() === requestedSlug);
  if (exact) {
    return {
      ok: true,
      action: {
        actionSlug: exact.actionSlug,
        inputSchema: exact.inputSchema ?? {},
        ...(exact.outputSchema ? { outputSchema: exact.outputSchema } : {}),
        ...(exact.toolkitVersion ? { toolkitVersion: exact.toolkitVersion } : {}),
      },
    };
  }
  const wrongToolkit = input.globalMatches.find((tool) => tool.actionSlug.toUpperCase() === requestedSlug);
  if (wrongToolkit && normalizeToolkitSlug(wrongToolkit.toolkit) !== normalizeToolkitSlug(input.connector)) {
    return { ok: false, code: "ACTION_TOOLKIT_MISMATCH", actualToolkit: wrongToolkit.toolkit };
  }
  return { ok: false, code: "ACTION_NOT_FOUND" };
}

export async function resolveExplicitBindingAction(
  connector: string,
  actionSlug: string,
): Promise<ExplicitActionResolution> {
  const normalizedConnector = await resolveToolkitSlug(connector);
  const tools = await getConnectorProvider().listActions(normalizedConnector);
  const scopedResolution = selectExplicitBindingAction({
    connector: normalizedConnector,
    actionSlug,
    scopedTools: tools,
    globalMatches: [],
  });
  if (scopedResolution.ok) return scopedResolution;

  const globalMatches = await getConnectorProvider().searchActions(actionSlug, 50);
  return selectExplicitBindingAction({
    connector: normalizedConnector,
    actionSlug,
    scopedTools: tools,
    globalMatches,
  });
}

export type InvalidBindingActionOverride = {
  outcomeId: string;
  actionSlug: string;
  code: "UNKNOWN_OUTCOME" | "ACTION_NOT_FOUND" | "ACTION_TOOLKIT_MISMATCH";
  actualToolkit?: string;
};

export async function resolveBindingActionOverrides(
  connector: string,
  outcomes: Array<{ id: string }>,
  overrides: Array<{ outcomeId: string; actionSlug: string }>,
  resolveAction: typeof resolveExplicitBindingAction = resolveExplicitBindingAction,
): Promise<{
  resolved: Map<string, string>;
  invalid: InvalidBindingActionOverride[];
}> {
  const outcomeIds = new Set(outcomes.map((outcome) => outcome.id));
  const resolved = new Map<string, string>();
  const invalid: InvalidBindingActionOverride[] = [];
  for (const override of overrides) {
    if (!outcomeIds.has(override.outcomeId)) {
      invalid.push({ ...override, code: "UNKNOWN_OUTCOME" });
      continue;
    }
    const resolution = await resolveAction(connector, override.actionSlug);
    if (!resolution.ok) {
      invalid.push({
        ...override,
        code: resolution.code,
        ...(resolution.actualToolkit ? { actualToolkit: resolution.actualToolkit } : {}),
      });
      continue;
    }
    resolved.set(override.outcomeId, resolution.action.actionSlug);
  }
  return { resolved, invalid };
}

export async function discoverOutcomeBindings(
  toolkit: string,
  outcomes: Array<{ id: string; description: string; role?: "trigger" | "source" | "transform" | "destination" }>,
  options?: { triggerFields?: Record<string, unknown> },
): Promise<{
  toolkit: string;
  suggestedBindings: Array<{ outcomeId: string; connector: string; capability: string; actionSlug: string; role?: "trigger" | "source" | "transform" | "destination" }>;
  ambiguities: Array<{
    outcomeId: string;
    candidates: Array<{ actionSlug: string; name: string; description: string; score: number }>;
  }>;
}> {
  const resolvedToolkit = await resolveToolkitSlug(toolkit);
  const suggestedBindings: Array<{ outcomeId: string; connector: string; capability: string; actionSlug: string; role?: "trigger" | "source" | "transform" | "destination" }> = [];
  const ambiguities: Array<{
    outcomeId: string;
    candidates: Array<{ actionSlug: string; name: string; description: string; score: number }>;
  }> = [];

  for (const outcome of outcomes) {
    const candidates = await rankBindingCandidates(resolvedToolkit, outcome.description, options);
    const explicitSlug = looksLikeComposioActionSlug(outcome.description) ? outcome.description.toUpperCase() : null;
    const eligibleCandidates = explicitSlug
      ? candidates.filter((candidate) => candidate.actionSlug.toUpperCase() === explicitSlug)
      : candidates;
    const top = eligibleCandidates[0];
    const close = top ? eligibleCandidates.filter((candidate) => candidate.score >= top.score - BINDING_AMBIGUITY_SCORE_GAP) : [];
    if (!explicitSlug && !options?.triggerFields && close.length > 1) {
      ambiguities.push({
        outcomeId: outcome.id,
        candidates: close.slice(0, 5).map((candidate) => ({
          actionSlug: candidate.actionSlug,
          name: candidate.name,
          description: candidate.description,
          score: candidate.score,
        })),
      });
      continue;
    }
    const recommended = pickRecommendedBinding(eligibleCandidates, options?.triggerFields);
    if (recommended) {
      const capability = capabilityForAction(recommended.actionSlug);
      suggestedBindings.push({
        outcomeId: outcome.id,
        connector: resolvedToolkit,
        capability,
        actionSlug: recommended.actionSlug,
        ...(outcome.role ? { role: outcome.role } : {}),
      });
    }
  }

  return {
    toolkit: resolvedToolkit,
    suggestedBindings,
    ambiguities,
  };
}
