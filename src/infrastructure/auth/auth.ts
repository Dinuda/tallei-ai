import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomBytes, createHash, createHmac, randomUUID } from "crypto";
import { pool } from "../db/index.js";
import { config } from "../../config/index.js";
import { ensurePrimaryTenantForUser, resolveAuthContext, getPlanForTenant } from "./tenancy.js";
import { getCacheJson, setCacheJson, deleteCacheKey } from "../cache/redis-cache.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { setRequestTimingField } from "../../observability/request-timing.js";
import { runAsyncSafe } from "../../shared/async-safe.js";

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
  connectorType: string | null;
}

const DEFAULT_NEXT_PATH = "/dashboard/setup";
const API_KEY_CACHE_TTL_SECONDS = 5 * 60;
const apiKeyDbTimeoutRaw =
  process.env.API_KEY_DB_TIMEOUT_MS || (config.nodeEnv === "production" ? "15000" : "2500");
const apiKeyDbTimeoutParsed = Number.parseInt(apiKeyDbTimeoutRaw, 10);
const API_KEY_DB_TIMEOUT_MS = Number.isFinite(apiKeyDbTimeoutParsed)
  ? apiKeyDbTimeoutParsed
  : (config.nodeEnv === "production" ? 15_000 : 2_500);
const API_KEY_DB_COOLDOWN_MS = config.nodeEnv === "production" ? 0 : 60_000;
const API_KEY_DB_WARN_INTERVAL_MS = 30_000;
const AUTH_USAGE_UPDATE_DEBOUNCE_MS = Math.max(250, config.authUsageUpdateDebounceMs);
const AUTH_USAGE_UPDATE_RETRY_MS = Math.max(250, config.authUsageUpdateRetryMs);
const AUTH_USAGE_UPDATE_MAX_CONCURRENCY = Math.max(1, config.authUsageUpdateMaxConcurrency);

interface EphemeralApiKey {
  id: string;
  userId: string;
  tenantId: string;
  keyHash: string;
  name: string;
  connectorType: string | null;
  createdAt: string;
  revokedAt: string | null;
}

const ephemeralApiKeysByHash = new Map<string, EphemeralApiKey>();
const ephemeralApiKeysByUser = new Map<string, EphemeralApiKey[]>();
let apiKeyDbBypassUntil = 0;
let lastApiKeyDbWarnAt = 0;
const usageUpdateQueue = new Map<
  string,
  { lastIpHash: string | null; dueAt: number; timer: ReturnType<typeof setTimeout> | null }
>();
const usageUpdateInFlight = new Set<string>();
let activeUsageUpdateFlushes = 0;

function isDbConnectivityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /timed out/i.test(error.message) ||
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|No route to host/i.test(error.message)
  );
}

function logApiKeyDbWarning(message: string, error: unknown): void {
  if (config.nodeEnv === "production") return;
  const now = Date.now();
  if (now - lastApiKeyDbWarnAt < API_KEY_DB_WARN_INTERVAL_MS) return;
  lastApiKeyDbWarnAt = now;
  console.warn(message, error);
}

function shouldBypassApiKeyDbPath(): boolean {
  return API_KEY_DB_COOLDOWN_MS > 0 && Date.now() < apiKeyDbBypassUntil;
}

function noteApiKeyDbFailure(error: unknown, message: string): void {
  if (API_KEY_DB_COOLDOWN_MS > 0 && isDbConnectivityError(error)) {
    apiKeyDbBypassUntil = Date.now() + API_KEY_DB_COOLDOWN_MS;
  }
  logApiKeyDbWarning(message, error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function storeEphemeralApiKey(input: {
  id: string;
  userId: string;
  tenantId: string;
  keyHash: string;
  name: string;
  connectorType?: string | null;
}): void {
  const record: EphemeralApiKey = {
    id: input.id,
    userId: input.userId,
    tenantId: input.tenantId,
    keyHash: input.keyHash,
    name: input.name,
    connectorType: input.connectorType ?? null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };

  ephemeralApiKeysByHash.set(record.keyHash, record);
  const existing = ephemeralApiKeysByUser.get(record.userId) ?? [];
  existing.unshift(record);
  ephemeralApiKeysByUser.set(record.userId, existing);
}

export function listEphemeralApiKeys(userId: string): Array<{
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: null;
  revokedAt: string | null;
  rotationDays: number;
  connectorType: string | null;
}> {
  const rows = ephemeralApiKeysByUser.get(userId) ?? [];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: null,
    revokedAt: row.revokedAt,
    rotationDays: 30,
    connectorType: row.connectorType,
  }));
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function hashApiKey(rawKey: string): string {
  const pepper = config.apiKeyPepper;
  if (pepper) {
    return createHmac("sha256", pepper).update(rawKey).digest("hex");
  }
  return createHash("sha256").update(rawKey).digest("hex");
}

