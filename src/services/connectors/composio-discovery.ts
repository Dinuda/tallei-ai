/**
 * composio-discovery.ts — Session-aware tool discovery backed by the local
 * Composio catalogue spec files.
 *
 * This replaces the old query-based catalogue search in
 * `src/services/tool-spec/discovery.ts` for the loop-builder flow. It combines:
 *   - `session.search({ query })` for semantic relevance and use-case guidance
 *   - `session.tools()` for connected-account availability
 *   - the local `composio-catalog` for authoritative full schemas
 */

import type { Session } from "@composio/core";
import { VercelProvider } from "@composio/vercel";

import type { AuthContext } from "../../domain/auth/index.js";
import type { ToolContract } from "../tool-spec/types.js";
import {
  buildCapabilityQueries,
  interleaveDiscoveredTools,
  orderedSearchActionSlugs,
} from "./composio-discovery-ranking.js";
import {
  getCatalogContracts,
} from "./composio-catalog.js";
import { getOrCreateComposioSession } from "./composio-session.js";
import {
  partitionSelectedToolkits,
  platformManagedToolContracts,
} from "./platform-integrations.js";

export type DiscoveredTool = {
  contract: ToolContract;
  connected: boolean;
  source: string;
  capabilityQueries?: string[];
};

export type DiscoverToolsInput = {
  auth: AuthContext;
  prompt: string;
  selectedToolkits: string[];
  capabilityQueries?: string[];
  toolCategories?: string[];
  composioSessionId?: string | null;
  limit?: number;
};

export type DiscoverToolsResult = {
  sessionId?: string;
  tools: DiscoveredTool[];
};

function normalizeConnectedToolRef(name: string): string {
  // Vercel-wrapped tools use the action slug as the tool name.
  return name.trim().toUpperCase();
}

async function discoverViaSessionSearch(
  session: Session<unknown, unknown, VercelProvider>,
  prompt: string,
  capabilityQuery: string,
): Promise<DiscoveredTool[]> {
  const response = await session.search({ query: prompt });
  if (!response.success || !Array.isArray(response.results)) return [];

  const orderedSlugs = orderedSearchActionSlugs(response.results);
  if (orderedSlugs.length === 0) return [];

  const catalogContracts = await getCatalogContracts({ slugs: orderedSlugs });
  const catalogBySlug = new Map(
    catalogContracts.map((c) => [String(c.constraints.actionSlug ?? "").toUpperCase(), c]),
  );

  const discovered: DiscoveredTool[] = [];
  for (const slug of orderedSlugs) {
    const contract = catalogBySlug.get(slug);
    if (contract) {
      discovered.push({
        contract,
        connected: false,
        source: "session_search",
        capabilityQueries: [capabilityQuery],
      });
      continue;
    }
    throw new Error(`Local Composio catalogue is missing the exact schema for ${slug}`);
  }
  return discovered;
}

async function connectedActionSlugs(
  session: Session<unknown, unknown, VercelProvider>,
): Promise<Set<string>> {
  const vercelTools = await session.tools();
  return new Set(Object.keys(vercelTools ?? {}).map(normalizeConnectedToolRef));
}

function toolkitFor(contract: ToolContract): string {
  const configured = contract.constraints.toolkit;
  if (typeof configured === "string" && configured.trim()) return configured.trim().toLowerCase();
  const match = contract.toolRef.match(/^composio\.([^.]+)\./i);
  return match?.[1]?.toLowerCase() ?? "";
}

export async function discoverToolsForLoopBuild(input: DiscoverToolsInput): Promise<DiscoverToolsResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 12, 50));
  const { composioToolkits, platformManagedToolkits } = partitionSelectedToolkits(input.selectedToolkits);
  if (composioToolkits.length === 0 && platformManagedToolkits.length === 0) {
    throw new Error("Select at least one app before discovering tools");
  }

  const platformTools: DiscoveredTool[] = platformManagedToolContracts(platformManagedToolkits).map((contract) => ({
    contract,
    connected: true,
    source: "platform_managed",
  }));

  if (composioToolkits.length === 0) {
    const session = input.composioSessionId
      ? await getOrCreateComposioSession(input.auth, input.composioSessionId)
      : null;
    return {
      sessionId: session?.sessionId ?? input.composioSessionId ?? undefined,
      tools: platformTools.slice(0, limit),
    };
  }

  const composioToolkitSet = new Set(composioToolkits);
  const session = await getOrCreateComposioSession(input.auth, input.composioSessionId);
  const capabilityQueries = buildCapabilityQueries({
    prompt: input.prompt,
    capabilityQueries: input.capabilityQueries,
    toolCategories: input.toolCategories,
  });
  const perQueryLimit = Math.max(3, Math.ceil(limit / capabilityQueries.length));
  const toolkitScope = [...composioToolkitSet].join(", ");

  const resultSets = await Promise.all(capabilityQueries.map(async (capabilityQuery) => {
    const searchPrompt = `${capabilityQuery}\nUse only these user-selected apps: ${toolkitScope}. Return the single most specific action for this capability first.`;
    const tools = await discoverViaSessionSearch(session.client, searchPrompt, capabilityQuery);
    return tools
      .filter((entry) => composioToolkitSet.has(toolkitFor(entry.contract)))
      .slice(0, perQueryLimit);
  }));

  const [connectedSlugs] = await Promise.all([
    connectedActionSlugs(session.client),
  ]);
  const selectedTools = interleaveDiscoveredTools(resultSets, limit);
  if (selectedTools.length === 0 && platformTools.length === 0) {
    throw new Error(`No matching actions were found in the selected apps: ${[...composioToolkitSet, ...platformManagedToolkits].join(", ")}`);
  }
  const merged = selectedTools.map((entry) => {
    const actionSlug = normalizeConnectedToolRef(String(entry.contract.constraints.actionSlug ?? ""));
    const connected = connectedSlugs.has(actionSlug);
    return {
      ...entry,
      connected,
      contract: {
        ...entry.contract,
        constraints: { ...entry.contract.constraints, connected },
      } as ToolContract,
    };
  });

  return {
    sessionId: session.sessionId,
    tools: [...platformTools, ...merged].slice(0, limit),
  };
}

export { buildCapabilityQueries, interleaveDiscoveredTools, orderedSearchActionSlugs } from "./composio-discovery-ranking.js";
