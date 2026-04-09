import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { sanitizeNextPath } from "../services/auth.js";
import { ensurePrimaryTenantForUser, getPrimaryTenantId } from "../services/tenancy.js";

const AUTH_CODE_TTL_SECONDS = 10 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("hex")}`;
}

async function getSessionUserId(req: Request): Promise<string | null> {
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

function buildLoginUrl(nextPath: string): string {
  const url = new URL("/login", config.publicBaseUrl);
  url.searchParams.set("callbackUrl", sanitizeNextPath(nextPath));
  return url.toString();
}

function renderAuthorizeLoginPage(res: Response, nextPath: string): void {
  const loginUrl = buildLoginUrl(nextPath);

  res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Authorize Tallei for Claude</title>
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px;">
    <div style="width:100%;max-width:420px;background:#111827;border:1px solid #1f2937;border-radius:14px;padding:22px;">
      <h1 style="margin:0 0 8px 0;font-size:20px;">Connect Claude to Tallei</h1>
      <p style="margin:0 0 18px 0;color:#94a3b8;font-size:14px;line-height:1.5;">Sign in to authorize Claude.ai to access your memory tools.</p>
      <a href="${escapeHtml(loginUrl)}" style="display:inline-block;margin-top:6px;padding:11px 14px;border:none;border-radius:8px;background:#0284c7;color:#fff;font-weight:600;cursor:pointer;text-decoration:none;">
        Continue with Google
      </a>
    </div>
  </body>
</html>`);
}

type AuthorizationCodeRow = {
  code: string;
  client_id: string;
  tenant_id: string | null;
  user_id: string;
  code_challenge: string;
  redirect_uri: string;
  scope: string | null;
  resource: string | null;
  expires_at: Date;
  consumed_at: Date | null;
};

type OAuthTokenRow = {
  access_token: string;
  refresh_token: string;
  client_id: string;
  tenant_id: string | null;
  user_id: string;
  scope: string | null;
  resource: string | null;
  access_expires_at: Date;
  refresh_expires_at: Date;
  revoked_at: Date | null;
};

class PgOAuthClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const result = await pool.query<{ client_info: OAuthClientInformationFull }>(
      "SELECT client_info FROM oauth_clients WHERE client_id = $1",
      [clientId]
    );
    return result.rows[0]?.client_info;
  }

  async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): Promise<OAuthClientInformationFull> {
    const clientId = createOpaqueToken("tla_client");
    const issuedAt = Math.floor(Date.now() / 1000);

    const clientInfo: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: issuedAt,
    };

    await pool.query(
      "INSERT INTO oauth_clients (client_id, client_info) VALUES ($1, $2::jsonb)",
      [clientId, JSON.stringify(clientInfo)]
    );

    return clientInfo;
  }
}

