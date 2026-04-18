import { randomBytes } from "node:crypto";
import express, { Router } from "express";
import { verifyChallenge } from "pkce-challenge";
import { pool } from "../../../infrastructure/db/index.js";
import { config } from "../../../config/index.js";
import { introspectOAuthAccessToken, parseScopes } from "../../../infrastructure/auth/oauth-tokens.js";
import { deleteCacheKey } from "../../../infrastructure/cache/redis-cache.js";
import { ensurePrimaryTenantForUser, getPrimaryTenantId } from "../../../infrastructure/auth/tenancy.js";
import { AuthRequest, internalMiddleware } from "../middleware/auth.middleware.js";

const AUTH_CODE_DEFAULT_SCOPES = ["mcp:tools", "memory:read", "memory:write"];
const AUTOMATION_DEFAULT_SCOPES = ["memory:read", "memory:write", "automation:run"];
const SUPPORTED_SCOPES = new Set(["mcp:tools", "memory:read", "memory:write", "automation:run"]);
const DEVICE_CODE_TTL_SECONDS = 10 * 60;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLIENT_CREDENTIALS_ACCESS_TTL_SECONDS = 30 * 60;

function apiKeyValidationCacheKey(hash: string): string {
  return `auth:api_key_v2:${hash}`;
}

type ClientInfo = {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  token_endpoint_auth_method?: string;
  client_name?: string;
  [key: string]: unknown;
};

type DeviceCodeRow = {
  device_code: string;
  user_code: string;
  client_id: string;
  code_challenge: string;
  scope: string | null;
  resource: string | null;
  status: "pending" | "approved" | "denied" | "consumed";
  user_id: string | null;
  tenant_id: string | null;
  interval_seconds: number;
  expires_at: Date;
  last_polled_at: Date | null;
};

type ServicePrincipal = {
  user_id: string;
  tenant_id: string;
  allowed_scopes?: string[];
};

