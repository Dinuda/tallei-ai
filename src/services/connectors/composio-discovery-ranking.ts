import type { DiscoveredTool } from "./composio-discovery.js";

export function buildCapabilityQueries(input: {
  prompt: string;
  capabilityQueries?: string[];
  toolCategories?: string[];
}): string[] {
  const explicit = [...new Set(
    (input.capabilityQueries ?? []).map((query) => query.trim()).filter(Boolean),
  )];
  if (explicit.length > 0) return explicit.slice(0, 8);

  const categories = [...new Set(
    (input.toolCategories ?? []).map((category) => category.trim()).filter(Boolean),
  )];
  if (categories.length > 0) {
    return categories.map((category) => `${input.prompt.trim()} — ${category}`).slice(0, 8);
  }

  const prompt = input.prompt.trim();
  return prompt ? [prompt] : [];
}

export function orderedSearchActionSlugs(
  results: Array<{ primaryToolSlugs?: string[]; relatedToolSlugs?: string[] }>,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    for (const slug of [...(result.primaryToolSlugs ?? []), ...(result.relatedToolSlugs ?? [])]) {
      const normalized = slug.trim().toUpperCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
  }
  return ordered;
}

export function interleaveDiscoveredTools(
  resultSets: DiscoveredTool[][],
  limit: number,
): DiscoveredTool[] {
  const merged = new Map<string, DiscoveredTool>();
  const maxLength = Math.max(0, ...resultSets.map((entries) => entries.length));
  for (let index = 0; index < maxLength && merged.size < limit; index += 1) {
    for (const entries of resultSets) {
      const entry = entries[index];
      if (!entry) continue;
      const key = entry.contract.toolRef.toLowerCase();
      if (!merged.has(key)) merged.set(key, entry);
      if (merged.size >= limit) break;
    }
  }
  return [...merged.values()];
}
