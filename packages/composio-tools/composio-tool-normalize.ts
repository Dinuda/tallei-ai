import type { ComposioActionView, ComposioToolSearchResult } from "./composio-tool-types.js";

export function toObjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Generic slug normalization — no provider alias table. */
export function normalizeToolkitSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/[_\s-]+/g, "");
}

export function normalizeComposioToolSearchResponse(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  const row = toObjectRecord(response);
  for (const candidate of [row.items, row.tools, row.data, toObjectRecord(row.data).items]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export function normalizeComposioAction(toolkit: string, raw: unknown): ComposioActionView | null {
  const row = toObjectRecord(raw);
  if (row.isDeprecated === true || row.is_deprecated === true) return null;
  const slug = String(row.slug ?? row.name ?? row.id ?? row.action ?? "").trim();
  if (!slug) return null;
  const name = String(row.displayName ?? row.name ?? slug).trim();
  const meta = toObjectRecord(row.meta);
  const description = String(row.description ?? meta.description ?? "").trim();
  const inputSchema = toObjectRecord(
    row.inputSchema ?? row.inputParameters ?? row.input_parameters ?? row.parameters ?? row.schema ?? row.argsSchema,
  );
  const outputSchema = toObjectRecord(
    row.outputSchema ?? row.outputParameters ?? row.output_parameters ?? row.responseSchema ?? row.resultSchema,
  );
  const toolkitVersion = String(row.version ?? row.toolkitVersion ?? row.toolkit_version ?? "").trim();
  return {
    toolkit,
    actionSlug: slug,
    name,
    description,
    inputSchema,
    ...(Object.keys(outputSchema).length > 0 ? { outputSchema } : {}),
    ...(toolkitVersion && toolkitVersion.toLowerCase() !== "latest" ? { toolkitVersion } : {}),
  };
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

export function parseComposioSearchItems(items: unknown[], cappedLimit: number): ComposioToolSearchResult[] {
  const results: ComposioToolSearchResult[] = [];
  for (const item of items) {
    const row = toObjectRecord(item);
    if (row.isDeprecated === true || row.is_deprecated === true) continue;
    const toolkitRow = toObjectRecord(row.toolkit);
    const rawToolkit = String(toolkitRow.slug ?? row.toolkitSlug ?? row.toolkit_slug ?? "").trim();
    if (!rawToolkit) continue;
    const toolkit = normalizeToolkitSlug(rawToolkit);
    const action = normalizeComposioAction(toolkit, row);
    if (!action || !toolkit) continue;
    results.push({
      ...action,
      toolkitName: String(toolkitRow.name ?? toolkit),
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    });
  }
  const merged = new Map<string, ComposioToolSearchResult>();
  for (const result of results) {
    const key = `${result.toolkit}:${result.actionSlug}`.toLowerCase();
    if (!merged.has(key)) merged.set(key, result);
  }
  return [...merged.values()].slice(0, cappedLimit);
}

export function selectLatestToolkitVersion(availableVersions?: string[]): string {
  return availableVersions?.find((version) => version.trim() && version.toLowerCase() !== "latest") ?? "latest";
}
