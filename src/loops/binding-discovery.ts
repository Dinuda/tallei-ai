import { getAllTools, searchTools } from "../integrations/composio/tools.js";
import { normalizeToolkitSlug, resolveToolkitSlug } from "../integrations/composio/auth.js";
import { summarizeInputSchema, scoreSchemaFitForCapability, semanticCapabilityForAction, type SchemaFieldSummary } from "./tool-schema.js";
import { buildComposioActionInstruction } from "./composio-action-instructions.js";
import type { ComposioActionInstruction } from "./spec.js";

export const MIN_CAPABILITY_SCORE = 2;
/** Top candidates within this score gap are treated as ambiguous (user picks outcome-framed option). */
export const BINDING_AMBIGUITY_SCORE_GAP = 1;

export type BindingFamily = "read_single" | "read_batch" | "send" | "draft" | "label" | "other";

export function bindingFamily(actionSlug: string): BindingFamily {
  const slug = actionSlug.toUpperCase();
  if (slug.includes("DRAFT")) return "draft";
  if (slug.includes("SEND") || slug.includes("REPLY")) return "send";
  if (slug.includes("LABEL") || slug.includes("TAG") || slug.includes("CATEGOR")) return "label";
  if (
    slug.includes("MESSAGE_ID")
    || slug.includes("BY_ID")
    || (slug.includes("GET") && slug.includes("MESSAGE"))
    || (slug.includes("FETCH") && slug.includes("MESSAGE") && !slug.includes("MESSAGES"))
  ) {
    return "read_single";
  }
  if (slug.includes("LIST") || slug.includes("SEARCH") || slug.includes("QUERY") || slug.includes("FILTER")) {
    return "read_batch";
  }
  if (slug.includes("FETCH") || slug.includes("READ") || slug.includes("GET")) return "read_single";
  return "other";
}

export function bindingFamilyLabel(family: BindingFamily): string {
  switch (family) {
    case "read_single": return "open one specific message";
    case "read_batch": return "search or list multiple messages";
    case "send": return "send a message";
    case "draft": return "create a draft";
    case "label": return "apply labels or categories";
    default: return "use this action";
  }
}

/** True when close-scoring candidates represent a real business fork (not API implementation detail). */
export function isMaterialBusinessFork(candidates: BindingCandidate[]): boolean {
  const ranked = candidates
    .filter((candidate) => candidate.score >= MIN_CAPABILITY_SCORE)
    .sort((a, b) => b.score - a.score);
  if (ranked.length < 2) return false;
  if (ranked[0]!.score - ranked[1]!.score > BINDING_AMBIGUITY_SCORE_GAP) return false;

  const topFamilies = [...new Set(ranked.slice(0, 3).map((c) => bindingFamily(c.actionSlug)))];

  // Fetch-by-id vs search-inbox is an implementation detail — auto-resolve.
  if (
    topFamilies.length === 2
    && topFamilies.includes("read_single")
    && topFamilies.includes("read_batch")
  ) {
    return false;
  }

  // Send now vs draft-first materially changes what the loop does.
  if (topFamilies.includes("send") && topFamilies.includes("draft")) return true;

  // Two unrelated action families with tied scores — only ask if both are user-meaningful verbs.
  const userMeaningful = new Set<BindingFamily>(["send", "draft", "label"]);
  const meaningfulInTop = topFamilies.filter((family) => userMeaningful.has(family));
  return meaningfulInTop.length >= 2;
}

export function alignCapabilityWithAction(
  capability: string,
  actionSlug: string,
  inputSchema: Record<string, unknown>,
  outcomeDescription?: string,
): string {
  const domain = inferCapabilityDomain(outcomeDescription?.toLowerCase() ?? "", undefined)
    || capability.split(".")[0]
    || "tool";
  const aligned = semanticCapabilityForAction(actionSlug, inputSchema, domain);
  if (scoreSchemaFitForCapability(capability, inputSchema, actionSlug) >= 0) {
    return capability;
  }
  if (scoreSchemaFitForCapability(aligned, inputSchema, actionSlug) >= 0) {
    return aligned;
  }
  return aligned;
}

