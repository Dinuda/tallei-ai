import type { AuthContext } from "../domain/auth/index.js";
import { getConnectorProvider } from "../integrations/connectors/index.js";
import type { ConnectorToolkit } from "../integrations/connectors/index.js";
import { normalizeToolkitSlug } from "../integrations/composio/auth.js";
import { isKnownNoAuthToolkitSlug } from "../integrations/composio/toolkit-auth.js";
import type { ComposioToolSearchResult } from "@tallei/composio-tools/types.js";
import { scoreOutcomeRelevance } from "./binding-discovery.js";
import type { BindingAskOption } from "./binding-discovery.js";
import { scoreSchemaFieldRelevance } from "@tallei/composio-tools/tool-schema.js";
import type { OutcomeRole, TaskBlueprint } from "./spec.js";

export const TOP_CONNECTOR_RECOMMENDATIONS = 5;

export type ConnectorCandidate = {
  connector: string;
  name: string;
  connected: boolean;
  connectedAccountId?: string;
  connectable: boolean;
  requiresConnection?: boolean;
  score: number;
  rationale: string;
  sampleActions: string[];
};

export type ConnectorAskOption = BindingAskOption & {
  icon?: string;
  disabled?: boolean;
};

export type ConnectorDiscoveryResult = {
  outcomeDescription: string;
  role: string;
  candidates: ConnectorCandidate[];
  askOptions: ConnectorAskOption[];
  recommendedOptionIds: string[];
};

export const DEFAULT_CONNECTOR_PICK_QUESTION =
  "Which app should handle this workflow step?";

function outcomeSubject(description: string): string {
  const trimmed = description.trim().replace(/[?.!]+$/, "");
  const withoutLeadingVerb = trimmed
    .replace(/^(?:wait(?:s|ing)?\s+for\s+(?:a\s+|an\s+|the\s+)?)/i, "")
    .replace(/^(?:detects?|starts?|triggers?)\s+(?:when\s+)?/i, "")
    .replace(/^(?:monitors?|watches?)\s+(?:for\s+)?/i, "")
    .replace(/^(?:receives?|retrieves?|reads?|fetches?|gets?|loads?|finds?)\s+/i, "")
    .replace(/^(?:sends?|delivers?|publishes?|posts?|creates?|updates?)\s+/i, "")
    .replace(/^when\s+/i, "")
    .replace(/\s+to\s+arrive$/i, "");
  const withoutPassiveEvent = withoutLeadingVerb.replace(
    /\s+(?:is|are)\s+(?:submitted|received|created|added|sent|published|updated)$/i,
    "",
  );
  if (!withoutPassiveEvent) return "this workflow step";
  return withoutPassiveEvent.charAt(0).toLowerCase() + withoutPassiveEvent.slice(1);
}

export function connectorQuestionForOutcome(outcome: {
  role: OutcomeRole;
  description: string;
}): string {
  if (outcome.role === "trigger" || outcome.role === "source") {
    return `Where should ${outcomeSubject(outcome.description)} come from?`;
  }
  return `Where should ${outcomeSubject(outcome.description)} be delivered?`;
}