export class TalleiOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new PgOAuthClientsStore();

  constructor(private readonly expectedResourceUrl: URL) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req as Request | undefined;
    if (!req) throw new InvalidRequestError("Missing authorization request context");

    let userId = await getSessionUserId(req);

    if (!userId) {
      const nextPath = sanitizeNextPath(req.originalUrl || "/authorize");
      renderAuthorizeLoginPage(res, nextPath);
      return;
    }

    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }

    const tenantId = (await getPrimaryTenantId(userId)) ?? (await ensurePrimaryTenantForUser(userId));

    const code = createOpaqueToken("tla_code");
    const scope = params.scopes && params.scopes.length > 0 ? params.scopes.join(" ") : null;
    const resource = params.resource?.toString() ?? this.expectedResourceUrl.toString();

    await pool.query(
      `INSERT INTO oauth_authorization_codes
       (code, client_id, tenant_id, user_id, code_challenge, redirect_uri, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9::int * INTERVAL '1 second'))`,
      [
        code,
        client.client_id,
        tenantId,
        userId,
        params.codeChallenge,
        params.redirectUri,
        scope,
        resource,
        AUTH_CODE_TTL_SECONDS,
      ]
    );

    const redirectTarget = new URL(params.redirectUri);
    redirectTarget.searchParams.set("code", code);
    if (params.state) redirectTarget.searchParams.set("state", params.state);
    res.redirect(302, redirectTarget.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const result = await pool.query<AuthorizationCodeRow>(
      `SELECT code_challenge, client_id, consumed_at, expires_at
       FROM oauth_authorization_codes
       WHERE code = $1`,
      [authorizationCode]
    );

    const code = result.rows[0];
    if (!code) throw new InvalidGrantError("Invalid authorization code");
    if (code.client_id !== client.client_id) throw new InvalidGrantError("Authorization code was not issued to this client");
    if (code.consumed_at) throw new InvalidGrantError("Authorization code already used");
    if (code.expires_at.getTime() <= Date.now()) throw new InvalidGrantError("Authorization code expired");

    return code.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const result = await pool.query<AuthorizationCodeRow>(
      `SELECT code, client_id, tenant_id, user_id, redirect_uri, scope, resource, consumed_at, expires_at
       FROM oauth_authorization_codes
       WHERE code = $1`,
      [authorizationCode]
    );

    const code = result.rows[0];
    if (!code) throw new InvalidGrantError("Invalid authorization code");
    if (code.client_id !== client.client_id) throw new InvalidGrantError("Authorization code was not issued to this client");
    if (code.consumed_at) throw new InvalidGrantError("Authorization code already used");
    if (code.expires_at.getTime() <= Date.now()) throw new InvalidGrantError("Authorization code expired");
    if (redirectUri && code.redirect_uri !== redirectUri) throw new InvalidGrantError("redirect_uri mismatch");

    const resourceValue = resource?.toString() ?? code.resource ?? this.expectedResourceUrl.toString();

    if (code.resource && resource && code.resource !== resource.toString()) {
      throw new InvalidGrantError("resource mismatch");
    }

    const accessToken = createOpaqueToken("tla_at");
    const refreshToken = createOpaqueToken("tla_rt");

    await pool.query("UPDATE oauth_authorization_codes SET consumed_at = NOW() WHERE code = $1", [authorizationCode]);

    await pool.query(
      `INSERT INTO oauth_tokens
       (access_token, refresh_token, client_id, tenant_id, user_id, scope, resource, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8::int * INTERVAL '1 second'), NOW() + ($9::int * INTERVAL '1 second'))`,
      [
        accessToken,
        refreshToken,
        code.client_id,
        code.tenant_id,
        code.user_id,
        code.scope,
        resourceValue,
        ACCESS_TOKEN_TTL_SECONDS,
        REFRESH_TOKEN_TTL_SECONDS,
      ]
    );

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: code.scope ?? undefined,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const result = await pool.query<OAuthTokenRow>(
      `SELECT access_token, refresh_token, client_id, tenant_id, user_id, scope, resource, access_expires_at, refresh_expires_at, revoked_at
       FROM oauth_tokens
       WHERE refresh_token = $1`,
      [refreshToken]
    );

    const token = result.rows[0];
    if (!token) throw new InvalidGrantError("Invalid refresh token");
    if (token.client_id !== client.client_id) throw new InvalidGrantError("Refresh token was not issued to this client");
    if (token.revoked_at) throw new InvalidGrantError("Refresh token revoked");
    if (token.refresh_expires_at.getTime() <= Date.now()) throw new InvalidGrantError("Refresh token expired");

    const existingScopes = (token.scope ?? "").split(" ").filter(Boolean);
    const nextScopes = scopes && scopes.length > 0 ? scopes : existingScopes;

    const invalidScope = nextScopes.some(scope => !existingScopes.includes(scope));
    if (invalidScope) throw new InvalidRequestError("Requested scope was not granted");

    const nextResource = resource?.toString() ?? token.resource ?? this.expectedResourceUrl.toString();

    const nextAccessToken = createOpaqueToken("tla_at");
    const nextRefreshToken = createOpaqueToken("tla_rt");

    await pool.query(
      `UPDATE oauth_tokens
       SET access_token = $1,
           refresh_token = $2,
           scope = $3,
           resource = $4,
           access_expires_at = NOW() + ($5::int * INTERVAL '1 second'),
           refresh_expires_at = NOW() + ($6::int * INTERVAL '1 second')
       WHERE refresh_token = $7`,
      [
        nextAccessToken,
        nextRefreshToken,
        nextScopes.length > 0 ? nextScopes.join(" ") : null,
        nextResource,
        ACCESS_TOKEN_TTL_SECONDS,
        REFRESH_TOKEN_TTL_SECONDS,
        refreshToken,
      ]
    );

    return {
      access_token: nextAccessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: nextRefreshToken,
      scope: nextScopes.length > 0 ? nextScopes.join(" ") : undefined,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const result = await pool.query<OAuthTokenRow>(
      `SELECT access_token, refresh_token, client_id, tenant_id, user_id, scope, resource, access_expires_at, refresh_expires_at, revoked_at
       FROM oauth_tokens
       WHERE access_token = $1`,
      [token]
    );

    const access = result.rows[0];
    if (!access) throw new InvalidTokenError("Invalid access token");
    if (access.revoked_at) throw new InvalidTokenError("Access token revoked");
    if (access.access_expires_at.getTime() <= Date.now()) throw new InvalidTokenError("Access token expired");

    if (access.resource && access.resource !== this.expectedResourceUrl.toString()) {
      throw new InvalidTokenError("Access token audience mismatch");
    }

    return {
      token,
      clientId: access.client_id,
      scopes: (access.scope ?? "").split(" ").filter(Boolean),
      expiresAt: Math.floor(access.access_expires_at.getTime() / 1000),
      resource: access.resource ? new URL(access.resource) : undefined,
      extra: {
        userId: access.user_id,
        tenantId: access.tenant_id ?? undefined,
      },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await pool.query(
      `UPDATE oauth_tokens
       SET revoked_at = NOW()
       WHERE client_id = $1
         AND (access_token = $2 OR refresh_token = $2)`,
      [client.client_id, request.token]
    );
  }
}
