import type { AuthContext } from "../domain/auth/index.js";
import { getConnectorProvider } from "../integrations/connectors/index.js";
import type { ConnectorToolkit } from "../integrations/connectors/index.js";
import { normalizeToolkitSlug } from "../integrations/composio/auth.js";
import type { ComposioToolSearchResult } from "../integrations/composio/types.js";
import { scoreOutcomeRelevance } from "./binding-discovery.js";
import type { BindingAskOption } from "./binding-discovery.js";
import { scoreSchemaFieldRelevance } from "./tool-schema.js";
import type { OutcomeRole, TaskBlueprint } from "./spec.js";

export const CONNECTED_TOOLKIT_BOOST = 4;
export const TOP_CONNECTOR_RECOMMENDATIONS = 5;
export const CONNECTOR_AUTO_RESOLVE_SCORE_GAP = 2;

export type ConnectorCandidate = {
  connector: string;
  name: string;
  connected: boolean;
  connectedAccountId?: string;
  score: number;
  rationale: string;
  sampleActions: string[];
};

export type ConnectorAskOption = BindingAskOption & {
  icon?: string;
};

export type ConnectorDiscoveryResult = {
  outcomeDescription: string;
  role: string;
  candidates: ConnectorCandidate[];
  askOptions: ConnectorAskOption[];
  recommendedOptionIds: string[];
};

export const DEFAULT_CONNECTOR_PICK_QUESTION =
  "Which app should power this loop? Triggers and actions are configured automatically after you pick.";

export type BlueprintConnectorDiscoveryResult = {
  groups: Array<{
    outcomeId: string;
    role: OutcomeRole;
    outcomeDescription: string;
    askOptions: ConnectorAskOption[];
    recommendedOptionIds: string[];
    defaultQuestion: string;
  }>;
  autoResolved: Array<{
    outcomeId: string;
    role: OutcomeRole;
    connector: string;
    sourceOutcomeId: string;
    sourceRole: OutcomeRole;
    reason: string;
  }>;
  pickerKind: "app";
};

type ConnectorDiscoveryDependencies = {
  loadToolkits: (auth: AuthContext) => Promise<{ toolkits: ConnectorToolkit[]; total: number }>;
  searchTools: (query: string, limit?: number) => Promise<ComposioToolSearchResult[]>;
  now: () => number;
  logTiming: (timing: ConnectorDiscoveryTiming) => void;
};

type ConnectorDiscoveryTiming = {
  catalogueMs: number;
  actionSearchMs: number;
  searchCount: number;
  outcomeCount: number;
};

const defaultDiscoveryDependencies: ConnectorDiscoveryDependencies = {
  loadToolkits: async (auth) => {
    const toolkits = await getConnectorProvider().listCatalogWithConnections(auth);
    return { toolkits, total: toolkits.length };
  },
  searchTools: async (query, limit) => {
    const results = await getConnectorProvider().searchActions(query, limit);
    return results.map((result) => ({
      ...result,
      toolkitName: result.toolkitName ?? result.toolkit,
      tags: result.tags ?? [],
    }));
  },
  now: Date.now,
  logTiming: (timing) => {
    console.info("[loops/connector-discovery] timing", timing);
  },
};

function resolveDiscoveryDependencies(
  overrides?: Partial<ConnectorDiscoveryDependencies>,
): ConnectorDiscoveryDependencies {
  return { ...defaultDiscoveryDependencies, ...overrides };
}

export function inferCatalogToolkitHints(
  outcomeDescription: string,
  role: string,
): string[] {
  const text = outcomeDescription.toLowerCase();
  const hints = new Set<string>();

  if (/(email|mail|inbox|message|reply|sender|gmail|outlook)/.test(text) || role === "trigger") {
    for (const slug of ["gmail", "outlook", "microsoftoutlook", "zendesk", "freshdesk", "intercom"]) {
      hints.add(slug);
    }
  }
  if (/(ticket|support|helpdesk)/.test(text)) {
    for (const slug of ["zendesk", "freshdesk", "intercom", "gmail", "outlook"]) hints.add(slug);
  }
  if (/(newsletter|mailchimp|campaign|subscribers)/.test(text)) {
    for (const slug of ["mailchimp", "gmail", "sendgrid", "brevo"]) hints.add(slug);
  }
  if (/(notion|doc|page|wiki|knowledge)/.test(text)) {
    for (const slug of ["notion", "googledocs", "confluence", "googledrive"]) hints.add(slug);
  }
  if (/(slack|channel|chat)/.test(text)) {
    for (const slug of ["slack", "discord", "microsoftteams"]) hints.add(slug);
  }
  if (/(search|web|news|research|ai)/.test(text) && role === "source") {
    hints.add("composio");
  }

  return [...hints];
}

