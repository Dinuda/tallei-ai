import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 45000,
  });
}

function shouldFallback(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const anyError = error as Error & { code?: string };
  const code = anyError.code || "";
  return (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    /getaddrinfo|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(anyError.message)
  );
}

export let pool = createPool(config.databaseUrl);
let fallbackAttempted = false;

type DbClient = pg.PoolClient;

async function connectWithFallback(): Promise<DbClient> {
  try {
    return await pool.connect();
  } catch (error) {
    const fallbackUrl = config.databaseUrlFallback;
    const canFallback =
      !fallbackAttempted &&
      config.nodeEnv !== "production" &&
      Boolean(fallbackUrl) &&
      fallbackUrl !== config.databaseUrl &&
      shouldFallback(error);

    if (!canFallback) {
      throw error;
    }

    fallbackAttempted = true;
    console.warn(
      `[db] primary DATABASE_URL unreachable; retrying with DATABASE_URL_FALLBACK (${fallbackUrl})`
    );
    pool = createPool(fallbackUrl);
    return await pool.connect();
  }
}

async function ensurePrimaryTenantMembership(client: DbClient, userId: string, email: string | null): Promise<void> {
  const existing = await client.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM tenant_memberships WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  if (existing.rows[0]?.tenant_id) return;

  const tenantName = email && email.includes("@")
    ? `tenant-${email.split("@")[0].replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 36)}`
    : `tenant-${userId.slice(0, 8)}`;

  const tenant = await client.query<{ id: string }>(
    "INSERT INTO tenants (name) VALUES ($1) RETURNING id",
    [tenantName]
  );

  await client.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, is_primary)
     VALUES ($1, $2, 'owner', true)
     ON CONFLICT (user_id) DO NOTHING`,
    [tenant.rows[0].id, userId]
  );
}

async function backfillTenants(client: DbClient): Promise<void> {
  const users = await client.query<{ id: string; email: string | null }>(
    "SELECT id, email FROM users"
  );

  for (const user of users.rows) {
    await ensurePrimaryTenantMembership(client, user.id, user.email);
  }

  await client.query(`
    UPDATE api_keys ak
    SET tenant_id = tm.tenant_id
    FROM tenant_memberships tm
    WHERE ak.user_id = tm.user_id
      AND ak.tenant_id IS NULL
  `);

  await client.query(`
    UPDATE oauth_authorization_codes oac
    SET tenant_id = tm.tenant_id
    FROM tenant_memberships tm
    WHERE oac.user_id = tm.user_id
      AND oac.tenant_id IS NULL
  `);

  await client.query(`
    UPDATE oauth_tokens ot
    SET tenant_id = tm.tenant_id
    FROM tenant_memberships tm
    WHERE ot.user_id = tm.user_id
      AND ot.tenant_id IS NULL
  `);

  await client.query(`
    UPDATE mcp_call_events mce
    SET tenant_id = tm.tenant_id
    FROM tenant_memberships tm
    WHERE mce.user_id = tm.user_id
      AND mce.tenant_id IS NULL
  `);

  await client.query(`
    UPDATE claude_onboarding_sessions cos
    SET tenant_id = tm.tenant_id
    FROM tenant_memberships tm
    WHERE cos.user_id = tm.user_id
      AND cos.tenant_id IS NULL
  `);

  await client.query(`
    UPDATE claude_onboarding_events coe
    SET tenant_id = cos.tenant_id
    FROM claude_onboarding_sessions cos
    WHERE coe.session_id = cos.id
      AND coe.tenant_id IS NULL
  `);
}

async function applySupabaseRlsPolicies(client: DbClient): Promise<void> {
  if (!config.enableSupabaseRlsPolicies) return;

  const hasAuthJwt = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'auth' AND p.proname = 'jwt'
    ) AS exists
  `);

  if (!hasAuthJwt.rows[0]?.exists) {
    console.warn("[db] auth.jwt() not found; skipping Supabase RLS policies");
    return;
  }

  const policyStatements = [
    {
      table: "memory_records",
      policy: "memory_records_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "memory_events",
      policy: "memory_events_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "api_keys",
      policy: "api_keys_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "oauth_tokens",
      policy: "oauth_tokens_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "mcp_call_events",
      policy: "mcp_events_tenant_user_policy",
      condition:
        "(user_id IS NOT NULL AND (auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "claude_onboarding_sessions",
      policy: "onboarding_sessions_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "claude_onboarding_events",
      policy: "onboarding_events_tenant_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id)",
    },
  ];

  for (const entry of policyStatements) {
    await client.query(`ALTER TABLE ${entry.table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS ${entry.policy} ON ${entry.table}`);
    await client.query(`
      CREATE POLICY ${entry.policy}
      ON ${entry.table}
      FOR ALL
      USING (${entry.condition})
      WITH CHECK (${entry.condition})
    `);
  }
}

