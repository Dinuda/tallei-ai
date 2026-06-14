/**
 * composio-session.ts — Per-workflow Composio session lifecycle.
 *
 * A session scopes connected accounts and tool visibility to a single user.
 * We create one session at the start of a workflow build.
 * and expose its ID so the same session can be reused for discovery, planning,
 * and execution throughout that workflow.
 */

import type { Session } from "@composio/core";
import { VercelProvider } from "@composio/vercel";

import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { getComposioVercelClient } from "./composio.js";

export type ComposioSession = {
  sessionId: string;
  userId: string;
  client: Session<unknown, unknown, VercelProvider>;
};

const sessionCache = new Map<string, ComposioSession>();
const SESSION_TTL_MS = 60 * 60 * 1000;

function getComposioEntityId(auth: AuthContext): string {
  return `${config.composioEntityPrefix}:${auth.tenantId}:${auth.userId}`;
}

function isComposioConfigured(): boolean {
  return Boolean(config.composioApiKey && config.composioBaseUrl);
}

export async function createComposioSession(auth: AuthContext): Promise<ComposioSession> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }
  const composio = getComposioVercelClient();
  const userId = getComposioEntityId(auth);
  const session = await composio.create(userId);
  const view: ComposioSession = {
    sessionId: session.sessionId,
    userId,
    client: session,
  };
  sessionCache.set(session.sessionId, view);
  return view;
}

export async function useComposioSession(sessionId: string): Promise<ComposioSession> {
  const cached = sessionCache.get(sessionId);
  if (cached) return cached;

  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }
  const composio = getComposioVercelClient();
  const session = await composio.use(sessionId);
  const view: ComposioSession = {
    sessionId: session.sessionId,
    userId: "unknown",
    client: session,
  };
  sessionCache.set(session.sessionId, view);
  return view;
}

export async function getOrCreateComposioSession(
  auth: AuthContext,
  existingSessionId?: string | null,
): Promise<ComposioSession> {
  if (existingSessionId) {
    return useComposioSession(existingSessionId);
  }
  return createComposioSession(auth);
}

export function clearSessionCache(): void {
  sessionCache.clear();
}
