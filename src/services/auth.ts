import { pool } from "../db/index.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { randomBytes, createHash } from "crypto";

export interface User {
  id: string;
  email: string;
}

export async function register(email: string, passwordRaw: string): Promise<User> {
  const hash = await bcrypt.hash(passwordRaw, 10);
  const result = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
    [email, hash]
  );
  return result.rows[0];
}

export async function login(email: string, passwordRaw: string): Promise<{ token: string; user: User } | null> {
  const result = await pool.query("SELECT id, email, password_hash FROM users WHERE email = $1", [email]);
  if (result.rows.length === 0) return null;

  const userRecord = result.rows[0];
  const isValid = await bcrypt.compare(passwordRaw, userRecord.password_hash);
  if (!isValid) return null;

  const user = { id: userRecord.id, email: userRecord.email };
  const token = jwt.sign(user, config.jwtSecret, { expiresIn: "7d" });
  
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

export async function validateApiKey(rawKey: string): Promise<string | null> {
  const hash = createHash("sha256").update(rawKey).digest("hex");
  const result = await pool.query("SELECT user_id FROM api_keys WHERE key_hash = $1", [hash]);
  
  if (result.rows.length === 0) return null;
  return result.rows[0].user_id;
}
