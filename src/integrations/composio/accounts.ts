import type { AuthContext } from "../../domain/auth/index.js";
import { config } from "../../config/index.js";
import {
  deleteTtlCacheEntry,
  getTtlCacheEntry,
  setTtlCacheEntry,
  type TtlCacheStore,
} from "../../infrastructure/cache/ttl-cache.js";
import {
  findConnectorConnectionByRequest,
  upsertConnectorConnection,
} from "../../infrastructure/repositories/connector-connection.repository.js";
import { normalizeToolkitSlug, resolveToolkitSlug } from "./auth.js";
import { composioRequest, getComposioClient, getComposioEntityId, isComposioConfigured } from "./client.js";
import { listComposioTriggerTypes, type ComposioTriggerTypeRow } from "./triggers.js";
import { listToolkits } from "./tools.js";
import type { ComposioToolkitView } from "./types.js";

export type WorkspaceConnectorView = {
  slug: string;
  name: string;
  description: string;
  logo: string;
  connected: boolean;
  connectedAccountId?: string;
  connectable?: boolean;
};

export type CatalogToolkitView = WorkspaceConnectorView & {
  category?: string;
};

export type ToolkitConnectionStatus = {
  toolkit: string;
  connected: boolean;
  connectedAccountId?: string;
  status: "connected" | "disconnected" | "pending";
};

const CONNECTORS_CACHE_TTL_MS = 60_000;
const CONNECTORS_CACHE_MAX_SIZE = 200;
const connectorsCache: TtlCacheStore<WorkspaceConnectorView[]> = new Map();
const authConfigResolutionInFlight = new Map<string, Promise<string>>();

function connectorsCacheKey(auth: AuthContext): string {
  return `connectors:${auth.tenantId}:${auth.userId}:${auth.workspaceId ?? ""}`;
}

export function invalidateWorkspaceConnectorsCache(auth: AuthContext): void {
  deleteTtlCacheEntry(connectorsCache, connectorsCacheKey(auth));
}

/** Clears the in-process connector list cache (tests only). */
export function resetWorkspaceConnectorsCacheForTests(): void {
  connectorsCache.clear();
}

function mapToolkitView(toolkit: ComposioToolkitView): WorkspaceConnectorView {
  return {
    slug: toolkit.slug,
    name: toolkit.name,
    description: toolkit.description,
    logo: toolkit.logo,
    connected: Boolean(toolkit.connected),
    ...(toolkit.connectedAccountId ? { connectedAccountId: toolkit.connectedAccountId } : {}),
  };
}

type DirectConnectedAccount = {
  id: string;
  status: string;
  toolkit: { slug: string };
  updatedAt: string;
};