export async function initDb() {
  const client = await connectWithFallback();
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        auth_provider TEXT NOT NULL DEFAULT 'local',
        google_sub TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      ALTER TABLE users
      ALTER COLUMN password_hash DROP NOT NULL;
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'local',
      ADD COLUMN IF NOT EXISTS google_sub TEXT;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_unique
      ON users(google_sub)
      WHERE google_sub IS NOT NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_memberships (
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'owner',
        is_primary BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user_id
        ON tenant_memberships(user_id);
      CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant_id
        ON tenant_memberships(tenant_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT UNIQUE NOT NULL,
        name TEXT,
        revoked_at TIMESTAMP WITH TIME ZONE,
        last_used_at TIMESTAMP WITH TIME ZONE,
        last_ip_hash TEXT,
        rotation_days INTEGER NOT NULL DEFAULT 90,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id ON api_keys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(user_id, revoked_at) WHERE revoked_at IS NULL;
    `);

    await client.query(`
      ALTER TABLE api_keys
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS last_ip_hash TEXT,
      ADD COLUMN IF NOT EXISTS rotation_days INTEGER NOT NULL DEFAULT 90;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content_ciphertext TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        platform TEXT NOT NULL,
        summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        qdrant_point_id TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP WITH TIME ZONE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_records_tenant_user_created
        ON memory_records(tenant_id, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_records_qdrant_point_id
        ON memory_records(qdrant_point_id);
      CREATE INDEX IF NOT EXISTS idx_memory_records_active
        ON memory_records(tenant_id, user_id, deleted_at)
        WHERE deleted_at IS NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id BIGSERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        memory_id UUID REFERENCES memory_records(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'user',
        auth_mode TEXT NOT NULL DEFAULT 'unknown',
        ip_hash TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_memory_events_tenant_user_created
        ON memory_events(tenant_id, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id
        ON memory_events(memory_id, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_info JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope TEXT,
        resource TEXT,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        consumed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE oauth_authorization_codes
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

      CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_client ON oauth_authorization_codes(client_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_tenant ON oauth_authorization_codes(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_user ON oauth_authorization_codes(user_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires ON oauth_authorization_codes(expires_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        access_token TEXT PRIMARY KEY,
        refresh_token TEXT UNIQUE NOT NULL,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope TEXT,
        resource TEXT,
        access_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        refresh_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        revoked_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE oauth_tokens
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_tenant ON oauth_tokens(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access_expiry ON oauth_tokens(access_expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_expiry ON oauth_tokens(refresh_expires_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mcp_call_events (
        id BIGSERIAL PRIMARY KEY,
        tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
        auth_mode TEXT,
        method TEXT NOT NULL,
        tool_name TEXT,
        ok BOOLEAN NOT NULL DEFAULT true,
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE mcp_call_events
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_mcp_call_events_created_at
        ON mcp_call_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_call_events_tool_name
        ON mcp_call_events(tool_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_call_events_tenant_id
        ON mcp_call_events(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_call_events_user_id
        ON mcp_call_events(user_id, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS claude_onboarding_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        current_state TEXT NOT NULL,
        project_name TEXT NOT NULL DEFAULT 'chatgpt memory',
        checkpoint JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_error TEXT,
        completed_at TIMESTAMP WITH TIME ZONE,
        canceled_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE claude_onboarding_sessions
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

      CREATE INDEX IF NOT EXISTS idx_claude_onboarding_user_created ON claude_onboarding_sessions(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_claude_onboarding_tenant_created ON claude_onboarding_sessions(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_claude_onboarding_status ON claude_onboarding_sessions(status);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS claude_onboarding_events (
        id BIGSERIAL PRIMARY KEY,
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        session_id UUID NOT NULL REFERENCES claude_onboarding_sessions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        state TEXT,
        payload JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE claude_onboarding_events
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

      CREATE INDEX IF NOT EXISTS idx_claude_onboarding_events_session_id ON claude_onboarding_events(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_claude_onboarding_events_tenant_id ON claude_onboarding_events(tenant_id, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS browser_onboarding_fallback_cache (
        state TEXT NOT NULL,
        error_signature TEXT NOT NULL,
        instruction TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        last_hit_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (state, error_signature)
      );

      CREATE INDEX IF NOT EXISTS idx_browser_fallback_cache_state_hits
        ON browser_onboarding_fallback_cache(state, hits DESC);
    `);

    await backfillTenants(client);
    await applySupabaseRlsPolicies(client);

    console.log("Database schema initialized successfully.");
  } catch (error) {
    console.error("Error initializing database schema:", error);
    throw error;
  } finally {
    client.release();
  }
}
