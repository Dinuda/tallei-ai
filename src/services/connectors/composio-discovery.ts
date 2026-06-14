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
  getCatalogContracts,
} from "./composio-catalog.js";
import { getOrCreateComposioSession } from "./composio-session.js";

export type DiscoveredTool = {
  contract: ToolContract;
  connected: boolean;
  source: string;
  capabilityQueries?: string[];
};

export type DiscoverToolsInput = {
  auth: AuthContext;
  prompt: string;
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
): Promise<DiscoveredTool[]> {
  const response = await session.search({ query: prompt });
  if (!response.success || !Array.isArray(response.results)) return [];

  const slugs = new Set<string>();
  for (const result of response.results) {
    for (const slug of [...(result.primaryToolSlugs ?? []), ...(result.relatedToolSlugs ?? [])]) {
      slugs.add(slug.toUpperCase());
    }
  }
  if (slugs.size === 0) return [];

  const catalogContracts = await getCatalogContracts({ slugs: [...slugs] });
  const catalogBySlug = new Map(
    catalogContracts.map((c) => [String(c.constraints.actionSlug ?? "").toUpperCase(), c]),
  );

  const discovered: DiscoveredTool[] = [];
  for (const slug of slugs) {
    const contract = catalogBySlug.get(slug);
    if (contract) {
      discovered.push({
        contract,
        connected: false,
        source: "session_search",
        capabilityQueries: [prompt],
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

export async function discoverToolsForLoopBuild(input: DiscoverToolsInput): Promise<DiscoverToolsResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 12, 50));
  const session = await getOrCreateComposioSession(input.auth, input.composioSessionId);
  const [sessionSearchTools, connectedSlugs] = await Promise.all([
    discoverViaSessionSearch(session.client, input.prompt),
    connectedActionSlugs(session.client),
  ]);
  const merged = sessionSearchTools.map((entry) => {
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
    tools: merged.slice(0, limit),
  };
}
