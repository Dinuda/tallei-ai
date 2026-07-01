import { listToolkits } from "./tools.js";

/** Generic slug normalization — no provider alias table. */
export function normalizeToolkitSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/[_\s-]+/g, "");
}

let toolkitCatalogCache: Awaited<ReturnType<typeof listToolkits>> | null = null;
let toolkitCatalogLoadedAt = 0;
const TOOLKIT_CATALOG_TTL_MS = 5 * 60 * 1000;

async function getToolkitCatalog() {
  if (toolkitCatalogCache && Date.now() - toolkitCatalogLoadedAt < TOOLKIT_CATALOG_TTL_MS) {
    return toolkitCatalogCache;
  }
  toolkitCatalogCache = await listToolkits();
  toolkitCatalogLoadedAt = Date.now();
  return toolkitCatalogCache;
}

/** Resolve a user/LLM toolkit label to a Composio toolkit slug via catalogue lookup. */
export async function resolveToolkitSlug(slug: string): Promise<string> {
  const needle = slug.trim().toLowerCase();
  if (!needle) return "";
  const collapsed = normalizeToolkitSlug(needle);
  const toolkits = await getToolkitCatalog();
  for (const toolkit of toolkits) {
    const tkSlug = toolkit.slug.toLowerCase();
    const tkCollapsed = normalizeToolkitSlug(tkSlug);
    if (tkSlug === needle || tkCollapsed === collapsed) return toolkit.slug;
    const nameCollapsed = toolkit.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (nameCollapsed === collapsed) return toolkit.slug;
  }
  return collapsed || needle;
}
