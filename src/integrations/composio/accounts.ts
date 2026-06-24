import type { AuthContext } from "../../domain/auth/index.js";
import { authorizeToolkitForUser, normalizeToolkitSlug } from "./auth.js";
import { composioRequest, isComposioConfigured } from "./client.js";
import {
  clearSessionCache,
  createSession,
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

export async function getToolkitConnectionStatus(
  auth: AuthContext,
  toolkit: string,
): Promise<ToolkitConnectionStatus> {
  const slug = normalizeToolkitSlug(toolkit);
  if (!slug || !isComposioConfigured()) {
    return { toolkit: slug || toolkit, connected: false, status: "disconnected" };
  }
  const { toolkits } = await listToolkitsForUser(auth, { limit: 50, search: slug });
  const match = toolkits.find((row) => row.slug.toLowerCase() === slug.toLowerCase());
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
  const normalized = normalizeToolkitSlug(toolkit);
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
  const toolkit = normalizeToolkitSlug(input.toolkit ?? pending?.toolkit ?? "");
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