function apiKeyCacheKey(hash: string): string {
  return `auth:api_key_v2:${hash}`;
}

function hashIp(ip?: string): string | null {
  return ip ? createHash("sha256").update(ip).digest("hex") : null;
}

function scheduleUsageFlush(apiKeyId: string): void {
  const entry = usageUpdateQueue.get(apiKeyId);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  const delayMs = Math.max(0, entry.dueAt - Date.now());
  entry.timer = setTimeout(() => {
    const current = usageUpdateQueue.get(apiKeyId);
    if (current) current.timer = null;
    void flushUsageUpdate(apiKeyId);
  }, delayMs);
  entry.timer.unref?.();
}

function enqueueUsageUpdate(apiKeyId: string, lastIpHash: string | null, delayMs: number): void {
  const nextDueAt = Date.now() + Math.max(0, delayMs);
  const existing = usageUpdateQueue.get(apiKeyId);
  if (existing) {
    existing.lastIpHash = lastIpHash;
    existing.dueAt = nextDueAt;
  } else {
    usageUpdateQueue.set(apiKeyId, { lastIpHash, dueAt: nextDueAt, timer: null });
  }
  scheduleUsageFlush(apiKeyId);
}

async function flushUsageUpdate(apiKeyId: string): Promise<void> {
  if (usageUpdateInFlight.has(apiKeyId)) return;
  const entry = usageUpdateQueue.get(apiKeyId);
  if (!entry) return;

  const now = Date.now();
  if (entry.dueAt > now) {
    scheduleUsageFlush(apiKeyId);
    return;
  }

  if (activeUsageUpdateFlushes >= AUTH_USAGE_UPDATE_MAX_CONCURRENCY) {
    enqueueUsageUpdate(apiKeyId, entry.lastIpHash, 100);
    return;
  }

  usageUpdateQueue.delete(apiKeyId);
  usageUpdateInFlight.add(apiKeyId);
  activeUsageUpdateFlushes += 1;
  try {
    await pool.query(
      `UPDATE api_keys
       SET last_used_at = NOW(),
           last_ip_hash = $2
       WHERE id = $1
         AND revoked_at IS NULL
         AND (created_at + (rotation_days || ' days')::interval) > NOW()`,
      [apiKeyId, entry.lastIpHash]
    );
  } catch (error) {
    noteApiKeyDbFailure(error, "[auth] async usage update failed:");
    enqueueUsageUpdate(apiKeyId, entry.lastIpHash, AUTH_USAGE_UPDATE_RETRY_MS);
  } finally {
    usageUpdateInFlight.delete(apiKeyId);
    activeUsageUpdateFlushes = Math.max(0, activeUsageUpdateFlushes - 1);
  }
}

function enqueueApiKeyUsageUpdate(apiKeyId: string, requesterIp?: string): void {
  setRequestTimingField("auth_usage_update_mode", "async_debounced");
  setRequestTimingField("auth_usage_update_queued", true);
  enqueueUsageUpdate(apiKeyId, hashIp(requesterIp), AUTH_USAGE_UPDATE_DEBOUNCE_MS);
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
      jti: randomUUID(),
      id: user.id,
      email: user.email,
      tenant_id: user.tenantId,
    },
    config.jwtSecret,
    { expiresIn: "7d" }
  );
}

export async function verifySessionToken(token: string): Promise<SessionPayload> {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as Record<string, unknown>;
  const jti = typeof payload.jti === "string" ? payload.jti : null;
  if (jti) {
    const revoked = await pool.query<{ jti: string }>(
      "SELECT jti FROM jwt_revocations WHERE jti = $1 AND expires_at > NOW() LIMIT 1",
      [jti]
    );
    if (revoked.rows.length > 0) throw new Error("Token has been revoked");
  }
  return {
    id: String(payload.id ?? payload.sub ?? ""),
    email: String(payload.email ?? ""),
    tenantId: typeof payload.tenant_id === "string" ? payload.tenant_id : undefined,
  };
}

