import { createHash } from "node:crypto";

import { normalizeToolkitSlug } from "./auth.js";
import {
  composioRequest,
  getComposioClient,
  getComposioRawToolsClient,
  isComposioConfigured,
  getComposioToolkitVersion,
  toObjectRecord,
  withComposioTimeout,
} from "./client.js";
import { readComposioMetadata } from "./metadata-cache.js";
import type {
  ComposioActionView,
  ComposioToolSearchResult,
  ComposioToolkitView,
} from "./types.js";

const TOOLKIT_CATALOG_CACHE_POLICY = {
  freshTtlMs: 6 * 60 * 60 * 1000,
  staleTtlMs: 24 * 60 * 60 * 1000,
  emptyTtlMs: 2 * 60 * 1000,
} as const;

const TOOLKIT_VERSION_CACHE_POLICY = {
  freshTtlMs: 5 * 60 * 1000,
  staleTtlMs: 60 * 60 * 1000,
  emptyTtlMs: 60 * 1000,
} as const;

const TOOLKIT_ACTION_CACHE_POLICY = {
  freshTtlMs: 5 * 365 * 24 * 60 * 60 * 1000,
  staleTtlMs: 10 * 365 * 24 * 60 * 60 * 1000,
  emptyTtlMs: 2 * 60 * 1000,
} as const;

const TOOLKIT_SEARCH_CACHE_POLICY = {
  freshTtlMs: 10 * 60 * 1000,
  staleTtlMs: 60 * 60 * 1000,
  emptyTtlMs: 2 * 60 * 1000,
} as const;

function cacheKeyForSearch(query: string, limit: number): string {
  return createHash("sha256").update(`${query}\0${limit}`).digest("hex");
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

async function searchToolsViaSdk(query: string, limit: number): Promise<ComposioToolSearchResult[]> {
  const rawTools = getComposioRawToolsClient();
  if (!rawTools?.list) return [];
  const response = await withComposioTimeout(
    rawTools.list({
      search: query,
      limit,
      toolkit_versions: "latest",
    }),
    `Composio sdk tool search (${query})`,
  );
  if (!response) return [];
  return parseComposioSearchItems(normalizeComposioToolSearchResponse(response), limit);
}

async function searchToolsViaHttp(query: string, limit: number): Promise<ComposioToolSearchResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const paths = [
    `/api/v3.1/tools?query=${encodedQuery}&limit=${limit}&include_deprecated=false`,
    `/api/v3/tools?query=${encodedQuery}&limit=${limit}&include_deprecated=false`,
  ];
  for (const path of paths) {
    try {
      const data = await composioRequest<{ items?: unknown[]; tools?: unknown[] }>({ path });
      const items = normalizeComposioToolSearchResponse(data);
      const results = parseComposioSearchItems(items, limit);
      if (results.length > 0) return results;
    } catch (error) {
      console.warn(`[integrations/composio] tool search http failed for ${path}:`, error);
    }
  }
  return [];
}

export async function searchTools(query: string, limit = 12): Promise<ComposioToolSearchResult[]> {
  if (!isComposioConfigured()) return [];
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  if (!normalizedQuery) return [];
  const cappedLimit = Math.max(1, Math.min(limit, 50));
  return readComposioMetadata(
    `composio:search:${cacheKeyForSearch(normalizedQuery.toLowerCase(), cappedLimit)}:v1`,
    async () => {
      try {
        const sdkResults = await searchToolsViaSdk(normalizedQuery, cappedLimit);
        if (sdkResults.length > 0) return sdkResults;
      } catch (error) {
        console.warn("[integrations/composio] tool search sdk failed:", error);
      }
      return searchToolsViaHttp(normalizedQuery, cappedLimit);
    },
    TOOLKIT_SEARCH_CACHE_POLICY,
  );
}

export async function getLatestToolkitVersion(toolkitSlug: string): Promise<string> {
  const toolkit = normalizeToolkitSlug(toolkitSlug);
  if (!isComposioConfigured() || !toolkit) return "latest";
  const configured = getComposioToolkitVersion(toolkit);
  if (configured !== "latest") return configured;
  return readComposioMetadata(
    `composio:toolkit-version:${toolkit}:v1`,
    async () => {
      const response = await withComposioTimeout(
        getComposioClient().toolkits.get(toolkit),
        `Composio toolkit version (${toolkit})`,
      );
      return selectLatestToolkitVersion(response.meta.availableVersions);
    },
    TOOLKIT_VERSION_CACHE_POLICY,
  );
}

export function selectLatestToolkitVersion(availableVersions?: string[]): string {
  return availableVersions?.find((version) => version.trim() && version.toLowerCase() !== "latest") ?? "latest";
}

