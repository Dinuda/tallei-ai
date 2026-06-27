import type { AuthContext } from "../../domain/auth/index.js";
import { authorizeToolkitForUser, normalizeToolkitSlug, resolveToolkitSlug } from "./auth.js";
import { composioRequest, isComposioConfigured } from "./client.js";
import { listComposioTriggerTypes, type ComposioTriggerTypeRow } from "./triggers.js";
import { listToolkits } from "./tools.js";
import {
  clearSessionCache,
  createSession,
  listAllSessionToolkits,
  listSessionToolkits,
  listToolkitsForUser,
} from "./session.js";
import type { ComposioConnectedAccount, ComposioToolkitView } from "./types.js";

export type WorkspaceConnectorView = {
  slug: string;
  name: string;
  description: string;
  logo: string;
  connected: boolean;
  connectedAccountId?: string;
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

type PendingAuthorization = {
  auth: AuthContext;
  toolkit: string;
  sessionId: string;
  waitForConnection: (timeout?: number) => Promise<ComposioConnectedAccount>;
  expiresAt: number;
};

const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingAuthorizations = new Map<string, PendingAuthorization>();

function prunePendingAuthorizations(): void {
  const now = Date.now();
  for (const [key, value] of pendingAuthorizations) {
    if (value.expiresAt <= now) pendingAuthorizations.delete(key);
  }
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

export async function listWorkspaceConnectors(auth: AuthContext): Promise<WorkspaceConnectorView[]> {
  if (!isComposioConfigured()) return [];
  const { toolkits } = await listToolkitsForUser(auth, { limit: 50 });
  return toolkits.map(mapToolkitView);
}

/** Full Composio catalogue merged with workspace connection status (connected-first planning). */
export async function listAllToolkitsWithStatus(auth: AuthContext): Promise<{
  toolkits: CatalogToolkitView[];
  total: number;
}> {
  if (!isComposioConfigured()) return { toolkits: [], total: 0 };

  const [catalog, session] = await Promise.all([
    listToolkits(),
    createSession(auth),
  ]);
  const sessionRows = await listAllSessionToolkits(session);
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
  const { toolkits } = await listToolkitsForUser(auth, { limit: 50, search: slug });
  const match = toolkits.find((row) => normalizeToolkitSlug(row.slug) === normalizeToolkitSlug(slug));
  const connected = Boolean(match?.connected && match.connectedAccountId);
  return {
    toolkit: slug,
    connected,
    ...(match?.connectedAccountId ? { connectedAccountId: match.connectedAccountId } : {}),
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
  const { session, redirectUrl, connectionRequestId, waitForConnection } = await authorizeToolkitForUser(
    auth,
    normalized,
    { callbackUrl: options?.callbackUrl },
  );
  prunePendingAuthorizations();
  pendingAuthorizations.set(connectionRequestId, {
    auth,
    toolkit: normalized,
    sessionId: session.sessionId,
    waitForConnection,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  return { sessionId: session.sessionId, redirectUrl, connectionRequestId, toolkit: normalized };
}

export async function verifyToolkitConnection(
  auth: AuthContext,
  input: { connectionRequestId?: string; toolkit?: string; timeoutMs?: number },
): Promise<ToolkitConnectionStatus> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }

  prunePendingAuthorizations();
  const pending = input.connectionRequestId
    ? pendingAuthorizations.get(input.connectionRequestId)
    : undefined;
  const toolkit = await resolveToolkitSlug(input.toolkit ?? pending?.toolkit ?? "");
  if (!toolkit) throw new Error("Toolkit is required");

  if (pending) {
    try {
      await pending.waitForConnection(input.timeoutMs ?? 5_000);
    } catch {
      // Fall through to live toolkit listing.
    }
    pendingAuthorizations.delete(input.connectionRequestId!);
    clearSessionCache();
  }

  const status = await getToolkitConnectionStatus(auth, toolkit);
  if (!status.connected) {
    return { ...status, status: pending ? "pending" : "disconnected" };
  }
  return status;
}

export async function disconnectToolkit(auth: AuthContext, toolkit: string): Promise<{ ok: true }> {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const status = await getToolkitConnectionStatus(auth, toolkit);
  if (!status.connectedAccountId) {
    throw new Error(`${normalizeToolkitSlug(toolkit)} is not connected`);
  }
  const accountId = status.connectedAccountId;
  const paths = [
    `/api/v3/connected_accounts/${encodeURIComponent(accountId)}`,
    `/api/v3.1/connected_accounts/${encodeURIComponent(accountId)}`,
  ];
  let lastError: Error | null = null;
  for (const path of paths) {
    try {
      await composioRequest({ path, method: "DELETE" });
      clearSessionCache();
      return { ok: true };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Failed to disconnect toolkit");
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
  const session = await createSession(auth);
  return listSessionToolkits(session, { isConnected: true, limit: 50 });
}
