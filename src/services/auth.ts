import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import { pool } from "../db/index.js";
import { config } from "../config.js";
import { ensurePrimaryTenantForUser, resolveAuthContext } from "./tenancy.js";
import { getCacheJson, setCacheJson, deleteCacheKey } from "./cache.js";
import type { AuthContext } from "../types/auth.js";

export interface User {
  id: string;
  email: string;
  tenantId: string;
}

export interface SessionPayload {
  id: string;
  email: string;
  tenantId?: string;
}

interface ApiKeyValidation {
  keyId: string;
  userId: string;
  tenantId: string;
}

const DEFAULT_NEXT_PATH = "/dashboard/setup";
const API_KEY_CACHE_TTL_SECONDS = 5 * 60;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function apiKeyCacheKey(hash: string): string {
  return `auth:api_key:${hash}`;
}

export function sanitizeNextPath(input: unknown): string {
  if (typeof input !== "string") return DEFAULT_NEXT_PATH;
  const value = input.trim();
  if (!value.startsWith("/")) return DEFAULT_NEXT_PATH;
  if (value.startsWith("//")) return DEFAULT_NEXT_PATH;
  if (value.includes("\u0000")) return DEFAULT_NEXT_PATH;
  return value;
}

export function issueSessionToken(user: User): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      tenant_id: user.tenantId,
    },
    config.jwtSecret,
    { expiresIn: "7d" }
  );
}

export function verifySessionToken(token: string): SessionPayload {
  const payload = jwt.verify(token, config.jwtSecret) as Record<string, unknown>;
  return {
    id: String(payload.id ?? payload.sub ?? ""),
    email: String(payload.email ?? ""),
    tenantId: typeof payload.tenant_id === "string" ? payload.tenant_id : undefined,
  };
}

async function hydrateUser(id: string, email: string): Promise<User> {
  const tenantId = await ensurePrimaryTenantForUser(id, email);
  return { id, email, tenantId };
}

export async function getUserById(id: string): Promise<User | null> {
  const result = await pool.query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE id = $1",
    [id]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return hydrateUser(row.id, row.email);
}