export async function revokeSessionJwt(token: string): Promise<void> {
  try {
    const payload = jwt.decode(token) as Record<string, unknown> | null;
    const jti = payload && typeof payload.jti === "string" ? payload.jti : null;
    if (!jti) return;
    const exp = typeof payload?.exp === "number" ? payload.exp : null;
    const expiresAt = exp ? new Date(exp * 1000) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      "INSERT INTO jwt_revocations (jti, expires_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING",
      [jti, expiresAt]
    );
  } catch {
    // best-effort — do not fail logout if DB is unavailable
  }
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
  const normalizedEmail = normalizeEmail(profile.email);

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
      [normalizedEmail]
    );
    if (byEmail.rows.length > 0) {
      const existing = byEmail.rows[0];
      const updated = await client.query(
        `UPDATE users
         SET google_sub = $2,
             auth_provider = 'google'
         WHERE id = $1`,
        [existing.id, profile.sub]
      );
      if ((updated.rowCount ?? 0) < 1) throw new Error("Failed to update Google user link");
      await client.query("COMMIT");
      return hydrateUser(existing.id, existing.email);
    }

    const newUserId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO users (id, email, password_hash, auth_provider, google_sub)
       VALUES ($1, $2, NULL, 'google', $3)`,
      [newUserId, normalizedEmail, profile.sub]
    );
    if ((inserted.rowCount ?? 0) >= 1) {
      await client.query("COMMIT");
      return hydrateUser(newUserId, normalizedEmail);
    }

    const fallback = await client.query<{ id: string; email: string }>(
      `SELECT id, email
       FROM users
       WHERE google_sub = $1 OR lower(email) = lower($2)
       ORDER BY (google_sub = $1) DESC
       LIMIT 1`,
      [profile.sub, normalizedEmail]
    );
    const fallbackRow = fallback.rows[0];
    if (!fallbackRow) throw new Error("Failed to resolve Google user after insert");

    await client.query("COMMIT");
    return hydrateUser(fallbackRow.id, fallbackRow.email);
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    const pgError = error as { code?: string };
    if (pgError.code === "23505") {
      const result = await pool.query<{ id: string; email: string }>(
        `SELECT id, email
         FROM users
         WHERE google_sub = $1 OR lower(email) = lower($2)
         ORDER BY (google_sub = $1) DESC
         LIMIT 1`,
        [profile.sub, normalizedEmail]
      );
      const row = result.rows[0];
      if (row) return hydrateUser(row.id, row.email);
    }
    throw error;
  } finally {
    client.release();
  }
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
  rotationDays = 30,
  tenantIdInput?: string | null,
  connectorType?: string | null,
  keyPrefix = "tly"
): Promise<{ key: string; id: string }> {
  const tenantId =
    tenantIdInput === undefined
      ? (await resolveAuthContext(userId, "internal")).tenantId
      : tenantIdInput;

  const normalizedPrefix = keyPrefix.trim().length > 0 ? keyPrefix.trim() : "tly";
  const rawKey = `${normalizedPrefix}_` + randomBytes(32).toString("hex");
  const hash = hashApiKey(rawKey);

  if (config.nodeEnv !== "production" && shouldBypassApiKeyDbPath()) {
    const fallbackId = randomUUID();
    storeEphemeralApiKey({
      id: fallbackId,
      userId,
      tenantId: tenantId || userId,
      keyHash: hash,
      name,
      connectorType: connectorType ?? null,
    });
    return { key: rawKey, id: fallbackId };
  }

  try {
    const result = await withTimeout(
      pool.query<{ id: string }>(
        `INSERT INTO api_keys (tenant_id, user_id, key_hash, name, rotation_days, connector_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [tenantId, userId, hash, name, rotationDays, connectorType ?? null]
      ),
      API_KEY_DB_TIMEOUT_MS,
      "generateApiKey"
    );

    const id = result.rows[0]?.id;
    if (!id) {
      throw new Error("api_keys insert returned no id");
    }

    return { key: rawKey, id };
  } catch (error) {
    if (config.nodeEnv === "production") {
      throw error;
    }

    const fallbackId = randomUUID();
    storeEphemeralApiKey({
      id: fallbackId,
      userId,
      tenantId: tenantId || userId,
      keyHash: hash,
      name,
      connectorType: connectorType ?? null,
    });
    noteApiKeyDbFailure(error, "[auth] generateApiKey falling back to ephemeral key store:");
    return { key: rawKey, id: fallbackId };
  }
}

