import type { AuthContext } from "../../domain/auth/index.js";
import { connectedAppToolkits, listComposioToolkitTools, listConnectorAccounts, searchComposioTools } from "../connectors/composio.js";
import { buildComposioActionContract, connectorActionToolRef, hasExactComposioActionSchemas, normalizeToolRef } from "./tool-contracts.js";
import { searchLearnedToolSpecs } from "./learned-catalog.js";
import type { ToolContract } from "./types.js";

export type DiscoveredToolContract = {
  contract: ToolContract;
  connected: boolean;
  source: "composio_search" | "learned_catalog" | "required_spec";
  capabilityQueries?: string[];
};

function mergeDiscoveryEntry(
  existing: DiscoveredToolContract | undefined,
  incoming: DiscoveredToolContract,
): DiscoveredToolContract {
  if (!existing) return incoming;
  const preferred = existing.source === "learned_catalog" && incoming.source === "composio_search"
    ? incoming
    : existing;
  return {
    ...preferred,
    connected: existing.connected || incoming.connected,
    capabilityQueries: [...new Set([
      ...(existing.capabilityQueries ?? []),
      ...(incoming.capabilityQueries ?? []),
    ])],
  };
}

export function mergeDiscoveredToolContracts(
  ...resultSets: DiscoveredToolContract[][]
): DiscoveredToolContract[] {
  const merged = new Map<string, DiscoveredToolContract>();
  for (const entries of resultSets) {
    for (const entry of entries) {
      const key = entry.contract.toolRef.toLowerCase();
      merged.set(key, mergeDiscoveryEntry(merged.get(key), entry));
    }
  }
  return [...merged.values()];
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
      merged.set(key, mergeDiscoveryEntry(merged.get(key), entry));
      if (merged.size >= limit) break;
    }
  }
  return [...merged.values()];
}

export async function mergeRequiredToolContracts(
  discovered: DiscoveredToolContract[],
  requiredActions: Array<{ toolkit: string; actionSlug: string; risk: string; description?: string }>,
): Promise<DiscoveredToolContract[]> {
  const merged = new Map(discovered.map((entry) => [normalizeToolRef(entry.contract.toolRef), entry]));
  for (const action of requiredActions) {
    const toolRef = connectorActionToolRef(action);
    const normalizedRef = normalizeToolRef(toolRef);
    if (merged.has(normalizedRef)) continue;
    const [sdkResults, learnedResults, toolkitTools] = await Promise.all([
      searchComposioTools(`${action.toolkit} ${action.actionSlug}`, 50),
      searchLearnedToolSpecs(`${action.toolkit} ${action.actionSlug}`, 50),
      listComposioToolkitTools(action.toolkit).catch(() => []),
    ]);
    const exactSdk = sdkResults.find((candidate) =>
      candidate.toolkit.toLowerCase() === action.toolkit.toLowerCase()
      && candidate.actionSlug.toLowerCase() === action.actionSlug.toLowerCase())
      ?? toolkitTools.find((candidate) =>
        candidate.toolkit.toLowerCase() === action.toolkit.toLowerCase()
        && candidate.actionSlug.toLowerCase() === action.actionSlug.toLowerCase());
    const exactLearned = learnedResults.find((candidate) => normalizeToolRef(candidate.toolRef) === normalizedRef);
    const sdkContract = exactSdk && hasExactComposioActionSchemas(exactSdk)
      ? buildComposioActionContract(exactSdk)
      : null;
    const learnedMatchesSdk = Boolean(
      exactLearned?.contract.readiness?.sourceHash
      && sdkContract?.readiness?.sourceHash
      && exactLearned.contract.readiness.sourceHash === sdkContract.readiness.sourceHash,
    );
    const contract = learnedMatchesSdk ? exactLearned!.contract : sdkContract ?? exactLearned?.contract ?? null;
    if (contract) merged.set(normalizedRef, { contract, connected: false, source: "required_spec" });
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
  const normalizedSets = resultSets.map(([sdkResults, learnedResults], index) => {
    const capabilityQuery = searchQueries[index]!;
    const merged = new Map<string, DiscoveredToolContract>();
    for (const learned of learnedResults) {
      merged.set(learned.toolRef.toLowerCase(), {
        contract: learned.contract,
        connected: connected.has(learned.toolkit.toLowerCase()),
        source: "learned_catalog",
        capabilityQueries: [capabilityQuery],
      });
    }
    for (const action of sdkResults) {
      if (!hasExactComposioActionSchemas(action)) continue;
      const contract = buildComposioActionContract(action);
      merged.set(contract.toolRef.toLowerCase(), {
        contract,
        connected: connected.has(action.toolkit.toLowerCase()),
        source: "composio_search",
        capabilityQueries: [capabilityQuery],
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
