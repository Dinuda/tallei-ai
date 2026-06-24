import type { AuthContext } from "../../domain/auth/index.js";
import { getOrCreateSession } from "./session.js";
import type {
  ComposioAgentSession,
  ComposioAuthorizeResult,
  ComposioConnectedAccount,
  CreateSessionOptions,
} from "./types.js";

export function normalizeToolkitSlug(slug: string): string {
  const key = slug.trim().toLowerCase();
  if (!key) return "";
  if (key === "google_calendar") return "googlecalendar";
  if (key === "google-mail" || key === "googlemail") return "gmail";
  if (key === "resend_email") return "resend";
  return key;
}

export async function authorizeToolkit(
  session: ComposioAgentSession,
  toolkit: string,
  options?: { callbackUrl?: string },
): Promise<ComposioAuthorizeResult> {
  const normalized = normalizeToolkitSlug(toolkit);
  const request = await session.client.authorize(normalized, {
    ...(options?.callbackUrl ? { callbackUrl: options.callbackUrl } : {}),
  });
  const redirectUrl = request.redirectUrl ?? "";
  if (!redirectUrl) throw new Error(`Composio did not return a redirect URL for toolkit "${normalized}"`);
  return {
    redirectUrl,
    connectionRequestId: request.id,
    waitForConnection: async (timeout?: number) => {
      const connected = await request.waitForConnection(timeout);
      return {
        id: connected.id,
        status: connected.status,
      } satisfies ComposioConnectedAccount;
    },
  };
}

export async function authorizeToolkitForUser(
  auth: AuthContext,
  toolkit: string,
  options?: { callbackUrl?: string; sessionOptions?: CreateSessionOptions; existingSessionId?: string | null },
): Promise<ComposioAuthorizeResult & { session: ComposioAgentSession }> {
  const session = await getOrCreateSession(auth, options?.existingSessionId ?? null, options?.sessionOptions);
  const authorization = await authorizeToolkit(session, toolkit, { callbackUrl: options?.callbackUrl });
  return { session, ...authorization };
}
