import { createHash } from "node:crypto";
import { Router } from "express";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { pool } from "../../../infrastructure/db/index.js";
import { config } from "../../../config/index.js";
import { parseScopes } from "../../../infrastructure/auth/oauth-tokens.js";
import { deleteCacheKey } from "../../../infrastructure/cache/redis-cache.js";
import { generateApiKey } from "../../../infrastructure/auth/auth.js";

const router = Router();

router.use(authMiddleware);

const CONNECTING_WINDOW_MS = 2 * 60 * 1000;
const CHATGPT_RECENT_SUCCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

type Provider = "claude" | "chatgpt";
type IntegrationState = "not_connected" | "connecting" | "connected" | "error";

type IntegrationEventRow = {
  method: string;
  ok: boolean;
  error: string | null;
  created_at: Date;
};

type IntegrationStatus = {
  state: IntegrationState;
  connected: boolean;
  lastConnectedAt: Date | null;
  lastEventAt: Date | null;
  lastError: string | null;
  canDisconnect: boolean;
};

type OAuthTokenRow = {
  access_token: string;
  scope: string | null;
  resource: string | null;
  grant_type: string | null;
  client_info: Record<string, unknown> | null;
  created_at: Date;
};

type ActiveChatGptApiKeyRow = {
  id: string;
  key_hash: string;
  created_at: Date;
  last_used_at: Date | null;
};

function toMillis(value: Date): number {
  return value.getTime();
}

function isRecent(value: Date, windowMs: number): boolean {
  return Date.now() - toMillis(value) <= windowMs;
}

function isNewer(a: Date, b: Date): boolean {
  return toMillis(a) > toMillis(b);
}

function oauthValidationCacheKey(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex");
  return `auth:oauth:v2:${hash}`;
}

function mcpOauthCacheKey(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex");
  return `auth:oauth:${hash}`;
}

function apiKeyValidationCacheKey(hash: string): string {
  return `auth:api_key_v2:${hash}`;
}

async function invalidateOAuthTokenCaches(accessTokens: string[]): Promise<void> {
  const unique = Array.from(new Set(accessTokens.filter((token) => token.length > 0)));
  await Promise.all(
    unique.flatMap((token) => [
      deleteCacheKey(oauthValidationCacheKey(token)),
      deleteCacheKey(mcpOauthCacheKey(token)),
    ])
  );
}

async function invalidateApiKeyValidationCaches(keyHashes: string[]): Promise<void> {
  const unique = Array.from(new Set(keyHashes.filter((hash) => hash.length > 0)));
  await Promise.all(unique.map((hash) => deleteCacheKey(apiKeyValidationCacheKey(hash))));
}

function extractRedirectUris(clientInfo: Record<string, unknown> | null): string[] {
  if (!clientInfo || !Array.isArray(clientInfo.redirect_uris)) return [];
  return clientInfo.redirect_uris.filter((value): value is string => typeof value === "string");
}

function isServicePrincipalClient(clientInfo: Record<string, unknown> | null): boolean {
  if (!clientInfo) return false;
  return Boolean(clientInfo.tallei_service_principal && typeof clientInfo.tallei_service_principal === "object");
}

function isTokenForProvider(token: OAuthTokenRow, provider: Provider): boolean {
  if (token.grant_type === "client_credentials") return false;
  if (isServicePrincipalClient(token.client_info)) return false;

  const scopes = parseScopes(token.scope);
  const hasMcpToolsScope = scopes.includes("mcp:tools");
  const resource = (token.resource ?? "").toLowerCase();
  const hasMcpResource = resource.includes("/mcp");
  const redirectUris = extractRedirectUris(token.client_info).map((value) => value.toLowerCase());
  const hasClaudeRedirect = redirectUris.some((value) => value.includes("claude.ai") || value.includes("anthropic.com"));
  const hasChatGptRedirect = redirectUris.some(
    (value) => value.includes("chatgpt.com") || value.includes("chat.openai.com") || value.includes("openai.com")
  );

  if (provider === "claude") {
    return hasMcpToolsScope || hasMcpResource || hasClaudeRedirect;
  }

  if (hasChatGptRedirect) return true;
  if (hasMcpToolsScope || hasMcpResource || hasClaudeRedirect) return false;

  // Default any remaining end-user OAuth token to ChatGPT actions flow.
  return true;
}