export function pickRecommendedBinding(
  candidates: BindingCandidate[],
  outcomeDescription: string,
): BindingCandidate | null {
  const ranked = candidates
    .filter((candidate) => candidate.score >= MIN_CAPABILITY_SCORE)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;

  const outcomeLower = outcomeDescription.toLowerCase();
  const wantsBatch = /batch|search|filter|list all|query|multiple|inbox sweep/.test(outcomeLower);
  const wantsEvent = /incoming|new |each |trigger|when |received|that triggered|specific/.test(outcomeLower);

  const byFamily = ranked.map((candidate) => ({
    candidate,
    family: bindingFamily(candidate.actionSlug),
  }));

  const hasSingle = byFamily.some((row) => row.family === "read_single");
  const hasBatch = byFamily.some((row) => row.family === "read_batch");
  if (hasSingle && hasBatch) {
    if (wantsBatch) {
      return byFamily.find((row) => row.family === "read_batch")?.candidate ?? ranked[0]!;
    }
    if (wantsEvent) {
      return byFamily.find((row) => row.family === "read_single")?.candidate ?? ranked[0]!;
    }
    // Default for per-ticket / event loops: read the triggering message.
    return byFamily.find((row) => row.family === "read_single")?.candidate ?? ranked[0]!;
  }

  return ranked[0]!;
}

export type BindingCandidate = {
  capability: string;
  actionSlug: string;
  name: string;
  description: string;
  score: number;
  schemaSummary: SchemaFieldSummary;
};

export type BindingAskOption = {
  id: string;
  label: string;
  value: string;
  description: string;
};

export type OutcomeDiscovery = {
  outcomeId: string;
  outcome: string;
  suggestedCapability: string;
  recommended: BindingCandidate | null;
  alternatives: BindingCandidate[];
  ambiguous: boolean;
  askOptions: BindingAskOption[];
};

export function scoreToolForCapability(
  capability: string,
  actionSlug: string,
  name: string,
  description: string,
): number {
  const capTokens = capability.split(/[._]/).filter(Boolean).map((token) => token.toLowerCase());
  const slugParts = actionSlug.toLowerCase().split(/[._]+/).filter(Boolean);
  const haystack = `${actionSlug} ${name} ${description}`.toLowerCase();
  return capTokens.reduce((score, token) => {
    if (!token) return score;
    if (haystack.includes(token)) return score + 1;
    if (slugParts.some((part) => part.includes(token) || token.includes(part))) return score + 1;
    return score;
  }, 0);
}

export function looksLikeComposioActionSlug(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value.trim());
}

export function combinedCapabilityScore(
  capability: string,
  actionSlug: string,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): number {
  return scoreToolForCapability(capability, actionSlug, name, description)
    + scoreSchemaFitForCapability(capability, inputSchema);
}

/** Derive an outcome-based capability label for spec bindings from natural language. */
export function suggestCapabilityLabel(outcomeDescription: string, toolkit?: string): string {
  const lower = outcomeDescription.toLowerCase();
  const domain = inferCapabilityDomain(lower, toolkit);

  if (/(draft)/.test(lower)) return `${domain}.draft`;
  if (/(label|tag|categor|priorit)/.test(lower)) return `${domain}.labels`;
  if (/(send|reply|post|notify)/.test(lower)) return `${domain}.send`;
  if (/(read|fetch|list|incoming|inbox|search|find|pull)/.test(lower)) return `${domain}.read`;
  if (/(create|write|update|sync)/.test(lower)) return `${domain}.write`;
  if (/(delete|remove)/.test(lower)) return `${domain}.delete`;

  const slug = lower
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .slice(0, 3)
    .join(".");
  return slug ? `${domain}.${slug}` : `${domain}.action`;
}

function inferCapabilityDomain(outcomeLower: string, toolkit?: string): string {
  if (toolkit) {
    const normalized = normalizeToolkitSlug(toolkit);
    if (normalized.includes("gmail") || normalized.includes("outlook") || normalized.includes("mail")) return "email";
    if (normalized.includes("slack")) return "chat";
    if (normalized.includes("hubspot") || normalized.includes("salesforce")) return "crm";
    if (normalized.includes("zendesk")) return "support";
  }
  if (/(email|mail|inbox|message\.received)/.test(outcomeLower)) return "email";
  if (/(slack|channel|chat)/.test(outcomeLower)) return "chat";
  if (/(ticket|support|zendesk)/.test(outcomeLower)) return "support";
  if (/(crm|contact|deal|lead|hubspot|salesforce)/.test(outcomeLower)) return "crm";
  if (/(calendar|meeting|event)/.test(outcomeLower)) return "calendar";
  return "tool";
}

const STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "that", "this", "into", "when", "each", "agent", "loop",
]);

function toCandidate(
  capability: string,
  action: { actionSlug: string; name: string; description: string; inputSchema?: Record<string, unknown> },
  score: number,
): BindingCandidate {
  const inputSchema = action.inputSchema ?? {};
  return {
    capability,
    actionSlug: action.actionSlug,
    name: action.name,
    description: action.description,
    score,
    schemaSummary: summarizeInputSchema(inputSchema),
  };
}

function mergeCandidates(existing: Map<string, BindingCandidate>, candidate: BindingCandidate): void {
  const key = candidate.actionSlug.toUpperCase();
  const prior = existing.get(key);
  if (!prior || candidate.score > prior.score) {
    existing.set(key, candidate);
  }
}

export function isAmbiguousBindingChoice(candidates: BindingCandidate[]): boolean {
  return isMaterialBusinessFork(candidates);
}

export function outcomeFramedOptionLabel(candidate: BindingCandidate): string {
  const slug = candidate.actionSlug.toUpperCase();
  const family = bindingFamily(candidate.actionSlug);

  if (family === "draft") return "Create a draft first, then review";
  if (family === "send") return "Send immediately";
  if (family === "label") return "Apply labels or categories";
  if (family === "read_single") {
    if (slug.includes("MESSAGE_ID") || slug.includes("BY_ID")) {
      return "Open the email that triggered this loop";
    }
    return "Read one specific message";
  }
  if (family === "read_batch") {
    return "Search your inbox for matching emails";
  }
  if (slug.includes("SEARCH")) return "Search and find matching items";
  return candidate.name.trim() || bindingFamilyLabel(family);
}

export function outcomeFramedOptionDescription(candidate: BindingCandidate): string {
  const family = bindingFamily(candidate.actionSlug);
  switch (family) {
    case "read_single":
      return "Best when the loop runs on each new incoming message — opens that one email.";
    case "read_batch":
      return "Best when you want to scan or batch-process multiple emails at once.";
    case "send":
      return "Deliver the reply right away without a draft step.";
    case "draft":
      return "Save a draft for review before anything is sent.";
    case "label":
      return "Tag or categorize items (for example priority or category labels).";
    default:
      return (candidate.description || candidate.name).trim() || bindingFamilyLabel(family);
  }
}

