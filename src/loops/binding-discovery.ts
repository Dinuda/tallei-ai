import { getAllTools, searchTools } from "../integrations/composio/tools.js";
import { normalizeToolkitSlug, resolveToolkitSlug } from "../integrations/composio/auth.js";
import {
  capabilityForAction,
  scoreSchemaFieldRelevance,
  scoreTriggerFieldOverlap,
  summarizeInputSchema,
  type SchemaFieldSummary,
} from "./tool-schema.js";

export const MIN_CAPABILITY_SCORE = 2;
/** Top candidates within this score gap are treated as ambiguous (user picks outcome-framed option). */
export const BINDING_AMBIGUITY_SCORE_GAP = 1;

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
    const tools = await getAllTools(normalizedConnector);
    const direct = tools.find((tool) => tool.actionSlug.toUpperCase() === outcomeDescription.toUpperCase());
    if (direct) {
      mergeCandidates(byAction, toCandidate(direct, MIN_CAPABILITY_SCORE + 4));
    }
  }

  const searchResults = await searchTools(`${normalizedConnector} ${outcomeDescription}`, 24);
  for (const result of searchResults) {
    if (normalizeToolkitSlug(result.toolkit) !== normalizeToolkitSlug(normalizedConnector)) continue;
    const score = scoreAction(outcomeDescription, result, triggerFields);
    if (score <= 0) continue;
    mergeCandidates(byAction, toCandidate(result, score));
  }

  const toolkitTools = await getAllTools(normalizedConnector);
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
  const tools = await getAllTools(normalizedConnector);
  const scopedResolution = selectExplicitBindingAction({
    connector: normalizedConnector,
    actionSlug,
    scopedTools: tools,
    globalMatches: [],
  });
  if (scopedResolution.ok) return scopedResolution;

  const globalMatches = await searchTools(actionSlug, 50);
  return selectExplicitBindingAction({
    connector: normalizedConnector,
    actionSlug,
    scopedTools: tools,
    globalMatches,
  });
}

export async function discoverOutcomeBindings(
  toolkit: string,
  outcomes: Array<{ id: string; description: string; role?: "trigger" | "source" | "transform" | "destination" }>,
  options?: { triggerFields?: Record<string, unknown> },
): Promise<{
  toolkit: string;
  suggestedBindings: Array<{ outcomeId: string; connector: string; capability: string; actionSlug: string; role?: "trigger" | "source" | "transform" | "destination" }>;
}> {
  const resolvedToolkit = await resolveToolkitSlug(toolkit);
  const suggestedBindings: Array<{ outcomeId: string; connector: string; capability: string; actionSlug: string; role?: "trigger" | "source" | "transform" | "destination" }> = [];

  for (const outcome of outcomes) {
    const candidates = await rankBindingCandidates(resolvedToolkit, outcome.description, options);
    const recommended = pickRecommendedBinding(candidates, options?.triggerFields);
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
  };
}
