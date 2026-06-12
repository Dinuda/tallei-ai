import type { AuthContext } from "../../domain/auth/index.js";
import { connectedAppToolkits, listConnectorAccounts, searchComposioTools } from "../connectors/composio.js";
import { buildComposioActionContract, connectorActionToolRef, hasExactComposioActionSchemas } from "./tool-contracts.js";
import { searchLearnedToolSpecs } from "./learned-catalog.js";
import type { ToolContract } from "./types.js";

export type DiscoveredToolContract = {
  contract: ToolContract;
  connected: boolean;
  source: "composio_search" | "learned_catalog" | "required_spec";
};

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
  const merged = new Map<string, DiscoveredToolContract>();
  for (const [sdkResults, learnedResults] of resultSets) {
    for (const learned of learnedResults) {
      if (merged.has(learned.toolRef.toLowerCase())) continue;
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
  }
  return [...merged.values()].slice(0, cappedLimit);
}

/** Compatibility entry point. Core planning should call discoverToolsForQueries with model-produced queries. */
export async function discoverToolsForIntent(auth: AuthContext, intent: string, limit = 12): Promise<DiscoveredToolContract[]> {
  return discoverToolsForQueries(auth, [intent], limit);
}