function ensureHintCandidates(
  toolkits: ConnectorToolkit[],
  hints: string[],
  scoresByToolkit: Map<string, { score: number; actions: Array<{ actionSlug: string; name: string }> }>,
  role: string,
): void {
  const minScore = role === "trigger" ? 1 : 2;
  for (const hint of hints) {
    const normalized = normalizeToolkitSlug(hint);
    const toolkit = toolkits.find((row) => normalizeToolkitSlug(row.slug) === normalized);
    if (!toolkit) continue;
    const existing = scoresByToolkit.get(normalized);
    if (!existing) {
      scoresByToolkit.set(normalized, { score: minScore, actions: [] });
    } else if (existing.score < minScore) {
      existing.score = minScore;
    }
  }
}

function roleSearchHints(role: string): string {
  switch (role) {
    case "source":
      return "read fetch list search query database page document";
    case "destination":
      return "send post publish email newsletter message notify";
    case "trigger":
      return "webhook event new received created";
    case "transform":
      return "format summarize transform generate write";
    default:
      return "";
  }
}

function connectorSearchQuery(outcomeDescription: string, role: string): string {
  return `${outcomeDescription} ${roleSearchHints(role)}`.trim().replace(/\s+/g, " ");
}

function connectorSearchKey(query: string): string {
  return query.toLowerCase();
}

function buildRationale(
  toolkitName: string,
  connected: boolean,
  topAction: { actionSlug: string; name: string } | undefined,
): string {
  const actionNote = topAction
    ? `${topAction.actionSlug} (${topAction.name})`
    : "matching actions in catalogue";
  const connectionNote = connected ? "Already connected" : "Needs connection";
  return `${toolkitName}: ${actionNote}. ${connectionNote}.`;
}

function connectorOptionId(connector: string): string {
  return `connector-${connector.toLowerCase()}`;
}

export function buildConnectorAskOptions(candidates: ConnectorCandidate[]): ConnectorAskOption[] {
  return candidates.map((candidate) => ({
    id: connectorOptionId(candidate.connector),
    label: candidate.name,
    value: candidate.connector,
    description: candidate.connected ? "Already connected" : "Needs connection",
    icon: candidate.connector.toLowerCase(),
  }));
}

export function buildConnectorRecommendedIds(
  askOptions: ConnectorAskOption[],
  limit = TOP_CONNECTOR_RECOMMENDATIONS,
): string[] {
  return askOptions.slice(0, limit).map((option) => option.id);
}

export function applyConnectorSelectionsToBlueprint(
  blueprint: TaskBlueprint,
  selections: Array<{ outcomeId: string; connector: string }>,
): TaskBlueprint {
  const byOutcomeId = new Map(selections.map((row) => [row.outcomeId, row.connector]));
  return {
    ...blueprint,
    outcomes: blueprint.outcomes.map((outcome) => {
      const connector = byOutcomeId.get(outcome.id);
      if (!connector) return outcome;
      return {
        ...outcome,
        selectedConnector: connector,
        status: "chosen" as const,
      };
    }),
  };
}

export function applyPrimaryConnectorToBlueprint(
  blueprint: TaskBlueprint,
  connector: string,
): TaskBlueprint {
  return applyConnectorSelectionsToBlueprint(
    blueprint,
    blueprint.outcomes
      .filter((outcome) => outcome.role !== "transform" && outcome.status !== "chosen" && outcome.status !== "skipped")
      .map((outcome) => ({ outcomeId: outcome.id, connector })),
  );
}

