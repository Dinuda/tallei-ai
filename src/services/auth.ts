import { pool } from "../db/index.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { randomBytes, createHash } from "crypto";

export interface User {
  id: string;
  email: string;
}

export interface SessionPayload {
  id: string;
  email: string;
}

const DEFAULT_NEXT_PATH = "/dashboard/setup";

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
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
  return jwt.sign(user, config.jwtSecret, { expiresIn: "7d" });
}

export function verifySessionToken(token: string): SessionPayload {
  return jwt.verify(token, config.jwtSecret) as SessionPayload;
}

export async function getUserById(id: string): Promise<User | null> {
  const result = await pool.query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE id = $1",
    [id]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

export async function upsertGoogleUser(profile: { sub: string; email: string }): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const bySub = await client.query<User>(
      "SELECT id, email FROM users WHERE google_sub = $1 LIMIT 1",
      [profile.sub]
    );
    if (bySub.rows.length > 0) {
      await client.query("COMMIT");
      return bySub.rows[0];
    }

    const byEmail = await client.query<User>(
      "SELECT id, email FROM users WHERE lower(email) = lower($1) LIMIT 1",
      [profile.email]
    );
    if (byEmail.rows.length > 0) {
      const existing = byEmail.rows[0];
      const updated = await client.query<User>(
        `UPDATE users
         SET google_sub = $2,
             auth_provider = 'google'
         WHERE id = $1
         RETURNING id, email`,
        [existing.id, profile.sub]
      );
      await client.query("COMMIT");
      return updated.rows[0];
    }

    const inserted = await client.query<User>(
      `INSERT INTO users (email, password_hash, auth_provider, google_sub)
       VALUES ($1, NULL, 'google', $2)
       RETURNING id, email`,
      [profile.email, profile.sub]
    );
    await client.query("COMMIT");
    return inserted.rows[0];
  } catch (error: unknown) {
    await client.query("ROLLBACK");

    const pgError = error as { code?: string };
    if (pgError.code === "23505") {
      const result = await pool.query<User>(
        "SELECT id, email FROM users WHERE google_sub = $1 LIMIT 1",
        [profile.sub]
      );
      const row = result.rows[0];
      if (row) return row;
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function register(email: string, passwordRaw: string): Promise<User> {
  const normalizedEmail = normalizeEmail(email);
  const hash = await bcrypt.hash(passwordRaw, 10);
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, auth_provider) VALUES ($1, $2, 'local') RETURNING id, email",
    [normalizedEmail, hash]
  );
  return result.rows[0];
}

export async function login(email: string, passwordRaw: string): Promise<{ token: string; user: User } | null> {
  const normalizedEmail = normalizeEmail(email);
  const result = await pool.query("SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)", [normalizedEmail]);
  if (result.rows.length === 0) return null;

  const userRecord = result.rows[0] as { id: string; email: string; password_hash: string | null };
  if (!userRecord.password_hash) return null;

  const isValid = await bcrypt.compare(passwordRaw, userRecord.password_hash);
  if (!isValid) return null;

  const user = { id: userRecord.id, email: userRecord.email };
  const token = issueSessionToken(user);
  
  return { token, user };
}

export async function generateApiKey(userId: string, name: string): Promise<{ key: string; id: string }> {
  // Generate a cryptographically secure random string
  const rawKey = "gm_" + randomBytes(32).toString('hex');
  const hash = createHash("sha256").update(rawKey).digest("hex");
  
  const result = await pool.query(
    "INSERT INTO api_keys (user_id, key_hash, name) VALUES ($1, $2, $3) RETURNING id",
    [userId, hash, name]
  );
  
  return { key: rawKey, id: result.rows[0].id };
}

// ── API key validation cache ─────────────────────────────────────────────────
// Hashing + a DB round-trip happens on every MCP request that uses a raw key.
// Cache results for 5 minutes to eliminate repeated DB hits.
const KEY_CACHE_TTL_MS = 5 * 60_000;
interface KeyCacheEntry { userId: string; exp: number }
const apiKeyCache = new Map<string, KeyCacheEntry>();

export async function validateApiKey(rawKey: string): Promise<string | null> {
  const hash = createHash("sha256").update(rawKey).digest("hex");

  const cached = apiKeyCache.get(hash);
  if (cached && cached.exp > Date.now()) return cached.userId;

  const result = await pool.query("SELECT user_id FROM api_keys WHERE key_hash = $1", [hash]);
  if (result.rows.length === 0) return null;

  const userId: string = result.rows[0].user_id;
  apiKeyCache.set(hash, { userId, exp: Date.now() + KEY_CACHE_TTL_MS });
  return userId;
}
