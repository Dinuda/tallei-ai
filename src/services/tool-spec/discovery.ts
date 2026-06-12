import type { AuthContext } from "../../domain/auth/index.js";
import { connectedAppToolkits, listConnectorAccounts, searchComposioTools } from "../connectors/composio.js";
import {
  buildComposioActionContract,
  connectorActionToolRef,
  hasExactComposioActionSchemas,
  parseConnectorActionToolRef,
} from "./tool-contracts.js";
import { searchLearnedToolSpecs } from "./learned-catalog.js";
import type { ToolContract } from "./types.js";

export type DiscoveredToolContract = {
  contract: ToolContract;
  connected: boolean;
  source: "composio_search" | "learned_catalog" | "required_spec";
};

export type InferredConnectorAction = {
  toolkit: string;
  actionSlug: string;
  risk: string;
  description?: string;
};

function actionSlugFromRef(actionSlug: string): string {
  return actionSlug.replace(/\./g, "_").toUpperCase();
}

/** Infer delivery connector actions from approved spec delivery fields and the user prompt. */
export function inferRequiredConnectorActions(input: {
  prompt: string;
  deliveryProvider?: string;
  deliveryDescription?: string;
  intentText?: string;
}): InferredConnectorAction[] {
  const provider = input.deliveryProvider?.trim() ?? "";
  const parsedProvider = provider && provider.toLowerCase() !== "none"
    ? parseConnectorActionToolRef(provider)
    : null;
  if (parsedProvider) {
    return [{
      toolkit: parsedProvider.toolkit,
      actionSlug: actionSlugFromRef(parsedProvider.actionSlug),
      risk: "send",
      description: input.deliveryDescription,
    }];
  }

  const text = [input.prompt, input.deliveryDescription, input.intentText]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .toLowerCase();
  if (!text.trim()) return [];

  if (/\bresend\b/.test(text)) {
    return [{ toolkit: "resend", actionSlug: "RESEND_SEND_EMAIL", risk: "send" }];
  }
  const sendsEmail = /\b(send|deliver|broadcast|distribute|publish)\b/.test(text)
    && /\b(email|newsletter|inbox|mail)\b/.test(text);
  if (/\bgmail\b/.test(text) || sendsEmail) {
    return [{ toolkit: "gmail", actionSlug: "GMAIL_SEND_EMAIL", risk: "send" }];
  }
  return [];
}

export function discoveryQueriesForRequiredActions(
  queries: string[],
  requiredActions: InferredConnectorAction[],
): string[] {
  const merged = [...queries];
  for (const action of requiredActions) {
    const capabilityQuery = `${action.toolkit} send email`.trim();
    if (merged.some((query) => query.toLowerCase().includes(action.toolkit.toLowerCase()))) continue;
    merged.push(capabilityQuery);
  }
  return [...new Set(merged.map((query) => query.trim()).filter(Boolean))].slice(0, 4);
}

export function interleaveDiscoveredToolResults(
  resultSets: DiscoveredToolContract[][],
  limit: number,
): DiscoveredToolContract[] {
  const merged = new Map<string, DiscoveredToolContract>();
  const maxLength = Math.max(0, ...resultSets.map((entries) => entries.length));
  for (let index = 0; index < maxLength && merged.size < limit; index += 1) {
    for (const entries of resultSets) {
      const entry = entries[index];
      if (!entry) continue;
      const key = entry.contract.toolRef.toLowerCase();
      const existing = merged.get(key);
      if (!existing || (existing.source === "learned_catalog" && entry.source === "composio_search")) {
        merged.set(key, entry);
      }
      if (merged.size >= limit) break;
    }
  }
  return [...merged.values()];
}

export async function mergeRequiredToolContracts(
  discovered: DiscoveredToolContract[],
  requiredActions: Array<{ toolkit: string; actionSlug: string; risk: string; description?: string }>,
): Promise<DiscoveredToolContract[]> {
  const merged = new Map(discovered.map((entry) => [entry.contract.toolRef.toLowerCase(), entry]));
  for (const action of requiredActions) {
    const toolRef = connectorActionToolRef(action).toLowerCase();
    if (merged.has(toolRef)) continue;
    const [sdkResults, learnedResults] = await Promise.all([
      searchComposioTools(`${action.toolkit} ${action.actionSlug}`, 50),
      searchLearnedToolSpecs(`${action.toolkit} ${action.actionSlug}`, 50),
    ]);
    const exactSdk = sdkResults.find((candidate) =>
      candidate.toolkit.toLowerCase() === action.toolkit.toLowerCase()
      && candidate.actionSlug.toLowerCase() === action.actionSlug.toLowerCase());
    const exactLearned = learnedResults.find((candidate) => candidate.toolRef.toLowerCase() === toolRef);
    const sdkContract = exactSdk && hasExactComposioActionSchemas(exactSdk)
      ? buildComposioActionContract(exactSdk)
      : null;
    const learnedMatchesSdk = Boolean(
      exactLearned?.contract.readiness?.sourceHash
      && sdkContract?.readiness?.sourceHash
      && exactLearned.contract.readiness.sourceHash === sdkContract.readiness.sourceHash,
    );
    const contract = learnedMatchesSdk ? exactLearned!.contract : sdkContract ?? exactLearned?.contract ?? null;
    if (contract) merged.set(toolRef, { contract, connected: false, source: "required_spec" });
  }
  return [...merged.values()];
}

export async function discoverToolsForQueries(auth: AuthContext, queries: string[], limit = 12): Promise<DiscoveredToolContract[]> {
  const cappedLimit = Math.max(1, Math.min(limit, 12));
  const searchQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 4);
  if (searchQueries.length === 0) return [];
  const connected = new Set(connectedAppToolkits(await listConnectorAccounts(auth).catch(() => [])));
  const resultSets = await Promise.all(searchQueries.map(async (query) => Promise.all([
    searchComposioTools(query, cappedLimit),
    searchLearnedToolSpecs(query, cappedLimit),
  ])));
  const normalizedSets = resultSets.map(([sdkResults, learnedResults]) => {
    const merged = new Map<string, DiscoveredToolContract>();
    for (const learned of learnedResults) {
      merged.set(learned.toolRef.toLowerCase(), {
        contract: learned.contract,
        connected: connected.has(learned.toolkit.toLowerCase()),
        source: "learned_catalog",
      });
    }
    for (const action of sdkResults) {
      if (!hasExactComposioActionSchemas(action)) continue;
      const contract = buildComposioActionContract(action);
      merged.set(contract.toolRef.toLowerCase(), {
        contract,
        connected: connected.has(action.toolkit.toLowerCase()),
        source: "composio_search",
      });
    }
    return [...merged.values()];
  });
  return interleaveDiscoveredToolResults(normalizedSets, cappedLimit);
}

/** Compatibility entry point. Core planning should call discoverToolsForQueries with model-produced queries. */
export async function discoverToolsForIntent(auth: AuthContext, intent: string, limit = 12): Promise<DiscoveredToolContract[]> {
  return discoverToolsForQueries(auth, [intent], limit);
}
