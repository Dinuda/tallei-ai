import { normalizeToolkitSlug } from "./auth.js";
import { getComposioClient, isComposioConfigured } from "./client.js";
import { readComposioMetadata } from "./metadata-cache.js";

const KNOWN_NO_AUTH_TOOLKITS = new Set(["composiosearch"]);

const TOOLKIT_AUTH_CACHE_POLICY = {
  freshTtlMs: 24 * 60 * 60 * 1000,
  staleTtlMs: 7 * 24 * 60 * 60 * 1000,
  emptyTtlMs: 60 * 1000,
} as const;

export type ToolkitAuthProfile = {
  requiresConnection: boolean;
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function requiresConnectionFromToolkitRow(row: Record<string, unknown>): boolean {
  const details = Array.isArray(row.authConfigDetails) ? row.authConfigDetails : [];
  const modes = details
    .map((item) => String(toRecord(item).mode ?? "").trim().toUpperCase())
    .filter(Boolean);
  const managedSchemes = Array.isArray(row.composioManagedAuthSchemes)
    ? row.composioManagedAuthSchemes
    : [];
  if (modes.length === 0 && managedSchemes.length === 0) return true;
  if (modes.length > 0 && modes.every((mode) => mode === "NO_AUTH") && managedSchemes.length === 0) {
    return false;
  }
  return true;
}

export function isKnownNoAuthToolkitSlug(toolkitSlug: string): boolean {
  return KNOWN_NO_AUTH_TOOLKITS.has(normalizeToolkitSlug(toolkitSlug));
}

export function markNoAuthToolkitSlug(toolkitSlug: string): void {
  const slug = normalizeToolkitSlug(toolkitSlug);
  if (slug) KNOWN_NO_AUTH_TOOLKITS.add(slug);
}

/** Clears the in-process no-auth slug cache (tests only). */
export function resetKnownNoAuthToolkitsForTests(): void {
  KNOWN_NO_AUTH_TOOLKITS.clear();
  KNOWN_NO_AUTH_TOOLKITS.add("composiosearch");
}

export async function getToolkitAuthProfile(toolkitSlug: string): Promise<ToolkitAuthProfile> {
  const toolkit = normalizeToolkitSlug(toolkitSlug);
  if (!toolkit) return { requiresConnection: true };
  if (isKnownNoAuthToolkitSlug(toolkit)) return { requiresConnection: false };
  if (!isComposioConfigured()) return { requiresConnection: true };

  return readComposioMetadata(
    `composio:toolkit-auth:${toolkit}:v1`,
    async () => {
      try {
        const row = toRecord(await getComposioClient().toolkits.get(toolkit));
        const meta = toRecord(row.meta);
        const requiresConnection = requiresConnectionFromToolkitRow({
          authConfigDetails: row.authConfigDetails ?? meta.authConfigDetails,
          composioManagedAuthSchemes: row.composioManagedAuthSchemes ?? meta.composioManagedAuthSchemes,
        });
        if (!requiresConnection) markNoAuthToolkitSlug(toolkit);
        return { requiresConnection };
      } catch {
        return { requiresConnection: true };
      }
    },
    TOOLKIT_AUTH_CACHE_POLICY,
  );
}

export async function isNoAuthToolkit(toolkitSlug: string): Promise<boolean> {
  return !(await getToolkitAuthProfile(toolkitSlug)).requiresConnection;
}

export function applyNoAuthToolkitView<T extends {
  slug: string;
  connected: boolean;
  connectedAccountId?: string;
  connectable?: boolean;
  requiresConnection?: boolean;
}>(toolkit: T): T {
  if (!isKnownNoAuthToolkitSlug(toolkit.slug)) return toolkit;
  return {
    ...toolkit,
    connected: true,
    connectable: true,
    requiresConnection: false,
    connectedAccountId: undefined,
  };
}
