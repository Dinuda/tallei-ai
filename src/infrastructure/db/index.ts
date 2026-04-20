import pg from "pg";
import { config } from "../../config/index.js";
import { decryptMemoryContent } from "../crypto/memory-crypto.js";

const { Pool } = pg;

function createPool(connectionString: string): pg.Pool {
  const dbPool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 45000,
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
      table: "memory_entities",
      policy: "memory_entities_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "memory_entity_mentions",
      policy: "memory_entity_mentions_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "memory_relations",
      policy: "memory_relations_tenant_user_policy",
      condition: "((auth.jwt()->>'tenant_id')::uuid = tenant_id AND (auth.jwt()->>'sub')::uuid = user_id)",
    },
    {
      table: "memory_graph_jobs",
      policy: "memory_graph_jobs_tenant_user_policy",
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
      CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id
        ON memory_events(memory_id, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_entities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        canonical_label TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'topic',
        normalized_label TEXT NOT NULL,
        first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        source_confidence REAL NOT NULL DEFAULT 0.75,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entities_unique_label
        ON memory_entities(tenant_id, user_id, normalized_label);
      CREATE INDEX IF NOT EXISTS idx_memory_entities_tenant_user_type
        ON memory_entities(tenant_id, user_id, entity_type, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_entities_tenant_user_seen
        ON memory_entities(tenant_id, user_id, last_seen_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_entity_mentions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        memory_id UUID NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
        entity_id UUID NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        mention_text TEXT NOT NULL,
        start_offset INTEGER NOT NULL DEFAULT 0,
        end_offset INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.7,
        extraction_source TEXT NOT NULL DEFAULT 'deterministic',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entity_mentions_unique
        ON memory_entity_mentions(tenant_id, user_id, memory_id, entity_id, mention_text);
      CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_memory
        ON memory_entity_mentions(tenant_id, user_id, memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity
        ON memory_entity_mentions(tenant_id, user_id, entity_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_relations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_entity_id UUID NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        target_entity_id UUID NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        confidence_label TEXT NOT NULL DEFAULT 'inferred'
          CHECK (confidence_label IN ('explicit', 'inferred', 'uncertain')),
        confidence_score REAL NOT NULL DEFAULT 0.7,
        evidence_memory_id UUID REFERENCES memory_records(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_relations_unique
        ON memory_relations(tenant_id, user_id, source_entity_id, target_entity_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_memory_relations_source
        ON memory_relations(tenant_id, user_id, source_entity_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_relations_target
        ON memory_relations(tenant_id, user_id, target_entity_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_relations_confidence
        ON memory_relations(tenant_id, user_id, confidence_label, confidence_score DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_graph_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        memory_id UUID REFERENCES memory_records(id) ON DELETE CASCADE,
        job_type TEXT NOT NULL
          CHECK (job_type IN ('extract', 'backfill', 'snapshot_refresh')),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'retry', 'failed', 'done')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_run_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        error_code TEXT,
        error_message TEXT,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE memory_graph_jobs
      DROP CONSTRAINT IF EXISTS memory_graph_jobs_job_type_check;
      ALTER TABLE memory_graph_jobs
      ADD CONSTRAINT memory_graph_jobs_job_type_check
      CHECK (job_type IN ('extract', 'backfill', 'snapshot_refresh'));

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_graph_jobs_extract_unique
        ON memory_graph_jobs(tenant_id, user_id, memory_id, job_type)
        WHERE status IN ('queued', 'running', 'retry');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_graph_jobs_snapshot_unique
        ON memory_graph_jobs(tenant_id, user_id, job_type)
        WHERE job_type = 'snapshot_refresh' AND status IN ('queued', 'running', 'retry');
      CREATE INDEX IF NOT EXISTS idx_memory_graph_jobs_poll
        ON memory_graph_jobs(status, next_run_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_graph_jobs_user_created
        ON memory_graph_jobs(tenant_id, user_id, created_at DESC);
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
