#!/usr/bin/env node
/**
 * sync-composio-catalog.mjs
 *
 * One-off script that fetches the full Composio tool catalogue via
 * GET /api/v3.1/tools, groups tools by toolkit, and writes a local
 * spec cache under generated/composio-catalog/<apiVersion>/.
 *
 * The manifest tracks the API version and fetch time so the runtime
 * can invalidate stale caches.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const API_VERSION = "v3.1";
const BASE_URL = process.env.TALLEI_CONNECTORS__COMPOSIO_BASE_URL?.replace(/\/$/, "")
  || "https://backend.composio.dev";
const API_KEY = process.env.TALLEI_CONNECTORS__COMPOSIO_API_KEY;
const OUTPUT_DIR = path.resolve(process.cwd(), "generated", "composio-catalog", API_VERSION);
const PAGE_SIZE = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

if (!API_KEY) {
  console.error("Missing TALLEI_CONNECTORS__COMPOSIO_API_KEY");
  process.exit(1);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchToolsPage({ cursor = null, limit = PAGE_SIZE, attempt = 0 } = {}) {
  const params = new URLSearchParams({
    limit: String(limit),
    include_deprecated: "false",
    toolkit_versions: "latest",
  });
  if (cursor) params.set("cursor", cursor);

  const url = `${BASE_URL}/api/${API_VERSION}/tools?${params.toString()}`;
  const response = await fetch(url, {
    headers: { "x-api-key": API_KEY },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (attempt < MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
      console.warn(`Retryable error ${response.status} fetching tools; retry ${attempt + 1}/${MAX_RETRIES}`);
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      return fetchToolsPage({ cursor, limit, attempt: attempt + 1 });
    }
    throw new Error(`Composio tools request failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function fetchAllTools() {
  const tools = [];
  let cursor = null;
  let page = 1;
  let totalPages = 1;

  do {
    const data = await fetchToolsPage({ cursor });
    const items = Array.isArray(data.items) ? data.items : [];
    tools.push(...items);
    cursor = data.next_cursor || null;
    totalPages = data.total_pages || 1;
    console.log(`Fetched page ${page}/${totalPages}: ${items.length} tools (total so far: ${tools.length})`);
    page += 1;
  } while (cursor);

  return tools;
}

function normalizeToolkitSlug(toolkit) {
  if (!toolkit || typeof toolkit !== "object") return "unknown";
  return String(toolkit.slug || toolkit.name || "unknown").trim().toLowerCase();
}

function isLatestVersion(tool) {
  const version = String(tool.version || "").trim();
  const available = Array.isArray(tool.available_versions) ? tool.available_versions : [];
  if (available.length === 0) return true;
  // Trust the API's version field when it matches the latest available version.
  const latest = available[0];
  return version === latest;
}

function filterCatalogTool(tool) {
  if (!tool || typeof tool !== "object") return false;
  if (tool.is_deprecated === true) return false;
  if (!isLatestVersion(tool)) return false;
  const slug = String(tool.slug || "").trim();
  if (!slug) return false;
  return true;
}

function groupByToolkit(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const toolkit = normalizeToolkitSlug(tool.toolkit);
    if (!groups.has(toolkit)) groups.set(toolkit, []);
    groups.get(toolkit).push(tool);
  }
  return groups;
}

function inferRisk(tool) {
  const tags = tool.tags.map((tag) => tag.toLowerCase());
  const slug = tool.slug.toLowerCase();
  if (tags.includes("destructive") || /delete|remove|permanent|erase|destroy/.test(slug)) return "destructive";
  if (tags.includes("send") || /send|post|broadcast|notify|dispatch|deliver/.test(slug)) return "send";
  if (tags.includes("write") || tags.includes("create") || tags.includes("update") || /create|update|edit|write|add|insert/.test(slug)) return "write";
  if (tags.includes("read") || tags.includes("list") || tags.includes("get") || /get|list|search|fetch|read|find/.test(slug)) return "read";
  return "write";
}

function buildLightweightIndex(tools) {
  return tools.map((tool) => ({
    slug: tool.slug,
    toolkit: normalizeToolkitSlug(tool.toolkit),
    name: tool.name,
    description: tool.description,
    humanDescription: tool.human_description ?? null,
    tags: tool.tags,
    risk: inferRisk(tool),
    noAuth: tool.no_auth === true,
  }));
}

async function main() {
  console.log(`Syncing Composio catalog to ${OUTPUT_DIR}`);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const allTools = await fetchAllTools();
  const catalogTools = allTools.filter(filterCatalogTool);
  const grouped = groupByToolkit(catalogTools);

  const toolkitNames = [...grouped.keys()].sort();
  const manifest = {
    apiVersion: API_VERSION,
    apiBaseUrl: BASE_URL,
    fetchedAt: new Date().toISOString(),
    totalToolsFetched: allTools.length,
    catalogTools: catalogTools.length,
    toolkits: toolkitNames.length,
    toolkitList: toolkitNames,
  };

  await writeFile(
    path.join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  const lightweightIndex = buildLightweightIndex(catalogTools);
  await writeFile(
    path.join(OUTPUT_DIR, "tools-index.json"),
    JSON.stringify(lightweightIndex, null, 2),
  );

  for (const [toolkit, tools] of grouped) {
    const filePath = path.join(OUTPUT_DIR, `${toolkit}.json`);
    await writeFile(filePath, JSON.stringify({ toolkit, tools }, null, 2));
  }

  console.log(`Wrote manifest + ${toolkitNames.length} toolkit files + tools-index.json`);
  console.log(`Catalog tools: ${catalogTools.length} / fetched: ${allTools.length}`);
  console.log(`Lightweight index entries: ${lightweightIndex.length}`);
}

main().catch((error) => {
  console.error("Catalog sync failed:", error);
  process.exit(1);
});