export async function discoverConnectorsForBlueprint(
  auth: AuthContext,
  input: {
    outcomes: Array<{ id: string; role: OutcomeRole; description: string }>;
    previousConnectors?: string[];
    previousSelections?: Array<{ outcomeId: string; role: OutcomeRole; connector: string }>;
  },
  dependencyOverrides?: Partial<ConnectorDiscoveryDependencies>,
): Promise<BlueprintConnectorDiscoveryResult> {
  const alreadySelected = new Set((input.previousSelections ?? []).map((selection) => selection.outcomeId));
  const pending = input.outcomes.filter((outcome) => outcome.role !== "transform" && !alreadySelected.has(outcome.id));
  if (pending.length === 0) return { groups: [], autoResolved: [], pickerKind: "app" };

  const dependencies = resolveDiscoveryDependencies(dependencyOverrides);
  const catalogueStartedAt = dependencies.now();
  const { toolkits } = await dependencies.loadToolkits(auth);
  const catalogueMs = dependencies.now() - catalogueStartedAt;

  const searches = new Map<string, Promise<ComposioToolSearchResult[]>>();
  const actionSearchStartedAt = dependencies.now();
  const searchForOutcome = (outcome: (typeof pending)[number]): Promise<ComposioToolSearchResult[]> => {
    const query = connectorSearchQuery(outcome.description, outcome.role);
    const key = connectorSearchKey(query);
    const existing = searches.get(key);
    if (existing) return existing;
    const search = dependencies.searchTools(query, 32);
    searches.set(key, search);
    return search;
  };

  const discoveries = await Promise.all(
    pending.map(async (outcome) => rankConnectorsForOutcome({
      outcomeDescription: outcome.description,
      role: outcome.role,
      limit: TOP_CONNECTOR_RECOMMENDATIONS,
      toolkits,
      searchResults: await searchForOutcome(outcome),
    })),
  );
  dependencies.logTiming({
    catalogueMs,
    actionSearchMs: dependencies.now() - actionSearchStartedAt,
    searchCount: searches.size,
    outcomeCount: pending.length,
  });

  const autoResolved: BlueprintConnectorDiscoveryResult["autoResolved"] = [];
  const groups = discoveries.flatMap((discovery, index) => {
      const outcome = pending[index]!;
      const priorSelection = (input.previousSelections ?? [])
        .filter((selection) => input.outcomes.findIndex((row) => row.id === selection.outcomeId)
          < input.outcomes.findIndex((row) => row.id === outcome.id))
        .reverse()
        .find((selection) => discovery.candidates[0]?.connector.toLowerCase() === selection.connector.toLowerCase());
      const top = discovery.candidates[0];
      const runnerUp = discovery.candidates[1];
      const clearLead = Boolean(top && top.score > 0 && (!runnerUp || top.score - runnerUp.score >= CONNECTOR_AUTO_RESOLVE_SCORE_GAP));
      if (priorSelection && top && clearLead) {
        autoResolved.push({
          outcomeId: outcome.id,
          role: outcome.role,
          connector: top.connector,
          sourceOutcomeId: priorSelection.outcomeId,
          sourceRole: priorSelection.role,
          reason: `same app as ${priorSelection.role}`,
        });
        return [];
      }
      const reusable = (input.previousSelections?.map((selection) => selection.connector)
        ?? input.previousConnectors ?? []).find((connector) =>
        discovery.candidates.some((candidate) =>
          candidate.connector.toLowerCase() === connector.toLowerCase() && candidate.score > 0,
        ),
      );
      const reusableOptionId = reusable
        ? discovery.askOptions.find((option) => option.value.toLowerCase() === reusable.toLowerCase())?.id
        : undefined;
      const recommendedOptionIds = [
        ...(reusableOptionId ? [reusableOptionId] : []),
        ...discovery.recommendedOptionIds,
      ].filter((id, position, all) => all.indexOf(id) === position).slice(0, TOP_CONNECTOR_RECOMMENDATIONS);
      return [{
        outcomeId: outcome.id,
        role: outcome.role,
        outcomeDescription: outcome.description,
        askOptions: discovery.askOptions.map((option) => ({
          ...option,
          outcomeId: outcome.id,
          role: outcome.role,
        })),
        recommendedOptionIds,
        defaultQuestion: `Which app should handle ${outcome.description}?`,
      }];
    });
  return {
    groups,
    autoResolved,
    pickerKind: "app",
  };
}

