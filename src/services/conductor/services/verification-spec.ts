import { listComposioToolkitTools, resolveComposioToolVersion } from "../../connectors/composio.js";
import { buildComposioActionContract } from "../../tool-spec/tool-contracts.js";
import type { ToolContract } from "../../tool-spec/types.js";
import type { VerificationTarget } from "./verification-scope.js";

type LiveSpecCache = Map<string, ToolContract>;

function cacheKey(toolkit: string, actionSlug: string): string {
  return `${toolkit.toLowerCase()}:${actionSlug.replace(/-/g, "_").toUpperCase()}`;
}

function normalizeSlug(slug: string): string {
  return slug.replace(/-/g, "_").toUpperCase();
}

export async function resolveLiveVerificationContract(
  target: VerificationTarget,
  cache: LiveSpecCache,
): Promise<ToolContract | null> {
  const key = cacheKey(target.toolkit, target.actionSlug);
  const cached = cache.get(key);
  if (cached) return cached;

  const toolkit = target.toolkit.trim().toLowerCase();
  const wanted = normalizeSlug(target.actionSlug);
  const tools = await listComposioToolkitTools(toolkit);
  const match = tools.find((tool) => normalizeSlug(tool.actionSlug) === wanted);
  if (!match) return null;

  const version = match.toolkitVersion ?? await resolveComposioToolVersion(match.actionSlug);
  const contract = buildComposioActionContract({
    toolkit,
    actionSlug: match.actionSlug,
    name: match.name,
    description: match.description,
    risk: match.risk,
    inputSchema: match.inputSchema,
    outputSchema: match.outputSchema ?? { type: "object" },
    toolkitVersion: version,
  });
  cache.set(key, contract);
  return contract;
}

export function createLiveVerificationSpecCache(): LiveSpecCache {
  return new Map();
}