async function listDirectConnectedAccounts(auth: AuthContext): Promise<DirectConnectedAccount[]> {
  const composio = getComposioClient();
  const userId = getComposioEntityId(auth);
  const accounts: DirectConnectedAccount[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await composio.connectedAccounts.list({
      userIds: [userId],
      statuses: ["ACTIVE"],
      orderBy: "updated_at",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    accounts.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const selectedByToolkit = new Map<string, DirectConnectedAccount>();
  for (const account of accounts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const toolkit = normalizeToolkitSlug(account.toolkit.slug);
    if (!selectedByToolkit.has(toolkit)) selectedByToolkit.set(toolkit, account);
  }
  const selected = [...selectedByToolkit.values()];
  await Promise.all(selected.map((account) => upsertConnectorConnection({
    auth,
    provider: "composio",
    toolkit: normalizeToolkitSlug(account.toolkit.slug),
    externalAccountId: account.id,
    status: "connected",
  })));
  return selected;
}

async function resolveAuthConfigId(toolkit: string): Promise<string> {
  const composio = getComposioClient();
  const configured = config.composioAuthConfigId.trim();
  if (configured) {
    const authConfig = await composio.authConfigs.get(configured);
    if (normalizeToolkitSlug(authConfig.toolkit.slug) !== normalizeToolkitSlug(toolkit)) {
      throw new Error(`Configured Composio auth config does not belong to ${toolkit}`);
    }
    return configured;
  }
  const normalized = normalizeToolkitSlug(toolkit);
  const inFlight = authConfigResolutionInFlight.get(normalized);
  if (inFlight) return inFlight;

  const resolution = (async () => {
    const response = await composio.authConfigs.list({ toolkit: normalized, isComposioManaged: true, limit: 50 });
    const enabled = response.items.filter((item) => item.status.toUpperCase() === "ENABLED");
    if (enabled.length > 0) return selectComposioAuthConfigId(normalized, response.items);

    try {
      const created = await composio.authConfigs.create(normalized, {
        type: "use_composio_managed_auth",
        name: `Tallei ${normalized}`,
      });
      return created.id;
    } catch (createError) {
      // A concurrent process may have created it after our initial list request.
      const refreshed = await composio.authConfigs.list({ toolkit: normalized, isComposioManaged: true, limit: 50 });
      const refreshedEnabled = refreshed.items.filter((item) => item.status.toUpperCase() === "ENABLED");
      if (refreshedEnabled.length > 0) return selectComposioAuthConfigId(normalized, refreshed.items);
      throw createError;
    }
  })();
  authConfigResolutionInFlight.set(normalized, resolution);
  try {
    return await resolution;
  } finally {
    authConfigResolutionInFlight.delete(normalized);
  }
}

export function selectComposioAuthConfigId(
  toolkit: string,
  configs: Array<{ id: string; status: string }>,
): string {
  const enabled = configs.filter((item) => item.status.toUpperCase() === "ENABLED");
  if (enabled.length !== 1) {
    throw new Error(`Expected one enabled Composio-managed auth config for ${toolkit}; found ${enabled.length}`);
  }
  return enabled[0]!.id;
}

export async function withWorkspaceConnectorsCache(
  auth: AuthContext,
  loader: () => Promise<WorkspaceConnectorView[]>,
): Promise<WorkspaceConnectorView[]> {
  const key = connectorsCacheKey(auth);
  const cached = getTtlCacheEntry(connectorsCache, key);
  if (cached) return cached;
  const result = await loader();
  setTtlCacheEntry(connectorsCache, key, result, CONNECTORS_CACHE_TTL_MS, CONNECTORS_CACHE_MAX_SIZE);
  return result;
}

export async function listWorkspaceConnectors(auth: AuthContext): Promise<WorkspaceConnectorView[]> {
  if (!isComposioConfigured()) return [];
  return withWorkspaceConnectorsCache(auth, async () => {
    const catalog = await listToolkits();
    const accounts = await listDirectConnectedAccounts(auth);
    const activeByToolkit = new Map(accounts.map((account) => [normalizeToolkitSlug(account.toolkit.slug), account]));
    return catalog.map((toolkit) => {
      const account = activeByToolkit.get(normalizeToolkitSlug(toolkit.slug));
      return mapToolkitView({
        ...toolkit,
        connected: Boolean(account),
        ...(account ? { connectedAccountId: account.id } : {}),
      });
    });
  });
}

/** Full Composio catalogue merged with workspace connection status (connected-first planning). */
export async function listAllToolkitsWithStatus(auth: AuthContext): Promise<{
  toolkits: CatalogToolkitView[];
  total: number;
}> {
  if (!isComposioConfigured()) return { toolkits: [], total: 0 };

  const [catalog, accounts] = await Promise.all([listToolkits(), listDirectConnectedAccounts(auth)]);
  const sessionRows: ComposioToolkitView[] = accounts.map((account) => ({
    slug: account.toolkit.slug,
    name: account.toolkit.slug,
    description: "",
    logo: "",
    connected: true,
    connectedAccountId: account.id,
  }));
  const statusBySlug = new Map(
    sessionRows.map((row) => [normalizeToolkitSlug(row.slug), row] as const),
  );

  const toolkits = catalog.map((toolkit) => {
    const status = statusBySlug.get(normalizeToolkitSlug(toolkit.slug));
    return {
      slug: toolkit.slug,
      name: toolkit.name,
      description: toolkit.description,
      logo: toolkit.logo,
      ...(toolkit.category ? { category: toolkit.category } : {}),
      connected: Boolean(status?.connected && status.connectedAccountId),
      ...(status?.connectedAccountId ? { connectedAccountId: status.connectedAccountId } : {}),
    } satisfies CatalogToolkitView;
  });

  toolkits.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { toolkits, total: toolkits.length };
}

async function fetchToolkitMetadata(slug: string): Promise<{
  name: string;
  description: string;
  logo: string;
  category?: string;
}> {
  type ToolkitRow = {
    slug?: string;
    name?: string;
    meta?: { description?: string; logo?: string };
    description?: string;
    logo?: string;
    category?: string;
  };

  const paths = [
    `/api/v3.1/toolkits/${encodeURIComponent(slug)}`,
    `/api/v3/toolkits/${encodeURIComponent(slug)}`,
  ];
  for (const path of paths) {
    try {
      const data = await composioRequest<ToolkitRow>({ path });
      return {
        name: String(data.name ?? slug),
        description: String(data.meta?.description ?? data.description ?? ""),
        logo: String(data.meta?.logo ?? data.logo ?? ""),
        ...(data.category ? { category: data.category } : {}),
      };
    } catch {
      // try next path
    }
  }

  const catalog = await listToolkits();
  const match = catalog.find((row) => normalizeToolkitSlug(row.slug) === normalizeToolkitSlug(slug));
  if (match) {
    return {
      name: match.name,
      description: match.description,
      logo: match.logo,
      ...(match.category ? { category: match.category } : {}),
    };
  }

  return { name: slug, description: "", logo: "" };
}

/** Scoped catalogue lookup — one toolkit (+ optional triggers) without loading the full catalogue. */
export async function getToolkitCatalogEntry(
  auth: AuthContext,
  toolkit: string,
  options?: { includeTriggers?: boolean },
): Promise<{ toolkit: CatalogToolkitView; triggers?: ComposioTriggerTypeRow[] }> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }

  const slug = await resolveToolkitSlug(toolkit);
  const [connection, metadata] = await Promise.all([
    getToolkitConnectionStatus(auth, slug),
    fetchToolkitMetadata(slug),
  ]);

  const entry: CatalogToolkitView = {
    slug,
    name: metadata.name,
    description: metadata.description,
    logo: metadata.logo,
    ...(metadata.category ? { category: metadata.category } : {}),
    connected: connection.connected,
    ...(connection.connectedAccountId ? { connectedAccountId: connection.connectedAccountId } : {}),
  };

  const triggers = options?.includeTriggers ? await listComposioTriggerTypes(slug) : undefined;
  return { toolkit: entry, ...(triggers ? { triggers } : {}) };
}

export async function getToolkitConnectionStatus(
  auth: AuthContext,
  toolkit: string,
): Promise<ToolkitConnectionStatus> {
  const slug = await resolveToolkitSlug(toolkit);
  if (!slug || !isComposioConfigured()) {
    return { toolkit: slug || toolkit, connected: false, status: "disconnected" };
  }
  const accounts = await listDirectConnectedAccounts(auth);
  const match = accounts.find((row) => normalizeToolkitSlug(row.toolkit.slug) === normalizeToolkitSlug(slug));
  const connected = Boolean(match?.id);
  return {
    toolkit: slug,
    connected,
    ...(match?.id ? { connectedAccountId: match.id } : {}),
    status: connected ? "connected" : "disconnected",
  };
}

export async function startToolkitAuthorization(
  auth: AuthContext,
  toolkit: string,
  options?: { callbackUrl?: string },
): Promise<{
  sessionId: string;
  redirectUrl: string;
  connectionRequestId: string;
  toolkit: string;
}> {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const normalized = await resolveToolkitSlug(toolkit);
  const authConfigId = await resolveAuthConfigId(normalized);
  const request = await getComposioClient().connectedAccounts.link(
    getComposioEntityId(auth),
    authConfigId,
    { ...(options?.callbackUrl ? { callbackUrl: options.callbackUrl } : {}) },
  );
  if (!request.redirectUrl) throw new Error(`Composio did not return a redirect URL for toolkit "${normalized}"`);
  await upsertConnectorConnection({
    auth,
    provider: "composio",
    toolkit: normalized,
    externalAccountId: request.id,
    externalRequestId: request.id,
    status: "pending",
  });
  return {
    sessionId: request.id,
    redirectUrl: request.redirectUrl,
    connectionRequestId: request.id,
    toolkit: normalized,
  };
}

export async function verifyToolkitConnection(
  auth: AuthContext,
  input: { connectionRequestId?: string; toolkit?: string; timeoutMs?: number },
): Promise<ToolkitConnectionStatus> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }

  const pending = input.connectionRequestId
    ? await findConnectorConnectionByRequest({
        auth,
        provider: "composio",
        externalRequestId: input.connectionRequestId,
      })
    : null;
  if (input.connectionRequestId && !pending) {
    throw new Error("Connector authorization request not found for this workspace");
  }
  const toolkit = await resolveToolkitSlug(input.toolkit ?? pending?.toolkit ?? "");
  if (!toolkit) throw new Error("Toolkit is required");

  if (input.connectionRequestId) {
    try {
      const account = await getComposioClient().connectedAccounts.waitForConnection(
        input.connectionRequestId,
        input.timeoutMs ?? 5_000,
      );
      await upsertConnectorConnection({
        auth,
        provider: "composio",
        toolkit,
        externalAccountId: account.id,
        externalRequestId: input.connectionRequestId,
        status: account.status === "ACTIVE" ? "connected" : "pending",
      });
    } catch {
      // Fall through to live toolkit listing.
    }
    invalidateWorkspaceConnectorsCache(auth);
  }

  const status = await getToolkitConnectionStatus(auth, toolkit);
  if (!status.connected) {
    return { ...status, status: pending ? "pending" : "disconnected" };
  }
  await upsertConnectorConnection({
    auth,
    provider: "composio",
    toolkit,
    externalAccountId: status.connectedAccountId,
    externalRequestId: input.connectionRequestId,
    status: "connected",
  });
  return status;
}

