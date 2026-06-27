import type { ToolRouterCreateSessionConfig } from "@composio/core";

import type { AuthContext } from "../../domain/auth/index.js";
import { getComposioClient, getComposioEntityId, isComposioConfigured } from "./client.js";
import type {
  ComposioAgentSession,
  ComposioToolkitView,
  CreateSessionOptions,
} from "./types.js";

const sessionCache = new Map<string, { session: ComposioAgentSession; cachedAt: number }>();
const SESSION_TTL_MS = 60 * 60 * 1000;

function mapSessionOptions(options?: CreateSessionOptions): ToolRouterCreateSessionConfig | undefined {
  if (!options) return undefined;
  return {
    ...(options.toolkits !== undefined ? { toolkits: options.toolkits } : {}),
    ...(options.preload !== undefined ? { preload: options.preload } : {}),
    ...(options.authConfigs !== undefined ? { authConfigs: options.authConfigs } : {}),
    ...(options.connectedAccounts !== undefined ? { connectedAccounts: options.connectedAccounts } : {}),
    ...(options.workbench !== undefined ? { workbench: options.workbench } : {}),
    ...(options.manageConnections !== undefined ? { manageConnections: options.manageConnections } : {}),
  } as ToolRouterCreateSessionConfig;
}

function toAgentSession(userId: string, client: ComposioAgentSession["client"]): ComposioAgentSession {
  return {
    sessionId: client.sessionId,
    userId,
    client,
  };
}

function cacheSession(session: ComposioAgentSession): ComposioAgentSession {
  sessionCache.set(session.sessionId, { session, cachedAt: Date.now() });
  return session;
}

export async function createSession(
  auth: AuthContext,
  options?: CreateSessionOptions,
): Promise<ComposioAgentSession> {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const composio = getComposioClient();
  const userId = getComposioEntityId(auth);
  const client = await composio.create(userId, mapSessionOptions(options));
  return cacheSession(toAgentSession(userId, client));
}

export async function useSession(sessionId: string): Promise<ComposioAgentSession> {
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.cachedAt < SESSION_TTL_MS) return cached.session;
  sessionCache.delete(sessionId);

  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const composio = getComposioClient();
  const client = await composio.use(sessionId);
  return cacheSession(toAgentSession("unknown", client));
}

export async function getOrCreateSession(
  auth: AuthContext,
  existingSessionId?: string | null,
  options?: CreateSessionOptions,
): Promise<ComposioAgentSession> {
  if (existingSessionId) return useSession(existingSessionId);
  return createSession(auth, options);
}

export function invalidateSession(sessionId: string): void {
  sessionCache.delete(sessionId);
}

export function clearSessionCache(): void {
  sessionCache.clear();
}

function mapToolkitItem(item: {
  slug: string;
  name: string;
  logo?: string;
  connection?: {
    isActive?: boolean;
    connectedAccount?: { id?: string; status?: string };
  };
}): ComposioToolkitView {
  const connected = Boolean(item.connection?.isActive);
  const connectedAccountId = item.connection?.connectedAccount?.id;
  return {
    slug: item.slug,
    name: item.name,
    description: "",
    logo: item.logo ?? "",
    connected,
    ...(connectedAccountId ? { connectedAccountId } : {}),
  };
}

export async function listSessionToolkits(
  session: ComposioAgentSession,
  options?: { limit?: number; search?: string; isConnected?: boolean; page?: number },
): Promise<ComposioToolkitView[]> {
  const limit =
    options?.limit !== undefined
      ? Math.max(1, Math.min(options.limit, 50))
      : undefined;
  const response = await session.client.toolkits({
    ...(limit !== undefined ? { limit } : {}),
    ...(options?.page !== undefined ? { page: options.page } : {}),
    ...(options?.search ? { search: options.search } : {}),
    ...(options?.isConnected !== undefined ? { isConnected: options.isConnected } : {}),
  });
  return (response.items ?? []).map(mapToolkitItem);
}

/** Paginate session toolkit rows to build a full connected-account map for the workspace entity. */
export async function listAllSessionToolkits(
  session: ComposioAgentSession,
  options?: { isConnected?: boolean },
): Promise<ComposioToolkitView[]> {
  const merged = new Map<string, ComposioToolkitView>();
  const maxPages = 20;
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await listSessionToolkits(session, {
      limit: 50,
      page,
      ...(options?.isConnected !== undefined ? { isConnected: options.isConnected } : {}),
    });
    if (batch.length === 0) break;
    for (const toolkit of batch) {
      merged.set(toolkit.slug.toLowerCase(), toolkit);
    }
    if (batch.length < 50) break;
  }
  return [...merged.values()];
}

export async function listToolkitsForUser(
  auth: AuthContext,
  options?: CreateSessionOptions & { limit?: number; search?: string; isConnected?: boolean },
): Promise<{ session: ComposioAgentSession; toolkits: ComposioToolkitView[] }> {
  const { limit, search, isConnected, ...sessionOptions } = options ?? {};
  const session = await createSession(auth, sessionOptions);
  const toolkits = await listSessionToolkits(session, { limit, search, isConnected });
  return { session, toolkits };
}

export async function getSessionTools(session: ComposioAgentSession): Promise<unknown> {
  return session.client.tools();
}

export function getSessionMcpUrl(session: ComposioAgentSession): string {
  return session.client.mcp.url;
}

export function getSessionMcpHeaders(session: ComposioAgentSession): Record<string, string> | undefined {
  return session.client.mcp.headers;
}
