import { pool } from "../db/index.js";
import type { AuthContext, AuthMode, Plan } from "../../domain/auth/index.js";

const PLAN_CACHE_TTL_MS = 5 * 60_000;
const planCache = new Map<string, { plan: Plan; exp: number }>();
const tenantIdCache = new Map<string, { tenantId: string; exp: number }>();

function defaultTenantName(userId: string, email?: string): string {
  if (email && email.includes("@")) {
    const prefix = email.split("@")[0].replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 36);
    if (prefix.length > 0) return `tenant-${prefix}`;
  }
  return `tenant-${userId.slice(0, 8)}`;
}

export async function getPrimaryTenantId(userId: string): Promise<string | null> {
  const localHit = tenantIdCache.get(userId);
  if (localHit && localHit.exp > Date.now()) {
    return localHit.tenantId;
  }

  const result = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id
     FROM tenant_memberships
     WHERE user_id = $1
     ORDER BY is_primary DESC, created_at ASC
     LIMIT 1`,
    [userId]
  );
  
  const tenantId = result.rows[0]?.tenant_id ?? null;
  if (tenantId) {
    tenantIdCache.set(userId, { tenantId, exp: Date.now() + PLAN_CACHE_TTL_MS });
  }
  return tenantId;
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
      `INSERT INTO subscriptions (tenant_id, plan, status)
       VALUES ($1, 'free', 'active')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId]
    );

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
    const newTenantId = resolvedMembership.rows[0].tenant_id;
    tenantIdCache.set(userId, { tenantId: newTenantId, exp: Date.now() + PLAN_CACHE_TTL_MS });
    return newTenantId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPlanForTenant(tenantId: string): Promise<Plan> {
  const localHit = planCache.get(tenantId);
  if (localHit && localHit.exp > Date.now()) {
    return localHit.plan;
  }

  const result = await pool.query<{ plan: string; status: string }>(
    `SELECT plan, status FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
    [tenantId]
  );
  const row = result.rows[0];
  const plan = (!row || row.status === "expired") ? "free" : (row.plan as Plan);
  planCache.set(tenantId, { plan, exp: Date.now() + PLAN_CACHE_TTL_MS });
  return plan;
}

export async function resolveAuthContext(userId: string, authMode: AuthMode, keyId?: string): Promise<AuthContext> {
  const tenantId = (await getPrimaryTenantId(userId)) ?? (await ensurePrimaryTenantForUser(userId));
  const plan = await getPlanForTenant(tenantId);
  return {
    userId,
    tenantId,
    authMode,
    plan,
    ...(keyId ? { keyId } : {}),
  };
}
