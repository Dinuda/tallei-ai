import pg from "pg";
import { config } from "../../config/index.js";
import { decryptMemoryContent } from "../crypto/memory-crypto.js";

const { Pool } = pg;

function createPool(connectionString: string): pg.Pool {
  const dbPool = new Pool({
    connectionString,
    connectionTimeoutMillis: 2000,
    query_timeout: 30000,
    max: 30,
    idleTimeoutMillis: 30000,
    keepAlive: true,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
  });

  dbPool.on("error", (error: Error & { code?: string }) => {
    const code = error?.code ?? "UNKNOWN";
    const message = error?.message ?? "unknown pool error";
    // Prevent process crash on idle client socket errors from pg-pool.
    console.error(`[db] pool idle client error code=${code} message=${message}`);
  });

  return dbPool;
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

type MemoryType = "preference" | "fact" | "event" | "decision" | "note";

const MEMORY_TYPE_CHECK = "'preference', 'fact', 'event', 'decision', 'note'";

function classifyLegacyMemoryText(content: string): { memoryType: MemoryType; category: string | null; isPinned: boolean } {
  const text = content.trim();
  const isPreference =
    /\b(i\s+prefer|i\s+like|i\s+love|i\s+hate|my\s+favou?rite|preferred)\b/i.test(text) ||
    /\b(my\s+name\s+is|my\s+email\s+is|my\s+phone|my\s+pronouns|i\s+live\s+in|i\s+am\s+from)\b/i.test(text);
  if (isPreference) {
    if (/\b(my\s+name\s+is|my\s+email\s+is|my\s+phone|my\s+pronouns)\b/i.test(text)) {
      return { memoryType: "preference", category: "identity", isPinned: true };
    }
    if (/\b(ui|ux|design|theme|color|style)\b/i.test(text)) {
      return { memoryType: "preference", category: "ui", isPinned: true };
    }
    if (/\b(next\.js|typescript|react|node|postgres|qdrant|stack)\b/i.test(text)) {
      return { memoryType: "preference", category: "stack", isPinned: true };
    }
    return { memoryType: "preference", category: null, isPinned: true };
  }
  if (/\b(decide|decided|decision|agreed|chose|chosen)\b/i.test(text)) {
    return { memoryType: "decision", category: null, isPinned: false };
  }
  if (/\b(yesterday|today|tomorrow|last\s+week|last\s+month|meeting|event|happened)\b/i.test(text)) {
    return { memoryType: "event", category: null, isPinned: false };
  }
  if (/\b(note|reminder|todo|to\s*do)\b/i.test(text)) {
    return { memoryType: "note", category: null, isPinned: false };
  }
  return { memoryType: "fact", category: null, isPinned: false };
}

async function hasColumn(client: DbClient, table: string, column: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    ) AS exists`,
    [table, column]
  );
  return Boolean(result.rows[0]?.exists);
}

async function backfillMemoryTypes(client: DbClient): Promise<void> {
  const rows = await client.query<{
    id: string;
    content_ciphertext: string;
    memory_type: string;
    category: string | null;
    is_pinned: boolean | null;
  }>(
    `SELECT id, content_ciphertext, memory_type, category, is_pinned
     FROM memory_records
     WHERE deleted_at IS NULL
       AND superseded_by IS NULL`
  );

  for (const row of rows.rows) {
    if (
      row.memory_type !== "fact" ||
      row.category !== null ||
      row.is_pinned === true
    ) {
      continue;
    }

    let plaintext = "";
    try {
      plaintext = decryptMemoryContent(row.content_ciphertext);
    } catch {
      continue;
    }

    const classified = classifyLegacyMemoryText(plaintext);
    if (
      classified.memoryType === "fact" &&
      classified.category === null &&
      classified.isPinned === false
    ) {
      continue;
    }

    await client.query(
      `UPDATE memory_records
       SET memory_type = $1,
           category = COALESCE($2, category),
           is_pinned = CASE WHEN $3 THEN TRUE ELSE is_pinned END
       WHERE id = $4`,
      [classified.memoryType, classified.category, classified.isPinned, row.id]
    );
  }
}

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
    UPDATE oauth_device_codes odc
    SET tenant_id = tm.tenant_id
    FROM tenant_memberships tm
    WHERE odc.user_id = tm.user_id
      AND odc.tenant_id IS NULL
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
      table: "document_lots",
      policy: "document_lots_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "documents",
      policy: "documents_tenant_user_policy",
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
    {
      table: "collab_tasks",
      policy: "collab_tasks_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "orchestration_sessions",
      policy: "orchestration_sessions_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
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
    if (!config.dbAutoMigrateOnBoot) {
      await client.query("SELECT 1");
      console.log("[db] auto-migrate on boot disabled; skipping schema init.");
      return;
    }

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
      ALTER TABLE api_keys
      ADD COLUMN IF NOT EXISTS connector_type TEXT
        CHECK (connector_type IN ('claude', 'chatgpt', 'gemini', 'other'));
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS api_keys_user_connector_unique
        ON api_keys (user_id, connector_type)
        WHERE revoked_at IS NULL AND connector_type IS NOT NULL;
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
        memory_type TEXT NOT NULL DEFAULT 'fact',
        category TEXT,
        is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
        reference_count INTEGER NOT NULL DEFAULT 1,
        last_referenced_at TIMESTAMP WITH TIME ZONE,
        superseded_by UUID NULL REFERENCES memory_records(id) ON DELETE SET NULL,
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
      CREATE TABLE IF NOT EXISTS document_lots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ref_handle TEXT NOT NULL,
        title TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMPTZ,
        UNIQUE (tenant_id, ref_handle)
      );

      CREATE INDEX IF NOT EXISTS idx_document_lots_tenant_user_created
        ON document_lots(tenant_id, user_id, created_at DESC)
        WHERE deleted_at IS NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ref_handle TEXT NOT NULL,
        lot_id UUID NULL REFERENCES document_lots(id) ON DELETE SET NULL,
        filename TEXT,
        title TEXT,
        mime_type TEXT,
        byte_size INTEGER NOT NULL,
        content_ciphertext TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        qdrant_point_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'ready', 'failed')),
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMPTZ,
        UNIQUE (tenant_id, ref_handle)
      );

      CREATE INDEX IF NOT EXISTS idx_documents_tenant_user_created
        ON documents(tenant_id, user_id, created_at DESC)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_documents_lot
        ON documents(lot_id)
        WHERE lot_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_documents_content_hash_active
        ON documents(tenant_id, user_id, content_hash)
        WHERE deleted_at IS NULL;
    `);

    await client.query(`
      ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'blob';
    `);

    await client.query(`
      ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS conversation_id TEXT,
      ADD COLUMN IF NOT EXISTS blob_provider TEXT,
      ADD COLUMN IF NOT EXISTS blob_key TEXT,
      ADD COLUMN IF NOT EXISTS blob_url TEXT,
      ADD COLUMN IF NOT EXISTS blob_source_file_id TEXT;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_conversation_id
        ON documents(tenant_id, user_id, conversation_id, created_at DESC)
        WHERE deleted_at IS NULL AND conversation_id IS NOT NULL;
    `);

    const hadMemoryTypeColumn = await hasColumn(client, "memory_records", "memory_type");
    const hadCategoryColumn = await hasColumn(client, "memory_records", "category");
    const hadPinnedColumn = await hasColumn(client, "memory_records", "is_pinned");
    const hadReferenceCountColumn = await hasColumn(client, "memory_records", "reference_count");
    const hadLastReferencedAtColumn = await hasColumn(client, "memory_records", "last_referenced_at");
    const hadSupersededByColumn = await hasColumn(client, "memory_records", "superseded_by");

    await client.query(`
      ALTER TABLE memory_records
      ADD COLUMN IF NOT EXISTS memory_type TEXT,
      ADD COLUMN IF NOT EXISTS category TEXT,
      ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reference_count INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS superseded_by UUID NULL REFERENCES memory_records(id) ON DELETE SET NULL;
    `);

    await client.query(`
      UPDATE memory_records
      SET memory_type = 'fact'
      WHERE memory_type IS NULL;
      UPDATE memory_records
      SET is_pinned = FALSE
      WHERE is_pinned IS NULL;
      UPDATE memory_records
      SET reference_count = 1
      WHERE reference_count IS NULL;
    `);

    await client.query(`
      ALTER TABLE memory_records
      ALTER COLUMN memory_type SET DEFAULT 'fact',
      ALTER COLUMN memory_type SET NOT NULL,
      ALTER COLUMN is_pinned SET DEFAULT FALSE,
      ALTER COLUMN is_pinned SET NOT NULL,
      ALTER COLUMN reference_count SET DEFAULT 1,
      ALTER COLUMN reference_count SET NOT NULL;
    `);

    await client.query(`
      ALTER TABLE memory_records
      DROP CONSTRAINT IF EXISTS memory_records_memory_type_check;
      ALTER TABLE memory_records
      ADD CONSTRAINT memory_records_memory_type_check
      CHECK (memory_type IN (${MEMORY_TYPE_CHECK}));
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_records_type_pin
        ON memory_records(tenant_id, user_id, memory_type, is_pinned)
        WHERE deleted_at IS NULL AND superseded_by IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_records_reference_count
        ON memory_records(tenant_id, user_id, reference_count DESC, last_referenced_at DESC)
        WHERE deleted_at IS NULL AND superseded_by IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_records_superseded_by
        ON memory_records(tenant_id, user_id, superseded_by)
        WHERE superseded_by IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_records_content_hash_active
        ON memory_records(tenant_id, user_id, content_hash)
        WHERE deleted_at IS NULL AND superseded_by IS NULL;
    `);

    if (
      !hadMemoryTypeColumn ||
      !hadCategoryColumn ||
      !hadPinnedColumn ||
      !hadReferenceCountColumn ||
      !hadLastReferencedAtColumn ||
      !hadSupersededByColumn
    ) {
      await backfillMemoryTypes(client);
    }

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
      CREATE INDEX IF NOT EXISTS idx_memory_events_tenant_action_created
        ON memory_events(tenant_id, action, created_at DESC);
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
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS grant_type TEXT NOT NULL DEFAULT 'authorization_code';

      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_tenant ON oauth_tokens(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access_expiry ON oauth_tokens(access_expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_expiry ON oauth_tokens(refresh_expires_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_device_codes (
        device_code TEXT PRIMARY KEY,
        user_code TEXT UNIQUE NOT NULL,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        code_challenge TEXT NOT NULL,
        scope TEXT,
        resource TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
        interval_seconds INTEGER NOT NULL DEFAULT 5,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        approved_at TIMESTAMP WITH TIME ZONE,
        consumed_at TIMESTAMP WITH TIME ZONE,
        last_polled_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_device_codes_user_code
        ON oauth_device_codes(user_code);
      CREATE INDEX IF NOT EXISTS idx_oauth_device_codes_status
        ON oauth_device_codes(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_device_codes_client
        ON oauth_device_codes(client_id, created_at DESC);
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
        collab_task_id UUID,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        ok BOOLEAN NOT NULL DEFAULT true,
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE mcp_call_events
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS collab_task_id UUID,
      ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

      CREATE INDEX IF NOT EXISTS idx_mcp_call_events_created_at
        ON mcp_call_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_call_events_tool_name
        ON mcp_call_events(tool_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_call_events_tenant_id
        ON mcp_call_events(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_call_events_user_id
        ON mcp_call_events(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_call_events_collab_task_id
        ON mcp_call_events(collab_task_id, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS uploaded_file_ingest_jobs (
        ref TEXT PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        openai_file_id TEXT NOT NULL,
        download_link TEXT NOT NULL,
        filename TEXT NOT NULL,
        title TEXT,
        mime_type TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'processing', 'done', 'failed')),
        document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
        conversation_id TEXT,
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP WITH TIME ZONE
      );

      CREATE INDEX IF NOT EXISTS idx_uploaded_file_ingest_jobs_tenant_user_created
        ON uploaded_file_ingest_jobs(tenant_id, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_uploaded_file_ingest_jobs_tenant_user_status
        ON uploaded_file_ingest_jobs(tenant_id, user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_uploaded_file_ingest_jobs_status_completed
        ON uploaded_file_ingest_jobs(tenant_id, user_id, status, completed_at DESC)
        WHERE status = 'done' AND completed_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_uploaded_file_ingest_jobs_conversation
        ON uploaded_file_ingest_jobs(tenant_id, user_id, conversation_id, created_at DESC)
        WHERE conversation_id IS NOT NULL;
    `);

    await client.query(`
      ALTER TABLE uploaded_file_ingest_jobs
      ADD COLUMN IF NOT EXISTS title TEXT,
      ADD COLUMN IF NOT EXISTS download_link TEXT;

      ALTER TABLE uploaded_file_ingest_jobs
      DROP CONSTRAINT IF EXISTS uploaded_file_ingest_jobs_status_check;
      ALTER TABLE uploaded_file_ingest_jobs
      ADD CONSTRAINT uploaded_file_ingest_jobs_status_check
        CHECK (status IN ('pending', 'processing', 'done', 'failed'));

      UPDATE uploaded_file_ingest_jobs
      SET status = 'pending'
      WHERE status = 'processing';

      CREATE INDEX IF NOT EXISTS idx_uploaded_file_ingest_jobs_pending
        ON uploaded_file_ingest_jobs(status, created_at ASC)
        WHERE status = 'pending';
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_asset_acknowledgements (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        asset_key TEXT NOT NULL,
        acknowledged_version TEXT NOT NULL,
        acknowledged_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, asset_key)
      );

      CREATE INDEX IF NOT EXISTS idx_integration_asset_acknowledgements_user
        ON integration_asset_acknowledgements(user_id, acknowledged_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS claude_onboarding_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        current_state TEXT NOT NULL,
        project_name TEXT NOT NULL DEFAULT 'Tallei Memory',
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

      ALTER TABLE claude_onboarding_sessions
      ALTER COLUMN project_name SET DEFAULT 'Tallei Memory';

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
      CREATE TABLE IF NOT EXISTS collab_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        brief TEXT,
        state TEXT NOT NULL CHECK (state IN ('CREATIVE','TECHNICAL','DONE','ERROR')),
        last_actor TEXT CHECK (last_actor IN ('chatgpt','claude','user')),
        iteration INT NOT NULL DEFAULT 0,
        max_iterations INT NOT NULL DEFAULT 4,
        context JSONB NOT NULL DEFAULT '{}'::jsonb,
        transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_collab_tasks_owner
        ON collab_tasks(tenant_id, user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_collab_tasks_active
        ON collab_tasks(tenant_id, user_id, state)
        WHERE state IN ('CREATIVE','TECHNICAL');

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'mcp_call_events_collab_task_id_fkey'
        ) THEN
          ALTER TABLE mcp_call_events
          ADD CONSTRAINT mcp_call_events_collab_task_id_fkey
          FOREIGN KEY (collab_task_id) REFERENCES collab_tasks(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orchestration_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('DRAFT','INTERVIEWING','PLAN_READY','RUNNING','DONE','ABORTED')),
        transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
        plan JSONB,
        collab_task_id UUID REFERENCES collab_tasks(id) ON DELETE SET NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_orchestration_sessions_owner
        ON orchestration_sessions(tenant_id, user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orchestration_sessions_active
        ON orchestration_sessions(tenant_id, user_id, status)
        WHERE status IN ('INTERVIEWING','PLAN_READY','RUNNING');
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS browser_flow_templates (
        state              TEXT        NOT NULL PRIMARY KEY,
        actions            JSONB       NOT NULL DEFAULT '[]'::jsonb,
        success_count      INTEGER     NOT NULL DEFAULT 0,
        is_learned         BOOLEAN     NOT NULL DEFAULT FALSE,
        last_succeeded_at  TIMESTAMPTZ,
        created_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_browser_flow_templates_learned
        ON browser_flow_templates(state, is_learned) WHERE is_learned = TRUE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        plan                 TEXT NOT NULL DEFAULT 'free',
        ls_customer_id       TEXT,
        ls_subscription_id   TEXT UNIQUE,
        ls_variant_id        TEXT,
        status               TEXT NOT NULL DEFAULT 'active',
        cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
        current_period_end   TIMESTAMP WITH TIME ZONE,
        trial_ends_at        TIMESTAMP WITH TIME ZONE,
        created_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_tenant
        ON subscriptions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_ls_subscription
        ON subscriptions(ls_subscription_id);
    `);

    // Backfill free-tier rows for tenants that predate billing
    await client.query(`
      INSERT INTO subscriptions (tenant_id, plan, status)
      SELECT id, 'free', 'active' FROM tenants
      ON CONFLICT (tenant_id) DO NOTHING
    `);

    // Add trial_ends_at column for free-trial promotions
    await client.query(`
      ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP WITH TIME ZONE;
    `);

    // Replace the old materialized auth context with a deterministic derived cache table.
    await client.query(`
      DROP TRIGGER IF EXISTS trg_refresh_api_key_contexts_api_keys ON api_keys;
      DROP TRIGGER IF EXISTS trg_refresh_api_key_contexts_memberships ON tenant_memberships;
      DROP TRIGGER IF EXISTS trg_refresh_api_key_contexts_subscriptions ON subscriptions;
      DROP FUNCTION IF EXISTS refresh_api_key_contexts_mv();
      DROP MATERIALIZED VIEW IF EXISTS api_key_contexts;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_key_context_cache (
        key_hash TEXT PRIMARY KEY,
        key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        connector_type TEXT,
        plan TEXT,
        status TEXT,
        revoked_at TIMESTAMP WITH TIME ZONE,
        rotation_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_api_key_context_cache_tenant_user
        ON api_key_context_cache(tenant_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_api_key_context_cache_active
        ON api_key_context_cache(user_id, revoked_at, rotation_expires_at);
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION refresh_api_key_context_cache_by_hash(p_key_hash TEXT)
      RETURNS VOID
      LANGUAGE plpgsql
      AS $$
      BEGIN
        WITH source AS (
          SELECT
            ak.key_hash,
            ak.id AS key_id,
            ak.user_id,
            COALESCE(ak.tenant_id, tm.tenant_id) AS tenant_id,
            ak.connector_type,
            s.plan,
            s.status,
            ak.revoked_at,
            (ak.created_at + (ak.rotation_days || ' days')::interval) AS rotation_expires_at
          FROM api_keys ak
          LEFT JOIN tenant_memberships tm
            ON tm.user_id = ak.user_id
           AND ak.tenant_id IS NULL
          LEFT JOIN subscriptions s
            ON s.tenant_id = COALESCE(ak.tenant_id, tm.tenant_id)
          WHERE ak.key_hash = p_key_hash
          LIMIT 1
        )
        INSERT INTO api_key_context_cache (
          key_hash,
          key_id,
          user_id,
          tenant_id,
          connector_type,
          plan,
          status,
          revoked_at,
          rotation_expires_at,
          updated_at
        )
        SELECT
          source.key_hash,
          source.key_id,
          source.user_id,
          source.tenant_id,
          source.connector_type,
          source.plan,
          source.status,
          source.revoked_at,
          source.rotation_expires_at,
          NOW()
        FROM source
        ON CONFLICT (key_hash) DO UPDATE SET
          key_id = EXCLUDED.key_id,
          user_id = EXCLUDED.user_id,
          tenant_id = EXCLUDED.tenant_id,
          connector_type = EXCLUDED.connector_type,
          plan = EXCLUDED.plan,
          status = EXCLUDED.status,
          revoked_at = EXCLUDED.revoked_at,
          rotation_expires_at = EXCLUDED.rotation_expires_at,
          updated_at = NOW();

        IF NOT FOUND THEN
          DELETE FROM api_key_context_cache
          WHERE key_hash = p_key_hash;
        END IF;
      END;
      $$;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION refresh_api_key_context_cache_by_user_id(p_user_id UUID)
      RETURNS VOID
      LANGUAGE plpgsql
      AS $$
      DECLARE
        key_row RECORD;
      BEGIN
        FOR key_row IN
          SELECT key_hash
          FROM api_keys
          WHERE user_id = p_user_id
        LOOP
          PERFORM refresh_api_key_context_cache_by_hash(key_row.key_hash);
        END LOOP;

        DELETE FROM api_key_context_cache c
        WHERE c.user_id = p_user_id
          AND NOT EXISTS (
            SELECT 1
            FROM api_keys ak
            WHERE ak.key_hash = c.key_hash
          );
      END;
      $$;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION refresh_api_key_context_cache_by_tenant_id(p_tenant_id UUID)
      RETURNS VOID
      LANGUAGE plpgsql
      AS $$
      DECLARE
        key_row RECORD;
      BEGIN
        FOR key_row IN
          SELECT DISTINCT ak.key_hash
          FROM api_keys ak
          LEFT JOIN tenant_memberships tm
            ON tm.user_id = ak.user_id
           AND ak.tenant_id IS NULL
          WHERE COALESCE(ak.tenant_id, tm.tenant_id) = p_tenant_id
        LOOP
          PERFORM refresh_api_key_context_cache_by_hash(key_row.key_hash);
        END LOOP;

        DELETE FROM api_key_context_cache c
        WHERE c.tenant_id = p_tenant_id
          AND NOT EXISTS (
            SELECT 1
            FROM api_keys ak
            LEFT JOIN tenant_memberships tm
              ON tm.user_id = ak.user_id
             AND ak.tenant_id IS NULL
            WHERE ak.key_hash = c.key_hash
              AND COALESCE(ak.tenant_id, tm.tenant_id) = p_tenant_id
          );
      END;
      $$;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION trg_refresh_api_key_context_cache_api_keys()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          PERFORM refresh_api_key_context_cache_by_hash(OLD.key_hash);
          RETURN OLD;
        END IF;

        PERFORM refresh_api_key_context_cache_by_hash(NEW.key_hash);

        IF TG_OP = 'UPDATE' AND OLD.key_hash IS DISTINCT FROM NEW.key_hash THEN
          PERFORM refresh_api_key_context_cache_by_hash(OLD.key_hash);
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION trg_refresh_api_key_context_cache_memberships()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          PERFORM refresh_api_key_context_cache_by_user_id(OLD.user_id);
          RETURN OLD;
        END IF;

        PERFORM refresh_api_key_context_cache_by_user_id(NEW.user_id);

        IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
          PERFORM refresh_api_key_context_cache_by_user_id(OLD.user_id);
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION trg_refresh_api_key_context_cache_subscriptions()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          PERFORM refresh_api_key_context_cache_by_tenant_id(OLD.tenant_id);
          RETURN OLD;
        END IF;

        PERFORM refresh_api_key_context_cache_by_tenant_id(NEW.tenant_id);

        IF TG_OP = 'UPDATE' AND OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
          PERFORM refresh_api_key_context_cache_by_tenant_id(OLD.tenant_id);
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_refresh_api_key_context_cache_api_keys ON api_keys;
      CREATE TRIGGER trg_refresh_api_key_context_cache_api_keys
      AFTER INSERT OR UPDATE OR DELETE ON api_keys
      FOR EACH ROW
      EXECUTE FUNCTION trg_refresh_api_key_context_cache_api_keys();
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_refresh_api_key_context_cache_memberships ON tenant_memberships;
      CREATE TRIGGER trg_refresh_api_key_context_cache_memberships
      AFTER INSERT OR UPDATE OR DELETE ON tenant_memberships
      FOR EACH ROW
      EXECUTE FUNCTION trg_refresh_api_key_context_cache_memberships();
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_refresh_api_key_context_cache_subscriptions ON subscriptions;
      CREATE TRIGGER trg_refresh_api_key_context_cache_subscriptions
      AFTER INSERT OR UPDATE OR DELETE ON subscriptions
      FOR EACH ROW
      EXECUTE FUNCTION trg_refresh_api_key_context_cache_subscriptions();
    `);

    await client.query(`
      INSERT INTO api_key_context_cache (
        key_hash,
        key_id,
        user_id,
        tenant_id,
        connector_type,
        plan,
        status,
        revoked_at,
        rotation_expires_at,
        updated_at
      )
      SELECT
        ak.key_hash,
        ak.id AS key_id,
        ak.user_id,
        COALESCE(ak.tenant_id, tm.tenant_id) AS tenant_id,
        ak.connector_type,
        s.plan,
        s.status,
        ak.revoked_at,
        (ak.created_at + (ak.rotation_days || ' days')::interval) AS rotation_expires_at,
        NOW()
      FROM api_keys ak
      LEFT JOIN tenant_memberships tm
        ON tm.user_id = ak.user_id
       AND ak.tenant_id IS NULL
      LEFT JOIN subscriptions s
        ON s.tenant_id = COALESCE(ak.tenant_id, tm.tenant_id)
      ON CONFLICT (key_hash) DO UPDATE SET
        key_id = EXCLUDED.key_id,
        user_id = EXCLUDED.user_id,
        tenant_id = EXCLUDED.tenant_id,
        connector_type = EXCLUDED.connector_type,
        plan = EXCLUDED.plan,
        status = EXCLUDED.status,
        revoked_at = EXCLUDED.revoked_at,
        rotation_expires_at = EXCLUDED.rotation_expires_at,
        updated_at = NOW();
    `);

    await client.query(`
      DELETE FROM api_key_context_cache c
      WHERE NOT EXISTS (
        SELECT 1
        FROM api_keys ak
        WHERE ak.key_hash = c.key_hash
      );
    `);

    // #13 + #9: Hash-only token storage + family-based rotation
    // One-time migration: clear plaintext tokens before adding new columns.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'oauth_tokens' AND column_name = 'token_family_id'
        ) THEN
          DELETE FROM oauth_tokens;
        END IF;
      END $$;
    `);
    await client.query(`
      ALTER TABLE oauth_tokens
        ADD COLUMN IF NOT EXISTS token_family_id UUID,
        ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMP WITH TIME ZONE;
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family
        ON oauth_tokens(token_family_id) WHERE token_family_id IS NOT NULL;
    `);

    // #7: Session JWT revocation denylist
    await client.query(`
      CREATE TABLE IF NOT EXISTS jwt_revocations (
        jti TEXT PRIMARY KEY,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_jwt_revocations_expires
        ON jwt_revocations(expires_at);
    `);
    await client.query(`DELETE FROM jwt_revocations WHERE expires_at < NOW()`);

    // #10: HMAC-pepper for API key hashes
    // One-time migration: clear old bare-SHA-256 keys before switching to HMAC.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'api_keys' AND column_name = 'pepper_version'
        ) THEN
          DELETE FROM api_keys;
        END IF;
      END $$;
    `);
    await client.query(`
      ALTER TABLE api_keys
        ADD COLUMN IF NOT EXISTS pepper_version TEXT NOT NULL DEFAULT 'v1';
    `);

    await backfillTenants(client);
    await client.query(`
      UPDATE api_keys
      SET revoked_at = NOW()
      WHERE revoked_at IS NULL
        AND connector_type IS NULL
    `);
    await applySupabaseRlsPolicies(client);

    console.log("Database schema initialized successfully.");
  } catch (error) {
    console.error("Error initializing database schema:", error);
    throw error;
  } finally {
    client.release();
  }
}