async function getActiveUserOAuthTokens(userId: string): Promise<OAuthTokenRow[]> {
  const result = await pool.query<OAuthTokenRow>(
    `SELECT ot.access_token, ot.scope, ot.resource, ot.grant_type, oc.client_info, ot.created_at
     FROM oauth_tokens ot
     LEFT JOIN oauth_clients oc ON oc.client_id = ot.client_id
     WHERE ot.user_id = $1
       AND ot.revoked_at IS NULL
       AND ot.refresh_expires_at > NOW()
       AND COALESCE(ot.grant_type, 'authorization_code') <> 'client_credentials'
     ORDER BY ot.created_at DESC
     LIMIT 300`,
    [userId]
  );
  return result.rows;
}

async function getActiveChatGptApiKeys(userId: string): Promise<ActiveChatGptApiKeyRow[]> {
  const result = await pool.query<ActiveChatGptApiKeyRow>(
    `SELECT id, key_hash, created_at, last_used_at
     FROM api_keys
     WHERE user_id = $1
       AND connector_type = 'chatgpt'
       AND revoked_at IS NULL
       AND (created_at + (rotation_days || ' days')::interval) > NOW()
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId]
  );
  return result.rows;
}

function deriveClaudeStatus(events: IntegrationEventRow[], hasActiveToken: boolean): IntegrationStatus {
  const latest = events[0] ?? null;
  const latestError = events.find((event) => !event.ok) ?? null;
  const lastSuccess = events.find((event) => event.ok) ?? null;
  const lastToolSuccess = events.find((event) => event.ok && event.method === "tools/call") ?? null;
  const lastInitializeSuccess = events.find((event) => event.ok && event.method === "initialize") ?? null;
  const fallbackConnectedAt =
    lastToolSuccess?.created_at ?? lastInitializeSuccess?.created_at ?? lastSuccess?.created_at ?? null;

  if (!hasActiveToken) {
    return {
      state: "not_connected",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: latest?.created_at ?? null,
      lastError: null,
      canDisconnect: false,
    };
  }

  if (!latest) {
    return {
      state: "connecting",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
      canDisconnect: true,
    };
  }

  if (latestError && (!lastSuccess || isNewer(latestError.created_at, lastSuccess.created_at))) {
    return {
      state: "error",
      connected: false,
      lastConnectedAt: fallbackConnectedAt,
      lastEventAt: latest.created_at,
      lastError: latestError.error ?? "Connection attempt failed",
      canDisconnect: true,
    };
  }

  if (lastToolSuccess) {
    return {
      state: "connected",
      connected: true,
      lastConnectedAt: lastToolSuccess.created_at,
      lastEventAt: latest.created_at,
      lastError: null,
      canDisconnect: true,
    };
  }

  if (lastInitializeSuccess) {
    const initializing = isRecent(lastInitializeSuccess.created_at, CONNECTING_WINDOW_MS);
    return {
      state: initializing ? "connecting" : "connected",
      connected: !initializing,
      lastConnectedAt: initializing ? null : lastInitializeSuccess.created_at,
      lastEventAt: latest.created_at,
      lastError: null,
      canDisconnect: true,
    };
  }

  if (lastSuccess && isRecent(lastSuccess.created_at, CONNECTING_WINDOW_MS)) {
    return {
      state: "connecting",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: latest.created_at,
      lastError: null,
      canDisconnect: true,
    };
  }

  return {
    state: "connected",
    connected: true,
    lastConnectedAt: fallbackConnectedAt,
    lastEventAt: latest.created_at,
    lastError: null,
    canDisconnect: true,
  };
}

function newestCreatedAt(items: Array<{ created_at: Date }>): Date | null {
  if (items.length === 0) return null;
  return items.reduce((latest, item) => (isNewer(item.created_at, latest) ? item.created_at : latest), items[0].created_at);
}

function isFreshSuccessSince(lastSuccess: IntegrationEventRow | null, credentialCreatedAt: Date | null): boolean {
  if (!lastSuccess) return false;
  if (!credentialCreatedAt) return true;
  return toMillis(lastSuccess.created_at) >= toMillis(credentialCreatedAt);
}

function deriveChatGptStatus(
  events: IntegrationEventRow[],
  hasCredential: boolean,
  credentialCreatedAt: Date | null
): IntegrationStatus {
  const latest = events[0] ?? null;
  const latestError = events.find((event) => !event.ok) ?? null;
  const lastSuccess = events.find((event) => event.ok) ?? null;
  const hasFreshSuccess = isFreshSuccessSince(lastSuccess, credentialCreatedAt);
  const hasRecentSuccess = Boolean(lastSuccess && isRecent(lastSuccess.created_at, CHATGPT_RECENT_SUCCESS_WINDOW_MS));

  if (!hasCredential) {
    if (hasRecentSuccess && lastSuccess) {
      return {
        state: "connected",
        connected: true,
        lastConnectedAt: lastSuccess.created_at,
        lastEventAt: latest?.created_at ?? lastSuccess.created_at,
        lastError: null,
        canDisconnect: false,
      };
    }
    return {
      state: "not_connected",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: latest?.created_at ?? null,
      lastError: null,
      canDisconnect: false,
    };
  }

  if (!latest) {
    return {
      state: "connecting",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
      canDisconnect: true,
    };
  }

  if (latestError && (!lastSuccess || isNewer(latestError.created_at, lastSuccess.created_at))) {
    return {
      state: "error",
      connected: false,
      lastConnectedAt: lastSuccess?.created_at ?? null,
      lastEventAt: latest.created_at,
      lastError: latestError.error ?? "Action call failed",
      canDisconnect: true,
    };
  }

  if (hasFreshSuccess && lastSuccess) {
    return {
      state: "connected",
      connected: true,
      lastConnectedAt: lastSuccess.created_at,
      lastEventAt: latest.created_at,
      lastError: null,
      canDisconnect: true,
    };
  }

  return {
    state: "connecting",
    connected: false,
    lastConnectedAt: null,
    lastEventAt: latest.created_at,
    lastError: latestError?.error ?? null,
    canDisconnect: true,
  };
}

router.get("/status", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const result = await pool.query<IntegrationEventRow>(
      `SELECT method, ok, error, created_at
       FROM mcp_call_events
       WHERE user_id = $1
         AND (
           method LIKE 'chatgpt/actions/%'
           OR auth_mode = 'oauth'
         )
       ORDER BY created_at DESC
       LIMIT 250`,
      [userId]
    );

    const rows = result.rows;
    const [activeTokens, activeChatgptApiKeys] = await Promise.all([
      getActiveUserOAuthTokens(userId),
      getActiveChatGptApiKeys(userId),
    ]);
    const claudeEvents = rows.filter((row) => !row.method.startsWith("chatgpt/actions/"));
    const chatgptEvents = rows.filter((row) => row.method.startsWith("chatgpt/actions/"));
    const activeClaudeTokens = activeTokens.filter((token) => isTokenForProvider(token, "claude"));
    const activeChatgptTokens = activeTokens.filter((token) => isTokenForProvider(token, "chatgpt"));
    const claudeCredentialCreatedAt = newestCreatedAt(activeClaudeTokens);
    const chatgptCredentialCreatedAt = newestCreatedAt([
      ...activeChatgptTokens,
      ...activeChatgptApiKeys,
    ]);

    const claudeBase = deriveClaudeStatus(claudeEvents, activeClaudeTokens.length > 0);
    const claudeLastSuccess = claudeEvents.find((event) => event.ok) ?? null;
    const claudeHasFreshSuccess = isFreshSuccessSince(claudeLastSuccess, claudeCredentialCreatedAt);
    const claude =
      claudeBase.state === "connected" && !claudeHasFreshSuccess
        ? {
            ...claudeBase,
            state: "connecting" as const,
            connected: false,
            lastConnectedAt: null,
          }
        : claudeBase;
    const chatgpt = deriveChatGptStatus(
      chatgptEvents,
      activeChatgptTokens.length > 0 || activeChatgptApiKeys.length > 0,
      chatgptCredentialCreatedAt
    );

    res.json({
      integrations: {
        claude,
        chatgpt: {
          ...chatgpt,
          hasBearerToken: activeChatgptApiKeys.length > 0,
          lastTokenUsedAt: activeChatgptApiKeys[0]?.last_used_at ?? null,
          lastTokenCreatedAt: activeChatgptApiKeys[0]?.created_at ?? null,
        },
      },
      polledAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching integration status:", error);
    res.status(500).json({ error: "Failed to fetch integration status" });
  }
});

router.get("/chatgpt/token", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const keys = await getActiveChatGptApiKeys(userId);
    const newest = keys[0] ?? null;
    res.json({
      hasActiveToken: keys.length > 0,
      activeTokenCount: keys.length,
      lastTokenCreatedAt: newest?.created_at ?? null,
      lastTokenUsedAt: newest?.last_used_at ?? null,
      maskedToken: keys.length > 0 ? "****************" : null,
      rawToken: null,
    });
  } catch (error) {
    console.error("Error fetching ChatGPT token status:", error);
    res.status(500).json({ error: "Failed to fetch ChatGPT token status" });
  }
});

router.post("/chatgpt/token", requireScopes(["memory:write"]), async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const rotateRequested = Boolean(
      req.body &&
      typeof req.body === "object" &&
      "rotate" in (req.body as Record<string, unknown>) &&
      (req.body as Record<string, unknown>).rotate === true
    );

    const activeKeys = await getActiveChatGptApiKeys(userId);
    const activeKey = activeKeys[0] ?? null;
    if (activeKey && !rotateRequested) {
      res.json({
        success: true,
        created: false,
        hasActiveToken: true,
        activeTokenCount: activeKeys.length,
        lastTokenCreatedAt: activeKey.created_at,
        lastTokenUsedAt: activeKey.last_used_at ?? null,
        maskedToken: "****************",
        rawToken: null,
        message: "A ChatGPT bearer token already exists. Using the existing token.",
      });
      return;
    }

    if (config.nodeEnv !== "production") {
      console.warn("[integrations] chatgpt token creation requested", {
        userId,
        rotateRequested,
        userAgent: req.get("user-agent") ?? null,
      });
    }

    const revokeExistingBeforeCreate = await pool.query<{ key_hash: string }>(
      `UPDATE api_keys
       SET revoked_at = NOW()
       WHERE user_id = $1
         AND connector_type = 'chatgpt'
         AND revoked_at IS NULL
       RETURNING key_hash`,
      [userId]
    );
    await invalidateApiKeyValidationCaches(revokeExistingBeforeCreate.rows.map((row) => row.key_hash));

    const generated = await generateApiKey(
      userId,
      "ChatGPT Action Bearer",
      365,
      req.authContext?.tenantId ?? null,
      "chatgpt",
      "tly",
      { allowEphemeralFallback: false }
    );

    const createdAt = new Date().toISOString();
    res.status(201).json({
      success: true,
      created: true,
      hasActiveToken: true,
      activeTokenCount: 1,
      keyId: generated.id,
      createdAt,
      lastTokenCreatedAt: createdAt,
      lastTokenUsedAt: null,
      maskedToken: "****************",
      rawToken: generated.key,
      message: rotateRequested
        ? "ChatGPT bearer token rotated and stored securely."
        : "ChatGPT bearer token created and stored securely.",
    });
  } catch (error) {
    console.error("Error creating ChatGPT bearer token:", error);
    res.status(500).json({ error: "Failed to create ChatGPT bearer token" });
  }
});

router.post("/disconnect/:provider", requireScopes(["memory:write"]), async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const provider = req.params.provider;
    if (provider !== "claude" && provider !== "chatgpt") {
      res.status(400).json({ error: "Unsupported provider", supportedProviders: ["claude", "chatgpt"] });
      return;
    }

    const activeTokens = await getActiveUserOAuthTokens(userId);
    const targetTokens = activeTokens.filter((token) => isTokenForProvider(token, provider));
    const targetAccessTokens = targetTokens.map((token) => token.access_token);

    let revokedApiKeys = 0;

    if (provider === "chatgpt") {
      const revokeChatGptApiKeys = await pool.query<{ key_hash: string }>(
        `UPDATE api_keys
         SET revoked_at = NOW()
         WHERE user_id = $1
           AND connector_type = 'chatgpt'
           AND revoked_at IS NULL
         RETURNING key_hash`,
        [userId]
      );
      revokedApiKeys = revokeChatGptApiKeys.rowCount ?? 0;
      await invalidateApiKeyValidationCaches(revokeChatGptApiKeys.rows.map((row) => row.key_hash));
      if (revokedApiKeys > 0 && config.nodeEnv !== "production") {
        console.warn("[integrations] chatgpt disconnect revoked API keys", {
          userId,
          revokedApiKeys,
        });
      }
    }

    if (targetAccessTokens.length === 0 && revokedApiKeys === 0) {
      res.json({
        success: true,
        provider,
        revoked: 0,
        message: `No active ${provider} connector sessions found.`,
      });
      return;
    }

    const revokeResult = await pool.query(
      `UPDATE oauth_tokens
       SET revoked_at = NOW()
       WHERE user_id = $1
         AND revoked_at IS NULL
         AND access_token = ANY($2::text[])`,
      [userId, targetAccessTokens]
    );

    await invalidateOAuthTokenCaches(targetAccessTokens);

    res.json({
      success: true,
      provider,
      revoked: (revokeResult.rowCount ?? 0) + revokedApiKeys,
      message: `${provider} connector disconnected.`,
    });
  } catch (error) {
    console.error("Error disconnecting integration:", error);
    res.status(500).json({ error: "Failed to disconnect integration" });
  }
});

export default router;