function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("hex")}`;
}

function createUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function sanitizeScopes(rawScope: string | undefined, fallback: string[]): string[] {
  const parsed = parseScopes(rawScope ?? null);
  const candidate = parsed.length > 0 ? parsed : fallback;
  const unique = Array.from(new Set(candidate));
  return unique.filter((scope) => SUPPORTED_SCOPES.has(scope));
}

function hasScopeSubset(requested: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return requested.every((scope) => allowedSet.has(scope));
}

function extractServicePrincipal(client: ClientInfo): ServicePrincipal | null {
  const raw = client.tallei_service_principal;
  if (!raw || typeof raw !== "object") return null;
  const principal = raw as Record<string, unknown>;
  if (typeof principal.user_id !== "string" || typeof principal.tenant_id !== "string") {
    return null;
  }
  const allowedScopes = Array.isArray(principal.allowed_scopes)
    ? principal.allowed_scopes.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    user_id: principal.user_id,
    tenant_id: principal.tenant_id,
    allowed_scopes: allowedScopes,
  };
}

async function loadClient(clientId: string): Promise<ClientInfo | null> {
  const result = await pool.query<{ client_info: ClientInfo }>(
    "SELECT client_info FROM oauth_clients WHERE client_id = $1",
    [clientId]
  );
  return result.rows[0]?.client_info ?? null;
}

function validateClientSecret(client: ClientInfo, providedSecret: string | undefined): string | null {
  if (!client.client_secret) return null;
  if (!providedSecret) return "Client secret is required";
  if (client.client_secret !== providedSecret) return "Invalid client secret";
  if (
    typeof client.client_secret_expires_at === "number" &&
    client.client_secret_expires_at > 0 &&
    client.client_secret_expires_at < Math.floor(Date.now() / 1000)
  ) {
    return "Client secret expired";
  }
  return null;
}

async function issueTokens(input: {
  clientId: string;
  userId: string;
  tenantId: string;
  scopes: string[];
  resource: string | null;
  grantType: "authorization_code" | "refresh_token" | "device_code" | "client_credentials";
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  includeRefreshToken: boolean;
}) {
  const accessToken = createOpaqueToken("tla_at");
  const refreshToken = createOpaqueToken("tla_rt");
  const scope = input.scopes.length > 0 ? input.scopes.join(" ") : null;

  await pool.query(
    `INSERT INTO oauth_tokens
     (access_token, refresh_token, client_id, tenant_id, user_id, scope, resource, access_expires_at, refresh_expires_at, grant_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8::int * INTERVAL '1 second'), NOW() + ($9::int * INTERVAL '1 second'), $10)`,
    [
      accessToken,
      refreshToken,
      input.clientId,
      input.tenantId,
      input.userId,
      scope,
      input.resource,
      input.accessTtlSeconds,
      input.refreshTtlSeconds,
      input.grantType,
    ]
  );

  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: input.accessTtlSeconds,
    refresh_token: input.includeRefreshToken ? refreshToken : undefined,
    scope: scope ?? undefined,
  };
}

async function getSessionUserId(req: express.Request): Promise<string | null> {
  try {
    const authCookie = req.headers.cookie;
    if (!authCookie) return null;

    const dashboardBaseUrl = process.env.FRONTEND_URL || "http://127.0.0.1:3001";
    const sessionRes = await fetch(`${dashboardBaseUrl}/api/auth/session`, {
      headers: { cookie: authCookie },
    });
    if (!sessionRes.ok) return null;
    const session = (await sessionRes.json()) as { user?: { id?: string } };
    return session.user?.id ?? null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loginRedirectUrl(nextPath: string): string {
  const safeNextPath = nextPath.startsWith("/") ? nextPath : "/api/oauth/device/activate";
  const url = new URL("/login", config.dashboardBaseUrl || config.frontendUrl || config.publicBaseUrl);
  url.searchParams.set("callbackUrl", safeNextPath);
  return url.toString();
}

function sendOauthError(res: express.Response, status: number, error: string, description: string) {
  res.status(status).json({
    error,
    error_description: description,
  });
}

const deviceAuthorizeSchema = {
  client_id: "string",
  code_challenge: "string",
  scope: "string",
  resource: "string",
} as const;

export function createOauthExtensionsRouter(): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  router.post("/device/authorize", async (req, res) => {
    const { client_id, code_challenge, scope, resource } = req.body as Record<string, string | undefined>;
    if (!client_id || !code_challenge) {
      sendOauthError(res, 400, "invalid_request", "Missing required fields: client_id and code_challenge.");
      return;
    }

    const client = await loadClient(client_id);
    if (!client) {
      sendOauthError(res, 400, "invalid_client", "Unknown OAuth client.");
      return;
    }

    if ((client.token_endpoint_auth_method ?? "none") !== "none") {
      sendOauthError(res, 400, "invalid_client", "Device flow requires a public client.");
      return;
    }

    const scopes = sanitizeScopes(scope, AUTH_CODE_DEFAULT_SCOPES);
    if (scope && scopes.length === 0) {
      sendOauthError(res, 400, "invalid_scope", "No supported scopes requested.");
      return;
    }

    const deviceCode = createOpaqueToken("tla_dc");
    const userCode = createUserCode();
    const verificationUri = new URL("/api/oauth/device/activate", config.publicBaseUrl).toString();
    const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;

    await pool.query(
      `INSERT INTO oauth_device_codes
       (device_code, user_code, client_id, code_challenge, scope, resource, interval_seconds, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8::int * INTERVAL '1 second'))`,
      [
        deviceCode,
        userCode,
        client_id,
        code_challenge,
        scopes.length > 0 ? scopes.join(" ") : null,
        resource ?? null,
        DEVICE_POLL_INTERVAL_SECONDS,
        DEVICE_CODE_TTL_SECONDS,
      ]
    );

    res.status(200).json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
      schema: deviceAuthorizeSchema,
    });
  });

  router.get("/device/activate", async (req, res) => {
    const userCodeRaw = typeof req.query.user_code === "string" ? req.query.user_code : "";
    const userCode = normalizeUserCode(userCodeRaw);
    const userId = await getSessionUserId(req);
    const thisPath = req.originalUrl || "/api/oauth/device/activate";

    if (!userId) {
      const loginUrl = loginRedirectUrl(thisPath);
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><body style="font-family:sans-serif;padding:24px;background:#0b1020;color:#e5e7eb;">
  <h1>Authorize Device</h1>
  <p>Sign in to continue OAuth device authorization.</p>
  <a href="${escapeHtml(loginUrl)}" style="display:inline-block;margin-top:8px;padding:10px 14px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;">Continue to Login</a>
</body></html>`);
      return;
    }

    if (!userCode) {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><body style="font-family:sans-serif;padding:24px;background:#0b1020;color:#e5e7eb;">
  <h1>Enter Device Code</h1>
  <form method="POST" action="/api/oauth/device/activate">
    <input name="user_code" placeholder="XXXX-XXXX" style="padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e5e7eb;" />
    <button type="submit" name="action" value="approve" style="margin-left:8px;padding:10px 12px;border-radius:8px;background:#22c55e;border:none;color:#062013;">Approve</button>
  </form>
</body></html>`);
      return;
    }

    const rowResult = await pool.query<DeviceCodeRow>(
      `SELECT device_code, user_code, client_id, code_challenge, scope, resource, status, user_id, tenant_id, interval_seconds, expires_at, last_polled_at
       FROM oauth_device_codes
       WHERE user_code = $1`,
      [userCode]
    );
    const row = rowResult.rows[0];
    if (!row) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8").send("<h1>Invalid device code</h1>");
      return;
    }
    if (row.expires_at.getTime() <= Date.now()) {
      res.status(410).setHeader("Content-Type", "text/html; charset=utf-8").send("<h1>Device code expired</h1>");
      return;
    }
    if (row.status !== "pending") {
      res.status(409).setHeader("Content-Type", "text/html; charset=utf-8").send("<h1>Device code already processed</h1>");
      return;
    }

    const client = await loadClient(row.client_id);
    const clientLabel = client?.client_name ?? row.client_id;
    const scopes = parseScopes(row.scope).join(", ");
    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><body style="font-family:sans-serif;padding:24px;background:#0b1020;color:#e5e7eb;">
  <h1>Approve Device Access</h1>
  <p>Client: <strong>${escapeHtml(clientLabel)}</strong></p>
  <p>Scopes: <code>${escapeHtml(scopes || "none")}</code></p>
  <form method="POST" action="/api/oauth/device/activate" style="display:flex;gap:10px;">
    <input type="hidden" name="user_code" value="${escapeHtml(userCode)}" />
    <button type="submit" name="action" value="approve" style="padding:10px 12px;border-radius:8px;background:#22c55e;border:none;color:#052e16;">Approve</button>
    <button type="submit" name="action" value="deny" style="padding:10px 12px;border-radius:8px;background:#ef4444;border:none;color:#fff;">Deny</button>
  </form>
</body></html>`);
  });

  router.post("/device/activate", async (req, res) => {
    const userId = await getSessionUserId(req);
    if (!userId) {
      const thisPath = req.originalUrl || "/api/oauth/device/activate";
      res.redirect(302, loginRedirectUrl(thisPath));
      return;
    }

    const userCodeRaw = typeof req.body?.user_code === "string" ? req.body.user_code : "";
    const action = typeof req.body?.action === "string" ? req.body.action : "approve";
    const userCode = normalizeUserCode(userCodeRaw);
    if (!userCode) {
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8").send("<h1>Missing user_code</h1>");
      return;
    }

    const rowResult = await pool.query<DeviceCodeRow>(
      `SELECT device_code, user_code, client_id, code_challenge, scope, resource, status, user_id, tenant_id, interval_seconds, expires_at, last_polled_at
       FROM oauth_device_codes
       WHERE user_code = $1`,
      [userCode]
    );
    const row = rowResult.rows[0];
    if (!row || row.expires_at.getTime() <= Date.now()) {
      res.status(410).setHeader("Content-Type", "text/html; charset=utf-8").send("<h1>Code missing or expired</h1>");
      return;
    }
    if (row.status !== "pending") {
      res.status(409).setHeader("Content-Type", "text/html; charset=utf-8").send("<h1>Code already processed</h1>");
      return;
    }

    if (action === "deny") {
      await pool.query(
        "UPDATE oauth_device_codes SET status = 'denied' WHERE device_code = $1",
        [row.device_code]
      );
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send("<h1>Authorization denied</h1>");
      return;
    }

    const tenantId = (await getPrimaryTenantId(userId)) ?? (await ensurePrimaryTenantForUser(userId));
    await pool.query(
      `UPDATE oauth_device_codes
       SET status = 'approved',
           user_id = $2,
           tenant_id = $3,
           approved_at = NOW()
       WHERE device_code = $1`,
      [row.device_code, userId, tenantId]
    );

    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send("<h1>Authorization approved. You can return to your app.</h1>");
  });

  router.post("/token", async (req, res) => {
    const grantType = typeof req.body?.grant_type === "string" ? req.body.grant_type : "";

    if (grantType === "client_credentials") {
      const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
      const clientSecret = typeof req.body?.client_secret === "string" ? req.body.client_secret : undefined;
      const scopeRaw = typeof req.body?.scope === "string" ? req.body.scope : undefined;
      const resource = typeof req.body?.resource === "string" ? req.body.resource : null;

      if (!clientId) {
        sendOauthError(res, 400, "invalid_request", "Missing client_id.");
        return;
      }

      const client = await loadClient(clientId);
      if (!client) {
        sendOauthError(res, 400, "invalid_client", "Unknown client.");
        return;
      }

      const clientSecretError = validateClientSecret(client, clientSecret);
      if (clientSecretError) {
        sendOauthError(res, 401, "invalid_client", clientSecretError);
        return;
      }

      const principal = extractServicePrincipal(client);
      if (!principal) {
        sendOauthError(res, 400, "unauthorized_client", "Client is not provisioned for service principal access.");
        return;
      }

      const allowedScopes = principal.allowed_scopes?.length
        ? principal.allowed_scopes.filter((scope) => SUPPORTED_SCOPES.has(scope))
        : AUTOMATION_DEFAULT_SCOPES;
      const requestedScopes = sanitizeScopes(scopeRaw, allowedScopes);
      if (!hasScopeSubset(requestedScopes, allowedScopes)) {
        sendOauthError(res, 400, "invalid_scope", "Requested scope is not allowed for this client.");
        return;
      }

      const tokens = await issueTokens({
        clientId,
        userId: principal.user_id,
        tenantId: principal.tenant_id,
        scopes: requestedScopes,
        resource,
        grantType: "client_credentials",
        accessTtlSeconds: CLIENT_CREDENTIALS_ACCESS_TTL_SECONDS,
        refreshTtlSeconds: CLIENT_CREDENTIALS_ACCESS_TTL_SECONDS,
        includeRefreshToken: false,
      });

      res.status(200).json(tokens);
      return;
    }

    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
      const deviceCode = typeof req.body?.device_code === "string" ? req.body.device_code : "";
      const codeVerifier = typeof req.body?.code_verifier === "string" ? req.body.code_verifier : "";
      if (!clientId || !deviceCode || !codeVerifier) {
        sendOauthError(res, 400, "invalid_request", "Missing client_id, device_code, or code_verifier.");
        return;
      }

      const client = await loadClient(clientId);
      if (!client) {
        sendOauthError(res, 400, "invalid_client", "Unknown client.");
        return;
      }

      const rowResult = await pool.query<DeviceCodeRow>(
        `SELECT device_code, user_code, client_id, code_challenge, scope, resource, status, user_id, tenant_id, interval_seconds, expires_at, last_polled_at
         FROM oauth_device_codes
         WHERE device_code = $1`,
        [deviceCode]
      );
      const row = rowResult.rows[0];
      if (!row || row.client_id !== clientId) {
        sendOauthError(res, 400, "invalid_grant", "Invalid device code.");
        return;
      }

      if (row.expires_at.getTime() <= Date.now()) {
        await pool.query("UPDATE oauth_device_codes SET status = 'denied' WHERE device_code = $1", [row.device_code]);
        sendOauthError(res, 400, "expired_token", "Device code expired.");
        return;
      }

      if (row.status === "denied") {
        sendOauthError(res, 400, "access_denied", "User denied authorization.");
        return;
      }
      if (row.status === "consumed") {
        sendOauthError(res, 400, "invalid_grant", "Device code already used.");
        return;
      }
      if (row.status === "pending") {
        const now = Date.now();
        if (row.last_polled_at && now - row.last_polled_at.getTime() < row.interval_seconds * 1000) {
          await pool.query("UPDATE oauth_device_codes SET last_polled_at = NOW() WHERE device_code = $1", [row.device_code]);
          sendOauthError(res, 400, "slow_down", "Polling too frequently.");
          return;
        }
        await pool.query("UPDATE oauth_device_codes SET last_polled_at = NOW() WHERE device_code = $1", [row.device_code]);
        sendOauthError(res, 400, "authorization_pending", "Authorization is still pending.");
        return;
      }

      const codeChallengeValid = await verifyChallenge(codeVerifier, row.code_challenge);
      if (!codeChallengeValid) {
        sendOauthError(res, 400, "invalid_grant", "code_verifier does not match code_challenge.");
        return;
      }

      if (!row.user_id) {
        sendOauthError(res, 400, "invalid_grant", "Device authorization missing user context.");
        return;
      }
      const tenantId = row.tenant_id ?? ((await getPrimaryTenantId(row.user_id)) ?? (await ensurePrimaryTenantForUser(row.user_id)));
      const requestedScopes = sanitizeScopes(row.scope ?? undefined, AUTH_CODE_DEFAULT_SCOPES);

      const tokens = await issueTokens({
        clientId,
        userId: row.user_id,
        tenantId,
        scopes: requestedScopes,
        resource: row.resource,
        grantType: "device_code",
        accessTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
        refreshTtlSeconds: REFRESH_TOKEN_TTL_SECONDS,
        includeRefreshToken: true,
      });

      await pool.query(
        "UPDATE oauth_device_codes SET status = 'consumed', consumed_at = NOW() WHERE device_code = $1",
        [row.device_code]
      );
      res.status(200).json(tokens);
      return;
    }

    sendOauthError(res, 400, "unsupported_grant_type", "Supported grant types: client_credentials, urn:ietf:params:oauth:grant-type:device_code.");
  });

  router.post("/introspect", async (req, res) => {
    const internalSecret = req.headers["x-internal-secret"];
    if (!internalSecret || internalSecret !== config.internalApiSecret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const resource = typeof req.body?.resource === "string" ? req.body.resource : null;
    if (!token) {
      res.status(400).json({ error: "Missing token" });
      return;
    }

    const result = await introspectOAuthAccessToken(token, { expectedResource: resource });
    res.json(result);
  });

  router.post("/revoke-legacy-keys", async (req, res) => {
    const internalSecret = req.headers["x-internal-secret"];
    if (!internalSecret || internalSecret !== config.internalApiSecret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const revoked = await pool.query<{ key_hash: string }>(
      `UPDATE api_keys
       SET revoked_at = NOW()
       WHERE revoked_at IS NULL
         AND connector_type IS NULL
       RETURNING key_hash`
    );
    await Promise.all(
      revoked.rows
        .map((row) => row.key_hash)
        .filter((hash) => hash.length > 0)
        .map((hash) => deleteCacheKey(apiKeyValidationCacheKey(hash)))
    );
    res.json({
      success: true,
      revoked: revoked.rowCount ?? 0,
      scope: "legacy_only",
    });
    if ((revoked.rowCount ?? 0) > 0 && config.nodeEnv !== "production") {
      console.warn("[oauth] revoke-legacy-keys revoked active legacy API keys", {
        revoked: revoked.rowCount ?? 0,
      });
    }
  });

  router.post("/service-principals", internalMiddleware, async (req: AuthRequest, res) => {
    const name = typeof req.body?.name === "string" && req.body.name.trim().length > 0
      ? req.body.name.trim()
      : "Automation Service Principal";
    const requestedScopes = Array.isArray(req.body?.allowedScopes)
      ? req.body.allowedScopes.filter((value: unknown): value is string => typeof value === "string")
      : AUTOMATION_DEFAULT_SCOPES;
    const normalizedScopes = sanitizeScopes(requestedScopes.join(" "), AUTOMATION_DEFAULT_SCOPES);
    if (!hasScopeSubset(normalizedScopes, AUTOMATION_DEFAULT_SCOPES)) {
      res.status(400).json({
        error: "invalid_scope",
        message: "Service principals can request only memory:read, memory:write, and automation:run.",
      });
      return;
    }

    const userId = req.userId!;
    const tenantId = req.authContext?.tenantId ?? ((await getPrimaryTenantId(userId)) ?? (await ensurePrimaryTenantForUser(userId)));
    const clientId = createOpaqueToken("tla_sp");
    const clientSecret = createOpaqueToken("tla_cs");
    const issuedAt = Math.floor(Date.now() / 1000);
    const clientInfo: ClientInfo = {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: issuedAt,
      client_secret_expires_at: 0,
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["client_credentials"],
      redirect_uris: [],
      client_name: name,
      tallei_service_principal: {
        user_id: userId,
        tenant_id: tenantId,
        allowed_scopes: normalizedScopes,
      },
    };

    await pool.query(
      "INSERT INTO oauth_clients (client_id, client_info) VALUES ($1, $2::jsonb)",
      [clientId, JSON.stringify(clientInfo)]
    );

    res.status(201).json({
      clientId,
      clientSecret,
      allowedScopes: normalizedScopes,
      tokenUrl: `${config.publicBaseUrl}/api/oauth/token`,
      grantType: "client_credentials",
    });
  });

  return router;
}