export type BlueprintConnectorDiscoveryResult = {
  groups: Array<{
    outcomeId: string;
    linkedOutcomeIds: string[];
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
  rejectedSelections?: Array<{
    outcomeId: string;
    role: OutcomeRole;
    connector: string;
    reason: string;
  }>;
  pickerKind: "app";
};

type ConnectorDiscoveryDependencies = {
  loadToolkits: (auth: AuthContext) => Promise<{ toolkits: ConnectorToolkit[]; total: number }>;
  searchTools: (query: string, limit?: number) => Promise<ComposioToolSearchResult[]>;
  loadActions: (toolkit: string) => Promise<ComposioToolSearchResult[]>;
  loadTriggers: (toolkit: string) => Promise<Array<{ slug: string; name: string }>>;
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
  loadActions: async (toolkit) => {
    const results = await getConnectorProvider().listActions(toolkit);
    return results.map((result) => ({
      ...result,
      toolkitName: result.toolkitName ?? result.toolkit,
      tags: result.tags ?? [],
    }));
  },
  loadTriggers: async (toolkit) => getConnectorProvider().listTriggers(toolkit),
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

function roleSearchHints(role: string): string {
  switch (role) {
    case "source":
      return "read fetch list search query database page document";
    case "destination":
      return "send create post publish deliver notify update";
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

function actionCanReadOutcome(
  outcomeDescription: string,
  action: Pick<ComposioToolSearchResult, "actionSlug" | "name" | "description" | "inputSchema">,
): boolean {
  const actionText = `${action.actionSlug} ${action.name} ${action.description}`;
  if (!/(?:^|[_\s-])(get|fetch|read|retrieve|list|search|find|load)(?:[_\s-]|$)/i.test(actionText)) {
    return false;
  }
  const semanticScore = scoreOutcomeRelevance(
    outcomeDescription,
    action.actionSlug,
    action.name,
    action.description,
    action.inputSchema ?? {},
  );
  // The LLM decides that the adjacent source is the trigger's initial read by
  // placing it directly after the trigger. The catalogue is the hard guard:
  // the selected connector must still expose a concrete read operation.
  return semanticScore > 0 || /\b(record|item|entry|details?|content|data)\b/i.test(actionText);
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
    description: candidate.requiresConnection === false
      ? "No sign-in needed"
      : candidate.connected
        ? "Already connected"
        : candidate.connectable
          ? "Needs connection"
          : "Unavailable — connection setup required",
    icon: candidate.connector.toLowerCase(),
    ...(!candidate.connected && !candidate.connectable ? { disabled: true } : {}),
  }));
}

export function buildConnectorRecommendedIds(
  askOptions: ConnectorAskOption[],
  limit = TOP_CONNECTOR_RECOMMENDATIONS,
): string[] {
  return askOptions.filter((option) => !option.disabled).slice(0, limit).map((option) => option.id);
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
  if (input.outcomes.every((outcome) => outcome.role === "transform")) {
    return { groups: [], autoResolved: [], pickerKind: "app" };
  }

  const dependencies = resolveDiscoveryDependencies(dependencyOverrides);
  const catalogueStartedAt = dependencies.now();
  const { toolkits } = await dependencies.loadToolkits(auth);
  const catalogueMs = dependencies.now() - catalogueStartedAt;

  const rejectedSelections: NonNullable<BlueprintConnectorDiscoveryResult["rejectedSelections"]> = [];
  const effectiveSelections = [] as NonNullable<typeof input.previousSelections>;
  const triggerCatalogues = new Map<string, Promise<Array<{ slug: string; name: string }>>>();
  for (const selection of input.previousSelections ?? []) {
    if (selection.role !== "trigger") {
      effectiveSelections.push(selection);
      continue;
    }
    const outcome = input.outcomes.find((candidate) => candidate.id === selection.outcomeId);
    if (!outcome) continue;
    const key = normalizeToolkitSlug(selection.connector);
    let loading = triggerCatalogues.get(key);
    if (!loading) {
      loading = dependencies.loadTriggers(selection.connector).catch((error) => {
        console.warn("[loops/connector-discovery] failed to load connector triggers", {
          connector: selection.connector,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
      triggerCatalogues.set(key, loading);
    }
    const triggers = await loading;
    const supportsTrigger = triggers.length > 0;
    if (supportsTrigger) {
      effectiveSelections.push(selection);
    } else {
      rejectedSelections.push({
        outcomeId: selection.outcomeId,
        role: selection.role,
        connector: selection.connector,
        reason: "This app does not expose an event matching the requested trigger",
      });
    }
  }
  const alreadySelected = new Set(effectiveSelections.map((selection) => selection.outcomeId));
  const pending = input.outcomes.filter((outcome) => outcome.role !== "transform" && !alreadySelected.has(outcome.id));
  if (pending.length === 0) {
    return {
      groups: [],
      autoResolved: [],
      ...(rejectedSelections.length > 0 ? { rejectedSelections } : {}),
      pickerKind: "app",
    };
  }

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
      // Keep the full ranked result for the searchable picker. Recommendation
      // badges are limited separately by buildConnectorRecommendedIds().
      limit: toolkits.length,
      includeAllCatalog: true,
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

  const actionCatalogues = new Map<string, Promise<ComposioToolSearchResult[]>>();
  const loadActionsOnce = async (connector: string): Promise<ComposioToolSearchResult[]> => {
    const key = normalizeToolkitSlug(connector);
    const existing = actionCatalogues.get(key);
    if (existing) return existing;
    const loading = dependencies.loadActions(connector).catch((error) => {
      console.warn("[loops/connector-discovery] failed to load connector actions", {
        connector,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
    actionCatalogues.set(key, loading);
    return loading;
  };

  // Action search is intentionally broad and capped, so it can omit a valid
  // read operation for the app the user just chose. Verify that exact app
  // against its full action catalogue before asking for the adjacent source.
  const verifiedInitialRead = new Map<string, { outcomeId: string; role: OutcomeRole; connector: string }>();
  for (let index = 0; index < pending.length; index++) {
    const outcome = pending[index]!;
    if (outcome.role !== "source") continue;
    const outcomeIndex = input.outcomes.findIndex((row) => row.id === outcome.id);
    const precedingTrigger = input.outcomes[outcomeIndex - 1];
    if (precedingTrigger?.role !== "trigger") continue;
    const selection = effectiveSelections.find((row) => row.outcomeId === precedingTrigger.id);
    if (!selection) continue;
    const actions = await loadActionsOnce(selection.connector);
    if (actions.some((action) => actionCanReadOutcome(outcome.description, action))) {
      verifiedInitialRead.set(outcome.id, selection);
    }
  }

  const autoResolved: BlueprintConnectorDiscoveryResult["autoResolved"] = [];
  const groups = discoveries.flatMap((discovery, index) => {
      const outcome = pending[index]!;
      const outcomeIndex = input.outcomes.findIndex((row) => row.id === outcome.id);
      const precedingTrigger = input.outcomes[outcomeIndex - 1];
      // Defer the initial read choice until the trigger app is selected. The
      // selected app alone is then checked for a matching read action.
      if (outcome.role === "source" && precedingTrigger?.role === "trigger"
        && !effectiveSelections.some((selection) => selection.outcomeId === precedingTrigger.id)) return [];
      const verifiedReadSelection = verifiedInitialRead.get(outcome.id);
      if (verifiedReadSelection) {
        autoResolved.push({
          outcomeId: outcome.id,
          role: outcome.role,
          connector: verifiedReadSelection.connector,
          sourceOutcomeId: verifiedReadSelection.outcomeId,
          sourceRole: verifiedReadSelection.role,
          reason: "same app as trigger",
        });
        return [];
      }
      const priorSelection = effectiveSelections
        .filter((selection) => input.outcomes.findIndex((row) => row.id === selection.outcomeId)
          < input.outcomes.findIndex((row) => row.id === outcome.id))
        .reverse()
        .find((selection) => discovery.candidates[0]?.connector.toLowerCase() === selection.connector.toLowerCase());
      const top = discovery.candidates[0];
      if (priorSelection && top && top.score > 0) {
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
      const reusableConnectors = effectiveSelections.length > 0
        ? effectiveSelections.map((selection) => selection.connector)
        : input.previousConnectors ?? [];
      const reusable = reusableConnectors.find((connector) =>
        discovery.candidates.some((candidate) =>
          candidate.connector.toLowerCase() === connector.toLowerCase() && candidate.score > 0,
        ),
      );
      const askOptions = discovery.askOptions;
      const reusableOptionId = reusable
        ? askOptions.find((option) => !option.disabled && option.value.toLowerCase() === reusable.toLowerCase())?.id
        : undefined;
      const connectedViableOptionIds = discovery.candidates.flatMap((candidate) => {
        if (!candidate.connected || candidate.score <= 0) return [];
        const option = askOptions.find((row) =>
          normalizeToolkitSlug(row.value) === normalizeToolkitSlug(candidate.connector) && !row.disabled);
        return option ? [option.id] : [];
      });
      const recommendedOptionIds = [
        ...(reusableOptionId ? [reusableOptionId] : []),
        ...connectedViableOptionIds,
        ...buildConnectorRecommendedIds(askOptions),
      ].filter((id, position, all) => all.indexOf(id) === position).slice(0, TOP_CONNECTOR_RECOMMENDATIONS);
      return [{
        outcomeId: outcome.id,
        linkedOutcomeIds: [],
        role: outcome.role,
        outcomeDescription: outcome.description,
        askOptions: askOptions.map((option) => ({
          ...option,
          outcomeId: outcome.id,
          role: outcome.role,
        })),
        recommendedOptionIds,
        defaultQuestion: connectorQuestionForOutcome(outcome),
      }];
    });
  return {
    groups,
    autoResolved,
    ...(rejectedSelections.length > 0 ? { rejectedSelections } : {}),
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
  includeAllCatalog?: boolean;
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

  const candidates: ConnectorCandidate[] = [];
  for (const toolkit of input.toolkits) {
    const slug = normalizeToolkitSlug(toolkit.slug);
    const match = scoresByToolkit.get(slug);
    const catalogScore = scoreOutcomeRelevance(
      input.outcomeDescription,
      toolkit.slug,
      toolkit.name,
      toolkit.description,
      {},
    );
    const baseScore = Math.max(match?.score ?? 0, catalogScore);
    if (baseScore <= 0 && input.role !== "trigger" && !input.includeAllCatalog) continue;

    const noAuth = isKnownNoAuthToolkitSlug(toolkit.slug)
      || toolkit.requiresConnection === false;
    candidates.push({
      connector: toolkit.slug,
      name: toolkit.name,
      connected: toolkit.connected || noAuth,
      connectable: toolkit.connected || toolkit.connectable !== false || noAuth,
      requiresConnection: !noAuth,
      ...(toolkit.connectedAccountId ? { connectedAccountId: toolkit.connectedAccountId } : {}),
      score: baseScore,
      rationale: buildRationale(toolkit.name, toolkit.connected || noAuth, match?.actions[0]),
      sampleActions: match?.actions.map((action) => action.actionSlug) ?? [],
    });
  }

  if (candidates.length === 0 && input.role === "trigger") {
    for (const toolkit of input.toolkits.slice(0, 6)) {
      const noAuth = isKnownNoAuthToolkitSlug(toolkit.slug)
        || toolkit.requiresConnection === false;
      candidates.push({
        connector: toolkit.slug,
        name: toolkit.name,
        connected: toolkit.connected || noAuth,
        connectable: toolkit.connected || toolkit.connectable !== false || noAuth,
        requiresConnection: !noAuth,
        ...(toolkit.connectedAccountId ? { connectedAccountId: toolkit.connectedAccountId } : {}),
        score: 1,
        rationale: buildRationale(toolkit.name, toolkit.connected || noAuth, undefined),
        sampleActions: [],
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || Number(b.connected) - Number(a.connected));
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