export function buildAmbiguityAskOptions(candidates: BindingCandidate[]): BindingAskOption[] {
  const ranked = candidates
    .filter((candidate) => candidate.score >= MIN_CAPABILITY_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return ranked.map((candidate, index) => ({
    id: `binding-${candidate.actionSlug.toLowerCase()}`,
    label: outcomeFramedOptionLabel(candidate),
    value: candidate.capability,
    description: outcomeFramedOptionDescription(candidate),
  }));
}

export async function rankBindingCandidates(
  connector: string,
  outcomeDescription: string,
  capabilityLabel?: string,
): Promise<BindingCandidate[]> {
  const normalizedConnector = await resolveToolkitSlug(connector);
  const capability = (capabilityLabel ?? suggestCapabilityLabel(outcomeDescription, normalizedConnector)).trim();
  const byAction = new Map<string, BindingCandidate>();

  if (looksLikeComposioActionSlug(capability)) {
    const tools = await getAllTools(normalizedConnector);
    const direct = tools.find((tool) => tool.actionSlug.toUpperCase() === capability.toUpperCase());
    if (direct) {
      mergeCandidates(byAction, toCandidate(capability, direct, MIN_CAPABILITY_SCORE + 4));
    }
  }

  const searchQuery = `${normalizedConnector} ${outcomeDescription} ${capability.replace(/\./g, " ")}`.trim();
  const searchResults = await searchTools(searchQuery, 24);
  for (const result of searchResults) {
    if (normalizeToolkitSlug(result.toolkit) !== normalizeToolkitSlug(normalizedConnector)) continue;
    const score = combinedCapabilityScore(
      capability,
      result.actionSlug,
      result.name,
      result.description,
      result.inputSchema ?? {},
    );
    if (score <= 0) continue;
    mergeCandidates(byAction, toCandidate(capability, result, score));
  }

  const toolkitTools = await getAllTools(normalizedConnector);
  for (const tool of toolkitTools) {
    const score = combinedCapabilityScore(
      capability,
      tool.actionSlug,
      tool.name,
      tool.description,
      tool.inputSchema ?? {},
    );
    if (score <= 0) continue;
    mergeCandidates(byAction, toCandidate(capability, tool, score));
  }

  return [...byAction.values()]
    .filter((candidate) => candidate.score >= MIN_CAPABILITY_SCORE)
    .sort((a, b) => b.score - a.score);
}

export async function resolveBindingAction(
  connector: string,
  capability: string,
): Promise<{ actionSlug: string; inputSchema: Record<string, unknown>; toolkitVersion?: string } | null> {
  const normalizedConnector = await resolveToolkitSlug(connector);
  const capabilityTrimmed = capability.trim();

  if (looksLikeComposioActionSlug(capabilityTrimmed)) {
    const tools = await getAllTools(normalizedConnector);
    const direct = tools.find((tool) => tool.actionSlug.toUpperCase() === capabilityTrimmed.toUpperCase());
    if (direct) {
      return {
        actionSlug: direct.actionSlug,
        inputSchema: direct.inputSchema ?? {},
        ...(direct.toolkitVersion ? { toolkitVersion: direct.toolkitVersion } : {}),
      };
    }
  }

  const candidates = await rankBindingCandidates(connector, capabilityTrimmed, capabilityTrimmed);
  const best = candidates[0];
  if (!best) return null;

  const toolkitTools = await getAllTools(normalizedConnector);
  const matched = toolkitTools.find((tool) => tool.actionSlug.toUpperCase() === best.actionSlug.toUpperCase());
  return {
    actionSlug: best.actionSlug,
    inputSchema: matched?.inputSchema ?? {},
    ...(matched?.toolkitVersion ? { toolkitVersion: matched.toolkitVersion } : {}),
  };
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
): Promise<{
  toolkit: string;
  outcomes: OutcomeDiscovery[];
  suggestedBindings: Array<{ outcomeId: string; connector: string; capability: string; actionSlug: string; role?: "trigger" | "source" | "transform" | "destination" }>;
  suggestedComposioActions: ComposioActionInstruction[];
  needsUserChoice: boolean;
}> {
  const resolvedToolkit = await resolveToolkitSlug(toolkit);
  const discoveries: OutcomeDiscovery[] = [];
  const suggestedBindings: Array<{ outcomeId: string; connector: string; capability: string; actionSlug: string; role?: "trigger" | "source" | "transform" | "destination" }> = [];
  const suggestedComposioActions: ComposioActionInstruction[] = [];
  let needsUserChoice = false;

  for (const outcome of outcomes) {
    const suggestedCapability = suggestCapabilityLabel(outcome.description, resolvedToolkit);
    const candidates = await rankBindingCandidates(resolvedToolkit, outcome.description, suggestedCapability);
    const ambiguous = isMaterialBusinessFork(candidates);
    const recommended = ambiguous
      ? null
      : pickRecommendedBinding(candidates, outcome.description);
    const askOptions = ambiguous ? buildAmbiguityAskOptions(candidates) : [];

    if (ambiguous) {
      needsUserChoice = true;
    } else if (recommended) {
      const toolkitTools = await getAllTools(resolvedToolkit);
      const matched = toolkitTools.find((tool) => tool.actionSlug.toUpperCase() === recommended.actionSlug.toUpperCase());
      const inputSchema = matched?.inputSchema ?? {};
      suggestedBindings.push({
        outcomeId: outcome.id,
        connector: resolvedToolkit,
        capability: alignCapabilityWithAction(
          recommended.capability,
          recommended.actionSlug,
          inputSchema,
          outcome.description,
        ),
        actionSlug: recommended.actionSlug,
        ...(outcome.role ? { role: outcome.role } : {}),
      });
      suggestedComposioActions.push(buildComposioActionInstruction({
        toolkit: resolvedToolkit,
        actionSlug: recommended.actionSlug,
        label: recommended.capability,
        inputSchema,
        outputSchema: matched?.outputSchema,
      }));
    }

    discoveries.push({
      outcomeId: outcome.id,
      outcome: outcome.description,
      suggestedCapability,
      recommended,
      alternatives: candidates.slice(1, 4),
      ambiguous,
      askOptions,
    });
  }

  return {
    toolkit: resolvedToolkit,
    outcomes: discoveries,
    suggestedBindings,
    suggestedComposioActions,
    needsUserChoice,
  };
}
