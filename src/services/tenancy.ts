import { pool } from "../db/index.js";
import type { AuthContext, AuthMode } from "../types/auth.js";

function defaultTenantName(userId: string, email?: string): string {
  if (email && email.includes("@")) {
    const prefix = email.split("@")[0].replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 36);
    if (prefix.length > 0) return `tenant-${prefix}`;
  }
  return `tenant-${userId.slice(0, 8)}`;
}

export async function getPrimaryTenantId(userId: string): Promise<string | null> {
  const result = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id
     FROM tenant_memberships
     WHERE user_id = $1
     ORDER BY is_primary DESC, created_at ASC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0]?.tenant_id ?? null;
}

export async function ensurePrimaryTenantForUser(userId: string, email?: string): Promise<string> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);

    const existingMembership = await client.query<{ tenant_id: string }>(
      `SELECT tenant_id
       FROM tenant_memberships
       WHERE user_id = $1
       ORDER BY is_primary DESC, created_at ASC
       LIMIT 1`,
      [userId]
    );

    if (existingMembership.rows[0]?.tenant_id) {
      await client.query("COMMIT");
      return existingMembership.rows[0].tenant_id;
    }

    const tenantResult = await client.query<{ id: string }>(
      "INSERT INTO tenants (name) VALUES ($1) RETURNING id",
      [defaultTenantName(userId, email)]
    );

    const tenantId = tenantResult.rows[0].id;

    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, is_primary)
       VALUES ($1, $2, 'owner', true)
       ON CONFLICT (user_id) DO NOTHING`,
      [tenantId, userId]
    );

    const resolvedMembership = await client.query<{ tenant_id: string }>(
      `SELECT tenant_id
       FROM tenant_memberships
       WHERE user_id = $1
       ORDER BY is_primary DESC, created_at ASC
       LIMIT 1`,
      [userId]
    );

    if (!resolvedMembership.rows[0]?.tenant_id) {
      throw new Error(`Failed to create tenant membership for user ${userId}`);
    }

    await client.query("COMMIT");
    return resolvedMembership.rows[0].tenant_id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveAuthContext(userId: string, authMode: AuthMode, keyId?: string): Promise<AuthContext> {
  const tenantId = (await getPrimaryTenantId(userId)) ?? (await ensurePrimaryTenantForUser(userId));
  return {
    userId,
    tenantId,
    authMode,
    ...(keyId ? { keyId } : {}),
  };
}
