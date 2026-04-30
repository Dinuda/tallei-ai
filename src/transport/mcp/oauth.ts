import { randomBytes, createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "../../config/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { deleteCacheKey } from "../../infrastructure/cache/redis-cache.js";
import { sanitizeNextPath } from "../../infrastructure/auth/auth.js";
import { ensurePrimaryTenantForUser, getPrimaryTenantId } from "../../infrastructure/auth/tenancy.js";

const AUTH_CODE_TTL_SECONDS = 10 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_SCOPES = ["mcp:tools", "memory:read", "memory:write", "collab:read", "collab:write"];
const SUPPORTED_SCOPES = new Set([...DEFAULT_SCOPES, "automation:run"]);

function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("hex")}`;
}

function hashOAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeScopes(scopes?: string[]): string[] {
  const requested = (scopes ?? []).map((scope) => scope.trim()).filter(Boolean);
  const deduped = Array.from(new Set(requested));
  const filtered = deduped.filter((scope) => SUPPORTED_SCOPES.has(scope));
  if (filtered.length > 0) return filtered;
  return [...DEFAULT_SCOPES];
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
  const url = new URL("/login", config.dashboardBaseUrl || config.frontendUrl || config.publicBaseUrl);
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
    <title>Tallei Login</title>
    <style>
      :root {
        color-scheme: light;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .auth-screen {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: #fdfbf7;
        background-image: radial-gradient(#d4cfc6 1px, transparent 1px);
        background-size: 24px 24px;
        padding: 2rem;
      }

      .auth-card {
        width: 100%;
        max-width: 440px;
        padding: 3rem 2.5rem;
        background: #ffffff;
        border: 2px solid #1a1816;
        box-shadow: 8px 8px 0px rgba(0, 0, 0, 0.1);
        text-align: center;
      }

      .auth-logo-wrap {
        margin-bottom: 2rem;
      }

      .auth-heading h2 {
        font-family: ui-serif, Georgia, Cambria, serif;
        font-size: 2.2rem;
        font-weight: 700;
        margin: 0 0 0.5rem;
        color: #1a1816;
      }

      .auth-heading p {
        color: #4c4643;
        font-size: 1rem;
        margin: 0 0 2rem;
      }

      .auth-divider {
        display: flex;
        align-items: center;
        margin: 2rem 0;
      }

      .auth-divider-line {
        flex: 1;
        height: 2px;
        background: #e5e0d8;
      }

      .auth-divider-text {
        padding: 0 1rem;
        font-size: 0.8rem;
        font-weight: 600;
        color: #8c827a;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .auth-google-btn {
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 0.8rem;
        background: #ffffff;
        border: 2px solid #1a1816;
        color: #1a1816;
        font-weight: 600;
        font-size: 1rem;
        text-decoration: none;
        transition: all 0.2s ease;
        box-shadow: 4px 4px 0px #1a1816;
      }

      .auth-google-btn:hover {
        transform: translate(-1px, -1px);
        box-shadow: 6px 6px 0px #1a1816;
      }

      .auth-google-btn:active {
        transform: translate(2px, 2px);
        box-shadow: 0px 0px 0px #1a1816;
      }

      .auth-footnote {
        margin-top: 2rem;
        font-size: 0.85rem;
        color: #8c827a;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <main class="auth-screen">
      <div class="auth-card">
        <div class="auth-logo-wrap" aria-hidden="true">
          <svg width="96" height="40" viewBox="0 0 231 96" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M88.9412 73.8462C85.3431 73.8462 82.5855 72.9578 80.6685 71.1811C78.7515 69.4044 77.793 66.5275 77.793 62.5503V45.4286H72.6758V37.3516H77.793V29.967L87.2622 28.9835V37.3516H94.9765V45.4286H87.2622V62.0586C87.2622 64.3059 88.244 65.4286 90.2076 65.4286H94.1166V73.8462H88.9412Z" fill="black"/>
            <path d="M113.777 74.7582C110.456 74.7582 107.415 73.9159 104.653 72.2313C101.938 70.5001 99.7609 68.2065 98.1212 65.3505C96.5283 62.4476 95.7318 59.2399 95.7318 55.7275C95.7318 53.1053 96.2 50.6468 97.1364 48.3525C98.0729 46.0113 99.3605 43.9739 101 42.2404C102.64 40.4601 104.536 39.078 106.689 38.094C108.889 37.0631 111.253 36.5477 113.777 36.5477C116.956 36.5477 119.435 37.1568 121.214 38.375C122.993 39.5463 124.374 41.1163 125.358 43.0852V37.3516H134.782V73.8462H125.579V67.882C124.596 69.9449 123.192 71.6092 121.368 72.8748C119.589 74.1308 117.058 74.7582 113.777 74.7582ZM115.321 66.1868C117.428 66.1868 119.231 65.7187 120.728 64.7824C122.275 63.7991 123.471 62.5115 124.314 60.9198C125.157 59.3282 125.579 57.5956 125.579 55.722C125.579 53.8015 125.157 52.0445 124.314 50.4529C123.471 48.8613 122.275 47.5736 120.728 46.5904C119.231 45.6072 117.428 45.1156 115.321 45.1156C113.307 45.1156 111.527 45.6072 109.98 46.5904C108.48 47.5267 107.309 48.7902 106.466 50.3818C105.622 51.9735 105.2 53.7305 105.2 55.6509C105.2 57.4773 105.622 59.2098 106.466 60.8497C107.309 62.4413 108.48 63.7289 109.98 64.7122C111.527 65.6954 113.307 66.1868 115.321 66.1868Z" fill="black"/>
            <path d="M140.544 73.8462V22.5H150.013V73.8462H140.544Z" fill="black"/>
            <path d="M155.625 73.8462V22.5H165.094V73.8462H155.625Z" fill="black"/>
            <path d="M188.146 74.7582C184.407 74.7582 181.112 73.8933 178.26 72.1635C175.408 70.4336 173.186 68.14 171.593 65.2826C170.047 62.3797 169.274 59.172 169.274 55.6595C169.274 52.1471 170.094 48.9394 171.734 46.0365C173.374 43.0866 175.596 40.7462 178.401 39.0165C181.253 37.2867 184.501 36.4219 188.146 36.4219C191.791 36.4219 194.992 37.2867 197.751 39.0165C200.556 40.7462 202.731 43.0866 204.278 46.0365C205.871 48.9394 206.668 52.1471 206.668 55.6595C206.668 56.1749 206.645 56.7137 206.598 57.2762C206.551 57.8387 206.48 58.4247 206.386 59.034H179.096C179.611 61.1882 180.641 62.9438 182.186 64.2993C183.778 65.6547 185.768 66.3325 188.146 66.3325C190.2 66.3325 191.978 65.8655 193.48 64.9313C195.027 63.9972 196.222 62.8308 197.066 61.4321L204.429 66.9736C202.979 69.268 200.806 71.1407 197.908 72.5917C195.009 74.0428 191.755 74.7582 188.146 74.7582ZM188.006 44.5454C185.768 44.5454 183.856 45.2231 182.272 46.5785C180.688 47.9339 179.64 49.7101 179.096 51.9116H197.123C196.608 49.8988 195.532 48.1691 193.895 46.7191C192.305 45.2691 190.342 44.5454 188.006 44.5454Z" fill="black"/>
            <path d="M215.504 34.3123C213.918 34.3123 212.564 33.776 211.442 32.7034C210.367 31.5839 209.829 30.2549 209.829 28.7164C209.829 27.2258 210.367 25.9446 211.442 24.872C212.564 23.7525 213.918 23.1928 215.504 23.1928C217.136 23.1928 218.49 23.7525 219.566 24.872C220.641 25.9446 221.178 27.2258 221.178 28.7164C221.178 30.3016 220.641 31.6308 219.566 32.7034C218.49 33.776 217.136 34.3123 215.504 34.3123ZM210.808 73.8462V37.3516H220.277V73.8462H210.808Z" fill="black"/>
            <rect width="6.319" height="56.524" transform="matrix(0.321156 -0.947026 -0.947026 -0.321156 53.534 65.327)" fill="black"/>
            <rect width="6.355" height="39.878" transform="matrix(-1 0 0 1 14.548 33.289)" fill="black"/>
            <rect width="6.355" height="39.878" transform="matrix(-1 0 0 1 35.938 33.289)" fill="black"/>
            <rect width="6.355" height="39.878" transform="matrix(-1 0 0 1 46.67 33.947)" fill="black"/>
            <rect width="6.355" height="39.878" transform="matrix(-1 0 0 1 25.226 33.289)" fill="black"/>
          </svg>
        </div>

        <div class="auth-heading">
          <h2>Welcome back</h2>
          <p>Sign in to access your AI memory workspace</p>
        </div>

        <div class="auth-divider">
          <div class="auth-divider-line"></div>
          <span class="auth-divider-text">continue with</span>
          <div class="auth-divider-line"></div>
        </div>

        <a href="${escapeHtml(loginUrl)}" class="auth-google-btn">
          <svg width="20" height="20" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.2 0 5.7 1.1 7.8 3.1l5.8-5.8C34.2 3.5 29.4 1.5 24 1.5 15.5 1.5 8.2 6.5 4.9 13.7l6.8 5.3C13.5 13 18.3 9.5 24 9.5z"></path>
            <path fill="#4285F4" d="M46.5 24c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.6 36.8 46.5 30.8 46.5 24z"></path>
            <path fill="#FBBC05" d="M11.7 28.3A14.4 14.4 0 0 1 9.5 24c0-1.5.3-3 .8-4.3l-6.8-5.3A22.4 22.4 0 0 0 1.5 24c0 3.6.9 6.9 2.4 9.9l7.8-5.6z"></path>
            <path fill="#34A853" d="M24 46.5c5.4 0 9.9-1.8 13.2-4.8l-7.5-5.8c-1.8 1.2-4.2 2-5.7 2-5.6 0-10.4-3.8-12.1-9l-7.8 5.6C8.2 41.5 15.5 46.5 24 46.5z"></path>
          </svg>
          Continue with Google
        </a>

        <p class="auth-footnote">
          New users are created automatically on first sign-in.
          <br />
          By continuing you agree to our Terms of Service.
        </p>
      </div>
    </main>
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
    const scope = normalizeScopes(params.scopes).join(" ");
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
       (access_token, refresh_token, client_id, tenant_id, user_id, scope, resource, access_expires_at, refresh_expires_at, token_family_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8::int * INTERVAL '1 second'), NOW() + ($9::int * INTERVAL '1 second'), $10)`,
      [
        hashOAuthToken(accessToken),
        hashOAuthToken(refreshToken),
        code.client_id,
        code.tenant_id,
        code.user_id,
        code.scope,
        resourceValue,
        ACCESS_TOKEN_TTL_SECONDS,
        REFRESH_TOKEN_TTL_SECONDS,
        randomUUID(),
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
    const refreshHash = hashOAuthToken(refreshToken);
    const result = await pool.query<OAuthTokenRow & { rotated_at: Date | null; token_family_id: string | null }>(
      `SELECT access_token, refresh_token, client_id, tenant_id, user_id, scope, resource,
              access_expires_at, refresh_expires_at, revoked_at, rotated_at, token_family_id
       FROM oauth_tokens
       WHERE refresh_token = $1`,
      [refreshHash]
    );

    const token = result.rows[0];
    if (!token) throw new InvalidGrantError("Invalid refresh token");
    if (token.client_id !== client.client_id) throw new InvalidGrantError("Refresh token was not issued to this client");
    if (token.revoked_at) throw new InvalidGrantError("Refresh token revoked");
    if (token.refresh_expires_at.getTime() <= Date.now()) throw new InvalidGrantError("Refresh token expired");

    if (token.rotated_at) {
      // Reuse of an already-rotated token → revoke entire token family
      if (token.token_family_id) {
        await pool.query(
          `UPDATE oauth_tokens SET revoked_at = NOW()
           WHERE token_family_id = $1 AND revoked_at IS NULL`,
          [token.token_family_id]
        );
      }
      throw new InvalidGrantError("Refresh token reuse detected; all tokens in this session have been revoked");
    }

    const existingScopes = normalizeScopes((token.scope ?? "").split(" ").filter(Boolean));
    const nextScopes = normalizeScopes(scopes && scopes.length > 0 ? scopes : existingScopes);

    const invalidScope = nextScopes.some(scope => !existingScopes.includes(scope));
    if (invalidScope) throw new InvalidRequestError("Requested scope was not granted");

    const nextResource = resource?.toString() ?? token.resource ?? this.expectedResourceUrl.toString();

    const nextAccessToken = createOpaqueToken("tla_at");
    const nextRefreshToken = createOpaqueToken("tla_rt");
    const nextScope = nextScopes.length > 0 ? nextScopes.join(" ") : null;

    // Mark old token as rotated (not deleted — keeps family history for reuse detection)
    await pool.query(
      "UPDATE oauth_tokens SET rotated_at = NOW() WHERE refresh_token = $1",
      [refreshHash]
    );

    // Insert new token inheriting the same family
    await pool.query(
      `INSERT INTO oauth_tokens
       (access_token, refresh_token, client_id, tenant_id, user_id, scope, resource,
        access_expires_at, refresh_expires_at, token_family_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               NOW() + ($8::int * INTERVAL '1 second'),
               NOW() + ($9::int * INTERVAL '1 second'),
               $10)`,
      [
        hashOAuthToken(nextAccessToken),
        hashOAuthToken(nextRefreshToken),
        token.client_id,
        token.tenant_id,
        token.user_id,
        nextScope,
        nextResource,
        ACCESS_TOKEN_TTL_SECONDS,
        REFRESH_TOKEN_TTL_SECONDS,
        token.token_family_id ?? randomUUID(),
      ]
    );

    return {
      access_token: nextAccessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: nextRefreshToken,
      scope: nextScope ?? undefined,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const result = await pool.query<OAuthTokenRow>(
      `SELECT access_token, refresh_token, client_id, tenant_id, user_id, scope, resource, access_expires_at, refresh_expires_at, revoked_at
       FROM oauth_tokens
       WHERE access_token = $1`,
      [hashOAuthToken(token)]
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
    const tokenHash = hashOAuthToken(request.token);

    const affected = await pool.query<{ access_token: string }>(
      `SELECT access_token FROM oauth_tokens
       WHERE client_id = $1 AND (access_token = $2 OR refresh_token = $2) AND revoked_at IS NULL`,
      [client.client_id, tokenHash]
    );

    await pool.query(
      `UPDATE oauth_tokens
       SET revoked_at = NOW()
       WHERE client_id = $1
         AND (access_token = $2 OR refresh_token = $2)`,
      [client.client_id, tokenHash]
    );

    // access_token column now stores sha256 hashes — use them directly as cache key suffixes
    await Promise.all(
      affected.rows.flatMap((row) => [
        deleteCacheKey(`auth:oauth:${row.access_token}`),
        deleteCacheKey(`auth:oauth:v2:${row.access_token}`),
      ])
    );
  }
}