export async function disconnectToolkit(auth: AuthContext, toolkit: string): Promise<{ ok: true }> {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const status = await getToolkitConnectionStatus(auth, toolkit);
  if (!status.connectedAccountId) {
    throw new Error(`${normalizeToolkitSlug(toolkit)} is not connected`);
  }
  await getComposioClient().connectedAccounts.delete(status.connectedAccountId);
  await upsertConnectorConnection({
    auth,
    provider: "composio",
    toolkit: await resolveToolkitSlug(toolkit),
    externalAccountId: status.connectedAccountId,
    status: "disconnected",
  });
  invalidateWorkspaceConnectorsCache(auth);
  return { ok: true };
}

export async function resolveConnectedAccountId(
  auth: AuthContext,
  toolkit: string,
): Promise<string | null> {
  const status = await getToolkitConnectionStatus(auth, toolkit);
  return status.connectedAccountId ?? null;
}

export async function listConnectedToolkitsForAuth(auth: AuthContext): Promise<ComposioToolkitView[]> {
  if (!isComposioConfigured()) return [];
  const accounts = await listDirectConnectedAccounts(auth);
  return accounts.map((account) => ({
    slug: account.toolkit.slug,
    name: account.toolkit.slug,
    description: "",
    logo: "",
    connected: true,
    connectedAccountId: account.id,
  }));
}