export async function upsertGoogleUser(profile: { sub: string; email: string }): Promise<User> {
  const client = await pool.connect();
  let userId: string;
  let email: string;

  try {
    await client.query("BEGIN");

    const bySub = await client.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE google_sub = $1 LIMIT 1",
      [profile.sub]
    );
    if (bySub.rows.length > 0) {
      await client.query("COMMIT");
      return hydrateUser(bySub.rows[0].id, bySub.rows[0].email);
    }

    const byEmail = await client.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE lower(email) = lower($1) LIMIT 1",
      [profile.email]
    );
    if (byEmail.rows.length > 0) {
      const existing = byEmail.rows[0];
      const updated = await client.query<{ id: string; email: string }>(
        `UPDATE users
         SET google_sub = $2,
             auth_provider = 'google'
         WHERE id = $1
         RETURNING id, email`,
        [existing.id, profile.sub]
      );
      await client.query("COMMIT");
      return hydrateUser(updated.rows[0].id, updated.rows[0].email);
    }

    const inserted = await client.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, auth_provider, google_sub)
       VALUES ($1, NULL, 'google', $2)
       RETURNING id, email`,
      [profile.email, profile.sub]
    );
    userId = inserted.rows[0].id;
    email = inserted.rows[0].email;
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const pgError = error as { code?: string };
    if (pgError.code === "23505") {
      const result = await pool.query<{ id: string; email: string }>(
        "SELECT id, email FROM users WHERE google_sub = $1 LIMIT 1",
        [profile.sub]
      );
      const row = result.rows[0];
      if (row) return hydrateUser(row.id, row.email);
    }
    throw error;
  } finally {
    client.release();
  }

  return hydrateUser(userId, email);
}

export async function register(email: string, passwordRaw: string): Promise<User> {
  const normalizedEmail = normalizeEmail(email);
  const hash = await bcrypt.hash(passwordRaw, 10);
  const result = await pool.query<{ id: string; email: string }>(
    "INSERT INTO users (email, password_hash, auth_provider) VALUES ($1, $2, 'local') RETURNING id, email",
    [normalizedEmail, hash]
  );
  return hydrateUser(result.rows[0].id, result.rows[0].email);
}

export async function login(email: string, passwordRaw: string): Promise<{ token: string; user: User } | null> {
  const normalizedEmail = normalizeEmail(email);
  const result = await pool.query<{ id: string; email: string; password_hash: string | null }>(
    "SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)",
    [normalizedEmail]
  );
  if (result.rows.length === 0) return null;

  const userRecord = result.rows[0];
  if (!userRecord.password_hash) return null;

  const isValid = await bcrypt.compare(passwordRaw, userRecord.password_hash);
  if (!isValid) return null;

  const user = await hydrateUser(userRecord.id, userRecord.email);
  const token = issueSessionToken(user);
  return { token, user };
}

export async function generateApiKey(
  userId: string,
  name: string,
  rotationDays = 90
): Promise<{ key: string; id: string }> {
  const auth = await resolveAuthContext(userId, "internal");

  const rawKey = "gm_" + randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(rawKey).digest("hex");

  const result = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, user_id, key_hash, name, rotation_days)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [auth.tenantId, userId, hash, name, rotationDays]
  );

  return { key: rawKey, id: result.rows[0].id };
}

export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const auth = await resolveAuthContext(userId, "internal");
  const result = await pool.query<{ key_hash: string }>(
    `UPDATE api_keys
     SET revoked_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND tenant_id = $3
       AND revoked_at IS NULL
     RETURNING key_hash`,
    [keyId, userId, auth.tenantId]
  );

  if (result.rows.length > 0) {
    const cacheKey = apiKeyCacheKey(result.rows[0].key_hash);
    await deleteCacheKey(cacheKey);
    return true;
  }

  return false;
}

export async function validateApiKeyContext(rawKey: string, requesterIp?: string): Promise<ApiKeyValidation | null> {
  const hash = createHash("sha256").update(rawKey).digest("hex");
  const cacheKey = apiKeyCacheKey(hash);
  const cached = await getCacheJson<ApiKeyValidation>(cacheKey);

  if (cached) {
    await pool.query(
      `UPDATE api_keys
       SET last_used_at = NOW(),
           last_ip_hash = $2
       WHERE id = $1`,
      [cached.keyId, requesterIp ? createHash("sha256").update(requesterIp).digest("hex") : null]
    );
    return cached;
  }

  const result = await pool.query<{
    key_id: string;
    user_id: string;
    tenant_id: string;
  }>(
    `SELECT ak.id AS key_id, ak.user_id, tm.tenant_id
     FROM api_keys ak
     JOIN tenant_memberships tm ON tm.user_id = ak.user_id
     WHERE ak.key_hash = $1
       AND ak.revoked_at IS NULL
       AND (ak.created_at + (ak.rotation_days || ' days')::interval) > NOW()
     LIMIT 1`,
    [hash]
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const value: ApiKeyValidation = {
    keyId: row.key_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
  };

  await setCacheJson(cacheKey, value, API_KEY_CACHE_TTL_SECONDS);

  await pool.query(
    `UPDATE api_keys
     SET last_used_at = NOW(),
         last_ip_hash = $2
     WHERE id = $1`,
    [row.key_id, requesterIp ? createHash("sha256").update(requesterIp).digest("hex") : null]
  );

  return value;
}

export async function validateApiKey(rawKey: string): Promise<string | null> {
  const context = await validateApiKeyContext(rawKey);
  return context?.userId ?? null;
}

export async function authContextFromApiKey(rawKey: string, requesterIp?: string): Promise<AuthContext | null> {
  const validation = await validateApiKeyContext(rawKey, requesterIp);
  if (!validation) return null;
  return {
    userId: validation.userId,
    tenantId: validation.tenantId,
    authMode: "api_key",
    keyId: validation.keyId,
  };
}

export async function authContextFromUserId(userId: string, authMode: AuthContext["authMode"]): Promise<AuthContext> {
  return resolveAuthContext(userId, authMode);
}
