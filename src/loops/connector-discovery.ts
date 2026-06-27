import type { AuthContext } from "../domain/auth/index.js";
import { listAllToolkitsWithStatus } from "../integrations/composio/accounts.js";
import { normalizeToolkitSlug } from "../integrations/composio/auth.js";
import { searchTools } from "../integrations/composio/tools.js";
import {
  combinedCapabilityScore,
  suggestCapabilityLabel,
} from "./binding-discovery.js";
import type { BindingAskOption } from "./binding-discovery.js";
import type { OutcomeRole, TaskBlueprint } from "./spec.js";

export const CONNECTED_TOOLKIT_BOOST = 4;
export const TOP_CONNECTOR_RECOMMENDATIONS = 5;

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
  suggestedCapability: string;
  candidates: ConnectorCandidate[];
  askOptions: ConnectorAskOption[];
  recommendedOptionIds: string[];
};

export const DEFAULT_CONNECTOR_PICK_QUESTION =
  "Which app should power this loop? Triggers and actions are configured automatically after you pick.";

export type BlueprintConnectorDiscoveryResult = {
  askOptions: ConnectorAskOption[];
  recommendedOptionIds: string[];
  defaultQuestion: string;
  pickerKind: "app";
};

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
  toolkits: Awaited<ReturnType<typeof listAllToolkitsWithStatus>>["toolkits"],
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
  },
): Promise<BlueprintConnectorDiscoveryResult> {
  const pending = input.outcomes.filter((outcome) => outcome.role !== "transform");

  const discoveries = await Promise.all(
    pending.map(async (outcome) => discoverConnectorsForOutcome(auth, {
      outcomeDescription: outcome.description,
      role: outcome.role,
      limit: 12,
    })),
  );

  const byConnector = new Map<string, ConnectorCandidate>();
  for (const discovery of discoveries) {
    for (const candidate of discovery.candidates) {
      const key = candidate.connector.toLowerCase();
      const existing = byConnector.get(key);
      if (!existing || candidate.score > existing.score) {
        byConnector.set(key, candidate);
      }
    }
  }

  const ranked = [...byConnector.values()].sort((a, b) => b.score - a.score);
  const askOptions = buildConnectorAskOptions(ranked);
  const recommendedOptionIds = buildConnectorRecommendedIds(askOptions);

  return {
    askOptions,
    recommendedOptionIds,
    defaultQuestion: DEFAULT_CONNECTOR_PICK_QUESTION,
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
): Promise<ConnectorDiscoveryResult> {
  const limit = Math.max(3, Math.min(input.limit ?? 8, 12));
  const { toolkits } = await listAllToolkitsWithStatus(auth);
  const suggestedCapability = suggestCapabilityLabel(input.outcomeDescription);
  const searchQuery = `${input.outcomeDescription} ${roleSearchHints(input.role)}`.trim();

  const searchResults = await searchTools(searchQuery, 32);
  const scoresByToolkit = new Map<string, { score: number; actions: Array<{ actionSlug: string; name: string }> }>();

  for (const result of searchResults) {
    const slug = normalizeToolkitSlug(result.toolkit);
    const actionScore = combinedCapabilityScore(
      suggestedCapability,
      result.actionSlug,
      result.name,
      result.description,
      result.inputSchema ?? {},
    );
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
    toolkits,
    inferCatalogToolkitHints(input.outcomeDescription, input.role),
    scoresByToolkit,
    input.role,
  );

  const candidates: ConnectorCandidate[] = [];
  for (const toolkit of toolkits) {
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
    for (const toolkit of toolkits.filter((row) => row.connected).slice(0, 6)) {
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
    suggestedCapability,
    candidates: ranked,
    askOptions,
    recommendedOptionIds,
  };
}
