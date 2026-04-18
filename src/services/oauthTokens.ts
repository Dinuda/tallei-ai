import { createHash } from "node:crypto";
import { pool } from "../db/index.js";
import { getCacheJson, setCacheJson } from "./cache.js";
import { resolveAuthContext } from "./tenancy.js";

const OAUTH_ACCESS_CACHE_TTL_SECONDS = 120;

export interface OAuthTokenContext {
  accessToken: string;
  clientId: string;
  userId: string;
  tenantId: string;
  scopes: string[];
  resource: string | null;
  expiresAt: number;
}

interface OAuthTokenRow {
  access_token: string;
  client_id: string;
  tenant_id: string | null;
  user_id: string;
  scope: string | null;
  resource: string | null;
  access_expires_at: Date;
  revoked_at: Date | null;
}

interface OAuthCacheEntry {
  token: OAuthTokenContext;
}

function tokenCacheKey(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex");
  return `auth:oauth:v2:${hash}`;
}

export function parseScopes(scope: string | null | undefined): string[] {
  return (scope ?? "")
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hasRequiredScopes(grantedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) return true;
  const granted = new Set(grantedScopes);
  return requiredScopes.every((scope) => granted.has(scope));
}

async function hydrateTenantId(userId: string, tenantId: string | null): Promise<string> {
  if (tenantId) return tenantId;
  return (await resolveAuthContext(userId, "oauth")).tenantId;
}

export async function validateOAuthAccessToken(
  token: string,
  options?: { expectedResource?: string | null }
): Promise<OAuthTokenContext | null> {
  const expectedResource = options?.expectedResource ?? null;
  const cacheKey = tokenCacheKey(token);
  const cached = await getCacheJson<OAuthCacheEntry>(cacheKey);
  if (cached?.token) {
    if (expectedResource && cached.token.resource && cached.token.resource !== expectedResource) {
      return null;
    }
    if (cached.token.expiresAt <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return cached.token;
  }

  const result = await pool.query<OAuthTokenRow>(
    `SELECT access_token, client_id, tenant_id, user_id, scope, resource, access_expires_at, revoked_at
     FROM oauth_tokens
     WHERE access_token = $1`,
    [token]
  );

  const row = result.rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;

  const expiresAt = Math.floor(row.access_expires_at.getTime() / 1000);
  if (expiresAt <= Math.floor(Date.now() / 1000)) return null;

  if (expectedResource && row.resource && row.resource !== expectedResource) return null;

  const context: OAuthTokenContext = {
    accessToken: row.access_token,
    clientId: row.client_id,
    userId: row.user_id,
    tenantId: await hydrateTenantId(row.user_id, row.tenant_id),
    scopes: parseScopes(row.scope),
    resource: row.resource,
    expiresAt,
  };

  const ttl = Math.max(1, Math.min(OAUTH_ACCESS_CACHE_TTL_SECONDS, context.expiresAt - Math.floor(Date.now() / 1000)));
  await setCacheJson(cacheKey, { token: context }, ttl);
  return context;
}

export async function introspectOAuthAccessToken(
  token: string,
  options?: { expectedResource?: string | null }
): Promise<{
  active: boolean;
  client_id?: string;
  scope?: string;
  exp?: number;
  sub?: string;
  tenant_id?: string;
  resource?: string;
}> {
  const context = await validateOAuthAccessToken(token, options);
  if (!context) return { active: false };

  return {
    active: true,
    client_id: context.clientId,
    scope: context.scopes.join(" "),
    exp: context.expiresAt,
    sub: context.userId,
    tenant_id: context.tenantId,
    resource: context.resource ?? undefined,
  };
}