export async function discoverConnectorsForOutcome(
  auth: AuthContext,
  input: {
    outcomeDescription: string;
    role: "trigger" | "source" | "transform" | "destination";
    limit?: number;
  },
  dependencyOverrides?: Partial<ConnectorDiscoveryDependencies>,
): Promise<ConnectorDiscoveryResult> {
  const dependencies = resolveDiscoveryDependencies(dependencyOverrides);
  const { toolkits } = await dependencies.loadToolkits(auth);
  const searchQuery = connectorSearchQuery(input.outcomeDescription, input.role);
  const searchResults = await dependencies.searchTools(searchQuery, 32);
  return rankConnectorsForOutcome({ ...input, toolkits, searchResults });
}

function rankConnectorsForOutcome(input: {
  outcomeDescription: string;
  role: "trigger" | "source" | "transform" | "destination";
  limit?: number;
  toolkits: ConnectorToolkit[];
  searchResults: ComposioToolSearchResult[];
}): ConnectorDiscoveryResult {
  const limit = Math.max(2, input.limit ?? TOP_CONNECTOR_RECOMMENDATIONS);
  const scoresByToolkit = new Map<string, { score: number; actions: Array<{ actionSlug: string; name: string }> }>();

  for (const result of input.searchResults) {
    const slug = normalizeToolkitSlug(result.toolkit);
    const inputSchema = result.inputSchema ?? {};
    const actionScore = scoreOutcomeRelevance(
      input.outcomeDescription,
      result.actionSlug,
      result.name,
      result.description,
      inputSchema,
    ) + scoreSchemaFieldRelevance(input.outcomeDescription, inputSchema);
    if (actionScore <= 0) continue;
    const existing = scoresByToolkit.get(slug);
    const row = existing ?? { score: 0, actions: [] };
    row.score = Math.max(row.score, actionScore);
    if (row.actions.length < 3) {
      row.actions.push({ actionSlug: result.actionSlug, name: result.name });
    }
    scoresByToolkit.set(slug, row);
  }

  ensureHintCandidates(
    input.toolkits,
    inferCatalogToolkitHints(input.outcomeDescription, input.role),
    scoresByToolkit,
    input.role,
  );

  const candidates: ConnectorCandidate[] = [];
  for (const toolkit of input.toolkits) {
    const slug = normalizeToolkitSlug(toolkit.slug);
    const match = scoresByToolkit.get(slug);
    const baseScore = match?.score ?? 0;
    if (baseScore <= 0 && input.role !== "trigger") continue;

    const finalScore = baseScore + (toolkit.connected ? CONNECTED_TOOLKIT_BOOST : 0);
    candidates.push({
      connector: toolkit.slug,
      name: toolkit.name,
      connected: toolkit.connected,
      ...(toolkit.connectedAccountId ? { connectedAccountId: toolkit.connectedAccountId } : {}),
      score: finalScore,
      rationale: buildRationale(toolkit.name, toolkit.connected, match?.actions[0]),
      sampleActions: match?.actions.map((action) => action.actionSlug) ?? [],
    });
  }

  if (candidates.length === 0 && input.role === "trigger") {
    for (const toolkit of input.toolkits.filter((row) => row.connected).slice(0, 6)) {
      candidates.push({
        connector: toolkit.slug,
        name: toolkit.name,
        connected: true,
        ...(toolkit.connectedAccountId ? { connectedAccountId: toolkit.connectedAccountId } : {}),
        score: CONNECTED_TOOLKIT_BOOST,
        rationale: buildRationale(toolkit.name, true, undefined),
        sampleActions: [],
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const ranked = candidates.slice(0, limit);
  const askOptions = buildConnectorAskOptions(ranked);
  const recommendedOptionIds = buildConnectorRecommendedIds(askOptions);

  return {
    outcomeDescription: input.outcomeDescription,
    role: input.role,
    candidates: ranked,
    askOptions,
    recommendedOptionIds,
  };
}