export async function getAllTools(toolkitSlug: string): Promise<ComposioActionView[]> {
  const toolkit = normalizeToolkitSlug(toolkitSlug);
  if (!isComposioConfigured() || !toolkit) return [];
  const toolkitVersion = await getLatestToolkitVersion(toolkit);
  const cacheKey = `composio:actions:${toolkit}:${toolkitVersion}:v1`;

  const normalizeItems = (items: unknown): ComposioActionView[] =>
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeComposioAction(toolkit, item))
      .filter((item): item is ComposioActionView => Boolean(item))
      .map((item) => ({
        ...item,
        ...(toolkitVersion !== "latest" && !item.toolkitVersion ? { toolkitVersion } : {}),
      }));

  return readComposioMetadata(
    cacheKey,
    async () => {
      try {
        const rawTools = getComposioRawToolsClient();
        if (rawTools?.list) {
          const response = await withComposioTimeout(
            rawTools.list({
              toolkit_slug: toolkit,
              limit: 50,
              toolkit_versions: toolkitVersion,
            }),
            `Composio sdk toolkit tool list (${toolkit})`,
          );
          const items = normalizeItems(normalizeComposioToolSearchResponse(response));
          if (items.length > 0) return items;
        }
      } catch (error) {
        console.warn(`[integrations/composio] toolkit tools sdk list failed for ${toolkit}:`, error);
      }

      const paths = [
        `/api/v3.1/tools?toolkit=${encodeURIComponent(toolkit)}`,
        `/api/v3/tools?toolkit=${encodeURIComponent(toolkit)}`,
        `/api/v3.1/toolkits/${encodeURIComponent(toolkit)}/tools`,
        `/api/v3/toolkits/${encodeURIComponent(toolkit)}/tools`,
      ];
      let lastError: Error | null = null;
      for (const path of paths) {
        try {
          const data = await composioRequest<{ items?: unknown[]; tools?: unknown[] }>({ path });
          const items = normalizeItems(data.items ?? data.tools);
          if (items.length > 0) return items;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (lastError) {
        console.warn(`[integrations/composio] toolkit tools discovery failed for ${toolkit}: ${lastError.message}`);
      }
      return [];
    },
    TOOLKIT_ACTION_CACHE_POLICY,
  );
}

export async function listToolkits(): Promise<ComposioToolkitView[]> {
  if (!isComposioConfigured()) return [];

  type ToolkitRow = {
    slug?: string;
    name?: string;
    meta?: { description?: string; logo?: string };
    description?: string;
    logo?: string;
    category?: string;
  };

  const normalizeItems = (items: unknown): ToolkitRow[] =>
    Array.isArray(items) ? items.filter((item): item is ToolkitRow => Boolean(item) && typeof item === "object") : [];

  return readComposioMetadata(
    "composio:catalog:v1",
    async () => {
      try {
        const composio = getComposioClient() as unknown as {
          toolkits?: { list?: (args?: Record<string, unknown>) => Promise<unknown> };
        };
        if (composio.toolkits?.list) {
          const sdkResponse = await withComposioTimeout(
            composio.toolkits.list({}),
            "Composio sdk toolkit list",
          );
          const sdkItems = normalizeItems(toObjectRecord(sdkResponse).items);
          if (sdkItems.length > 0) {
            return sdkItems.map((item) => ({
              slug: item.slug ?? "",
              name: item.name ?? item.slug ?? "",
              description: item.meta?.description ?? item.description ?? "",
              logo: item.meta?.logo ?? item.logo ?? "",
              ...(item.category ? { category: item.category } : {}),
              connected: false,
            })).filter((item) => item.slug.length > 0);
          }
        }
      } catch (error) {
        console.warn("[integrations/composio] toolkits sdk list failed:", error);
      }

      const paths = ["/api/v3/toolkits", "/api/v3.1/toolkits"];
      let lastError: Error | null = null;
      for (const path of paths) {
        try {
          const data = await composioRequest<{ items?: ToolkitRow[] }>({ path });
          const items = normalizeItems(data.items);
          if (items.length === 0) continue;
          return items.map((item) => ({
            slug: item.slug ?? "",
            name: item.name ?? item.slug ?? "",
            description: item.meta?.description ?? item.description ?? "",
            logo: item.meta?.logo ?? item.logo ?? "",
            ...(item.category ? { category: item.category } : {}),
            connected: false,
          })).filter((item) => item.slug.length > 0);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (lastError) {
        console.warn(`[integrations/composio] toolkit discovery failed: ${lastError.message}`);
      }
      return [];
    },
    TOOLKIT_CATALOG_CACHE_POLICY,
  );
}