export async function revokeApiKey(
  userId: string,
  keyId: string,
  tenantIdInput?: string | null
): Promise<boolean> {
  const tenantId =
    tenantIdInput === undefined
      ? (await resolveAuthContext(userId, "internal")).tenantId
      : tenantIdInput;

  if (config.nodeEnv !== "production" && shouldBypassApiKeyDbPath()) {
    const userKeys = ephemeralApiKeysByUser.get(userId) ?? [];
    const key = userKeys.find((entry) => entry.id === keyId && entry.revokedAt === null);
    if (key) {
      key.revokedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  let result;
  try {
    result = await withTimeout(
      pool.query<{ key_hash: string }>(
        `UPDATE api_keys
         SET revoked_at = NOW()
         WHERE id = $1
           AND user_id = $2
           AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
           AND revoked_at IS NULL
         RETURNING key_hash`,
        [keyId, userId, tenantId]
      ),
      API_KEY_DB_TIMEOUT_MS,
      "revokeApiKey"
    );
  } catch (error) {
    const userKeys = ephemeralApiKeysByUser.get(userId) ?? [];
    const key = userKeys.find((entry) => entry.id === keyId && entry.revokedAt === null);
    if (key) {
      key.revokedAt = new Date().toISOString();
      return true;
    }
    if (config.nodeEnv === "production") {
      throw error;
    }
    noteApiKeyDbFailure(error, "[auth] revokeApiKey DB path failed:");
    return false;
  }

  if (result.rows.length > 0) {
    const cacheKey = apiKeyCacheKey(result.rows[0].key_hash);
    await deleteCacheKey(cacheKey);
    return true;
  }

  return false;
}

export async function validateApiKeyContext(rawKey: string, requesterIp?: string): Promise<ApiKeyValidation | null> {
  const hash = hashApiKey(rawKey);
  const cacheKey = apiKeyCacheKey(hash);
  const cached = await getCacheJson<ApiKeyValidation>(cacheKey);

  if (cached) {
    enqueueApiKeyUsageUpdate(cached.keyId, requesterIp);
    return cached;
  }

  const ephemeral = ephemeralApiKeysByHash.get(hash);
  if (ephemeral && ephemeral.revokedAt === null) {
    return {
      keyId: ephemeral.id,
      userId: ephemeral.userId,
      tenantId: ephemeral.tenantId,
      connectorType: ephemeral.connectorType,
    };
  }

  if (shouldBypassApiKeyDbPath()) {
    return null;
  }

  let result;
  try {
    result = await withTimeout(
      pool.query<{
        key_id: string;
        user_id: string;
        tenant_id: string;
        connector_type: string | null;
      }>(
        `SELECT ak.id AS key_id, ak.user_id, tm.tenant_id, ak.connector_type
         FROM api_keys ak
         JOIN tenant_memberships tm ON tm.user_id = ak.user_id
         WHERE ak.key_hash = $1
           AND ak.revoked_at IS NULL
           AND (ak.created_at + (ak.rotation_days || ' days')::interval) > NOW()
         LIMIT 1`,
        [hash]
      ),
      API_KEY_DB_TIMEOUT_MS,
      "validateApiKeyContext"
    );
  } catch (error) {
    noteApiKeyDbFailure(error, "[auth] validateApiKeyContext DB path failed:");
    return null;
  }
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const value: ApiKeyValidation = {
    keyId: row.key_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    connectorType: row.connector_type ?? null,
  };

  runAsyncSafe(
    () => setCacheJson(cacheKey, value, API_KEY_CACHE_TTL_SECONDS),
    "api key cache write"
  );
  enqueueApiKeyUsageUpdate(row.key_id, requesterIp);

  return value;
}

export async function validateApiKey(rawKey: string): Promise<string | null> {
  const context = await validateApiKeyContext(rawKey);
  return context?.userId ?? null;
}

export async function authContextFromApiKey(rawKey: string, requesterIp?: string): Promise<AuthContext | null> {
  const validation = await validateApiKeyContext(rawKey, requesterIp);
  if (!validation) return null;
  const plan = await getPlanForTenant(validation.tenantId);
  return {
    userId: validation.userId,
    tenantId: validation.tenantId,
    authMode: "api_key",
    plan,
    keyId: validation.keyId,
    connectorType: validation.connectorType,
  };
}

export async function authContextFromUserId(userId: string, authMode: AuthContext["authMode"]): Promise<AuthContext> {
  return resolveAuthContext(userId, authMode);
}
