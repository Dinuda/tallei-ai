import { getStaticToolContract } from "../tool-spec/tool-contracts.js";
import type { ToolContract } from "../tool-spec/types.js";

export type PlatformManagedIntegration = {
  slug: string;
  name: string;
  description: string;
  logo: string;
  internalToolRef: string;
};

/** Apps that appear in the builder catalogue but are powered by Tallei platform credentials. */
export const PLATFORM_MANAGED_INTEGRATIONS: Record<string, PlatformManagedIntegration> = {
  exa: {
    slug: "exa",
    name: "Exa",
    description: "Web search for recent articles and live web data. Managed by Tallei using platform Exa credentials.",
    logo: "https://logos.composio.dev/api/exa",
    internalToolRef: "internal.web_search",
  },
};

export function isPlatformManagedToolkit(slug: string): boolean {
  return slug.trim().toLowerCase() in PLATFORM_MANAGED_INTEGRATIONS;
}

export function partitionSelectedToolkits(selectedToolkits: string[]): {
  composioToolkits: string[];
  platformManagedToolkits: string[];
} {
  const composioToolkits: string[] = [];
  const platformManagedToolkits: string[] = [];
  for (const raw of selectedToolkits) {
    const slug = raw.trim().toLowerCase();
    if (!slug) continue;
    if (isPlatformManagedToolkit(slug)) platformManagedToolkits.push(slug);
    else composioToolkits.push(slug);
  }
  return { composioToolkits, platformManagedToolkits };
}

export function platformManagedToolContracts(slugs: string[]): ToolContract[] {
  const contracts: ToolContract[] = [];
  for (const slug of slugs) {
    const integration = PLATFORM_MANAGED_INTEGRATIONS[slug.trim().toLowerCase()];
    if (!integration) continue;
    const contract = getStaticToolContract(integration.internalToolRef);
    if (contract) contracts.push(contract);
  }
  return contracts;
}

export function platformManagedToolkitCatalogEntries(): Array<{
  slug: string;
  name: string;
  description: string;
  logo: string;
  category: string;
  platformManaged: true;
}> {
  return Object.values(PLATFORM_MANAGED_INTEGRATIONS).map((entry) => ({
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    logo: entry.logo,
    category: "Platform",
    platformManaged: true as const,
  }));
}

export function mergeToolkitCatalog<T extends { slug: string }>(
  composioToolkits: T[],
): Array<T | ReturnType<typeof platformManagedToolkitCatalogEntries>[number]> {
  const platformSlugs = new Set(Object.keys(PLATFORM_MANAGED_INTEGRATIONS));
  const filtered = composioToolkits.filter((toolkit) => !platformSlugs.has(toolkit.slug.trim().toLowerCase()));
  return [...platformManagedToolkitCatalogEntries(), ...filtered];
}

function toolkitSlugForContract(contract: ToolContract): string {
  const configured = contract.constraints.toolkit;
  if (typeof configured === "string" && configured.trim()) return configured.trim().toLowerCase();
  const match = contract.toolRef.match(/^composio\.([^.]+)\./i);
  return match?.[1]?.toLowerCase() ?? "";
}

/** Replace mistaken Composio catalogue entries with the platform-managed internal tool contract. */
export function normalizeDiscoveredToolContracts(contracts: ToolContract[]): ToolContract[] {
  const byRef = new Map<string, ToolContract>();
  const platformSlugs = new Set<string>();

  for (const contract of contracts) {
    const toolkit = toolkitSlugForContract(contract);
    if (contract.provider === "composio" && isPlatformManagedToolkit(toolkit)) {
      platformSlugs.add(toolkit);
      continue;
    }
    byRef.set(contract.toolRef.toLowerCase(), contract);
  }

  for (const slug of platformSlugs) {
    for (const contract of platformManagedToolContracts([slug])) {
      byRef.set(contract.toolRef.toLowerCase(), contract);
    }
  }

  return [...byRef.values()];
}

export function composioConnectorContracts(contracts: ToolContract[]): ToolContract[] {
  return normalizeDiscoveredToolContracts(contracts).filter((contract) => {
    if (contract.provider !== "composio") return false;
    const toolkit = toolkitSlugForContract(contract);
    return toolkit.length > 0 && !isPlatformManagedToolkit(toolkit);
  });
}
