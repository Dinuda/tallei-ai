import pg from "pg";
import { config } from "../../config/index.js";

const { Pool } = pg;

const POOL_STATEMENT_TIMEOUT_MS = 5000;
const POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000;

const TRANSIENT_POOL_ERROR =
  /connection terminated|connection timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|Cannot use a pool after calling end/i;

export function isTransientPoolError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (TRANSIENT_POOL_ERROR.test(error.message)) return true;
  const cause = error.cause;
  if (cause instanceof Error && TRANSIENT_POOL_ERROR.test(cause.message)) return true;
  return false;
}

export async function poolQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  queryText: string,
  values?: unknown[],
): Promise<pg.QueryResult<T>> {
  try {
    return await pool.query<T>(queryText, values);
  } catch (error) {
    if (!isTransientPoolError(error)) throw error;
    return pool.query<T>(queryText, values);
  }
}

function createPool(connectionString: string): pg.Pool {
  const dbPool = new Pool({
    connectionString,
    connectionTimeoutMillis: 8000,
    query_timeout: 30000,
    max: 30,
    idleTimeoutMillis: 30000,
    keepAlive: true,
    statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });

  dbPool.on("error", (error: Error & { code?: string }) => {
    const code = error?.code ?? "UNKNOWN";
    const message = error?.message ?? "unknown pool error";
    // Prevent process crash on idle client socket errors from pg-pool.
    console.error(`[db] pool idle client error code=${code} message=${message}`);
  });

  return dbPool;
}

export let pool = createPool(config.databaseUrl);

type DbClient = pg.PoolClient;

function isAuthFailure(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : "";
  const cause = error instanceof Error ? error.cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : "";

  return code === "28P01"
    || /password authentication failed|invalid password/i.test(message)
    || /password authentication failed|invalid password/i.test(causeMessage);
}

function shouldAttemptDatabaseFallback(error: unknown): boolean {
  if (!config.databaseUrlFallback) return false;
  if (config.databaseUrlFallback === config.databaseUrl) return false;
  return isAuthFailure(error);
}

async function connectDbClient(): Promise<DbClient> {
  try {
    return await pool.connect();
  } catch (error) {
    if (!shouldAttemptDatabaseFallback(error)) throw error;

    const primaryPool = pool;
    const fallbackPool = createPool(config.databaseUrlFallback);
    pool = fallbackPool;

    try {
      const client = await fallbackPool.connect();
      await primaryPool.end().catch((endError: unknown) => {
        const message = endError instanceof Error ? endError.message : String(endError);
        console.warn(`[db] failed to close primary pool after fallback swap: ${message}`);
      });
      console.warn("[db] primary database auth failed; switched to fallback connection URL");
      return client;
    } catch (fallbackError) {
      pool = primaryPool;
      await fallbackPool.end().catch(() => undefined);
      throw fallbackError;
    }
  }
}

const MEMORY_TYPE_CHECK = "'preference', 'fact', 'event', 'decision', 'note', 'checkpoint'";

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

async function configureMigrationSession(client: DbClient): Promise<void> {
  // Boot-time DDL can exceed the pool's
  // 5s statement timeout on non-trivial databases.
  await client.query("SET statement_timeout = 0");
  await client.query("SET idle_in_transaction_session_timeout = 0");
}

async function restorePoolSessionTimeouts(client: DbClient): Promise<void> {
  await client.query(`SET statement_timeout = ${POOL_STATEMENT_TIMEOUT_MS}`);
  await client.query(`SET idle_in_transaction_session_timeout = ${POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS}`);
}


const REMOVED_AUTOMATION_TABLES = [
  "workspace_knowledge_base_entries",
  "workspace_knowledge_bases",
  "workspace_memory_records",
  "workspace_memberships",
  "user_workspace_preferences",
  "loop_workspaces",
  "loop_engine_events",
  "loop_engine_artifacts",
  "loop_engine_interactions",
  "loop_engine_commands",
  "loop_engine_boundaries",
  "loop_engine_step_attempts",
  "loop_run_messages",
  "loop_engine_gates",
  "loop_engine_runs",
  "loop_agent_avatars",
  "loop_run_gates",
  "loop_run_events",
  "loop_run_comments",
  "loop_run_tasks",
  "loop_heartbeat_jobs",
  "workflow_run_steps",
  "workflow_runs",
  "workflow_connector_trigger_events",
  "workflow_connector_triggers",
  "workflow_verification_runs",
  "workflow_builder_actions",
  "workflow_builder_turns",
  "workflow_builder_commands",
  "workflow_builder_messages",
  "workflow_builder_sessions",
  "workflow_approval_tokens",
  "loop_specs",
  "workflows",
  "workflow_suggestions",
  "episode_turns",
  "episodes",
  "patterns",
  "loop_miner_runs",
  "learned_tool_use_cases",
  "learned_tool_specs",
  "connector_action_events",
  "connector_auth_sessions",
  "connector_accounts",
  "connector_adapters",
  "integration_asset_acknowledgements",
  "ai_activity_events",
  "daily_intelligence_runs",
  "approvals",
  "channel_messages",
  "channel_setup_sessions",
  "notification_deliveries",
  "notification_channels",
  "resend_broadcast_events",
] as const;

async function dropRemovedAutomationTables(client: DbClient): Promise<void> {
  for (const table of REMOVED_AUTOMATION_TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }

  await client.query(`
    DROP INDEX IF EXISTS idx_documents_workspace;
    DROP INDEX IF EXISTS idx_document_lots_workspace;
    DROP INDEX IF EXISTS idx_collab_tasks_workspace;

    ALTER TABLE documents DROP COLUMN IF EXISTS workspace_id;
    ALTER TABLE document_lots DROP COLUMN IF EXISTS workspace_id;
    ALTER TABLE collab_tasks DROP COLUMN IF EXISTS workspace_id;
  `);
}

export async function initDb() {
  const client = await connectDbClient();
  let migrationSessionConfigured = false;
  try {
    if (!config.dbAutoMigrateOnBoot) {
      await client.query("SELECT 1");
      console.log("[db] auto-migrate on boot disabled; skipping schema init.");
      return;
    }

    await configureMigrationSession(client);
    migrationSessionConfigured = true;
    await dropRemovedAutomationTables(client);
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
      CREATE TABLE IF NOT EXISTS user_task_preferences (
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        grill_me_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, user_id)
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
      DROP INDEX IF EXISTS idx_tenant_memberships_tenant_id;
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
      CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(user_id, revoked_at) WHERE revoked_at IS NULL;
      DROP INDEX IF EXISTS idx_api_keys_hash;
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
        tier TEXT NOT NULL DEFAULT 'long_term',
        segment TEXT,
        importance NUMERIC(5,4) NOT NULL DEFAULT 0.5000,
        decay_rate NUMERIC(8,6) NOT NULL DEFAULT 0.010000,
        access_count INTEGER NOT NULL DEFAULT 1,
        lifecycle TEXT NOT NULL DEFAULT 'active',
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

    await client.query(`
      ALTER TABLE memory_records
      ADD COLUMN IF NOT EXISTS memory_type TEXT,
      ADD COLUMN IF NOT EXISTS category TEXT,
      ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reference_count INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'long_term',
      ADD COLUMN IF NOT EXISTS segment TEXT,
      ADD COLUMN IF NOT EXISTS importance NUMERIC(5,4) DEFAULT 0.5000,
      ADD COLUMN IF NOT EXISTS decay_rate NUMERIC(8,6) DEFAULT 0.010000,
      ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS lifecycle TEXT DEFAULT 'active',
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
      UPDATE memory_records
      SET tier = CASE
            WHEN is_pinned = TRUE OR memory_type = 'preference'
              OR lower(COALESCE(category, '')) IN ('identity', 'auth', 'billing', 'security', 'legal', 'payment', 'credentials', 'account')
              THEN 'permanent'
            WHEN memory_type IN ('event', 'note') THEN 'short_term'
            ELSE 'long_term'
          END
      WHERE tier IS NULL OR tier NOT IN ('short_term', 'long_term', 'permanent');
      UPDATE memory_records
      SET segment = COALESCE(segment, category, memory_type)
      WHERE segment IS NULL;
      UPDATE memory_records
      SET importance = CASE
            WHEN is_pinned = TRUE OR memory_type = 'preference' THEN 0.9500
            WHEN lower(COALESCE(category, '')) IN ('identity', 'auth', 'billing', 'security', 'legal', 'payment', 'credentials', 'account') THEN 0.9500
            WHEN memory_type IN ('decision', 'checkpoint') THEN 0.7500
            WHEN memory_type IN ('event', 'note') THEN 0.3500
            ELSE 0.6000
          END
      WHERE importance IS NULL;
      UPDATE memory_records
      SET decay_rate = CASE
            WHEN tier = 'permanent' THEN 0.000000
            WHEN tier = 'short_term' THEN 0.080000
            ELSE 0.010000
          END
      WHERE decay_rate IS NULL;
      UPDATE memory_records
      SET access_count = reference_count
      WHERE access_count IS NULL;
      UPDATE memory_records
      SET lifecycle = CASE
            WHEN tier = 'permanent' THEN 'protected'
            ELSE 'active'
          END
      WHERE lifecycle IS NULL OR lifecycle NOT IN ('active', 'cooling', 'stale', 'archived', 'protected');
    `);

    await client.query(`
      ALTER TABLE memory_records
      ALTER COLUMN memory_type SET DEFAULT 'fact',
      ALTER COLUMN memory_type SET NOT NULL,
      ALTER COLUMN is_pinned SET DEFAULT FALSE,
      ALTER COLUMN is_pinned SET NOT NULL,
      ALTER COLUMN reference_count SET DEFAULT 1,
      ALTER COLUMN reference_count SET NOT NULL,
      ALTER COLUMN tier SET DEFAULT 'long_term',
      ALTER COLUMN tier SET NOT NULL,
      ALTER COLUMN importance SET DEFAULT 0.5000,
      ALTER COLUMN importance SET NOT NULL,
      ALTER COLUMN decay_rate SET DEFAULT 0.010000,
      ALTER COLUMN decay_rate SET NOT NULL,
      ALTER COLUMN access_count SET DEFAULT 1,
      ALTER COLUMN access_count SET NOT NULL,
      ALTER COLUMN lifecycle SET DEFAULT 'active',
      ALTER COLUMN lifecycle SET NOT NULL;
    `);

    await client.query(`
      ALTER TABLE memory_records
      DROP CONSTRAINT IF EXISTS memory_records_memory_type_check;
      ALTER TABLE memory_records
      ADD CONSTRAINT memory_records_memory_type_check
      CHECK (memory_type IN (${MEMORY_TYPE_CHECK}));
      ALTER TABLE memory_records
      DROP CONSTRAINT IF EXISTS memory_records_tier_check;
      ALTER TABLE memory_records
      ADD CONSTRAINT memory_records_tier_check
      CHECK (tier IN ('short_term', 'long_term', 'permanent'));
      ALTER TABLE memory_records
      DROP CONSTRAINT IF EXISTS memory_records_lifecycle_check;
      ALTER TABLE memory_records
      ADD CONSTRAINT memory_records_lifecycle_check
      CHECK (lifecycle IN ('active', 'cooling', 'stale', 'archived', 'protected'));
      ALTER TABLE memory_records
      DROP CONSTRAINT IF EXISTS memory_records_importance_check;
      ALTER TABLE memory_records
      ADD CONSTRAINT memory_records_importance_check
      CHECK (importance >= 0 AND importance <= 1);
      ALTER TABLE memory_records
      DROP CONSTRAINT IF EXISTS memory_records_decay_rate_check;
      ALTER TABLE memory_records
      ADD CONSTRAINT memory_records_decay_rate_check
      CHECK (decay_rate >= 0);
      ALTER TABLE memory_records
      DROP CONSTRAINT IF EXISTS memory_records_access_count_check;
      ALTER TABLE memory_records
      ADD CONSTRAINT memory_records_access_count_check
      CHECK (access_count >= 0);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_records_type_pin
        ON memory_records(tenant_id, user_id, memory_type, is_pinned)
        WHERE deleted_at IS NULL AND superseded_by IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_records_reference_count
        ON memory_records(tenant_id, user_id, reference_count DESC, last_referenced_at DESC)
        WHERE deleted_at IS NULL AND superseded_by IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_records_retention
        ON memory_records(tenant_id, user_id, tier, lifecycle, importance DESC, access_count DESC)
        WHERE deleted_at IS NULL AND superseded_by IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_records_superseded_by
        ON memory_records(tenant_id, user_id, superseded_by)
        WHERE superseded_by IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_records_content_hash_active
        ON memory_records(tenant_id, user_id, content_hash)
        WHERE deleted_at IS NULL AND superseded_by IS NULL;
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
      CREATE INDEX IF NOT EXISTS idx_memory_events_tenant_action_created
        ON memory_events(tenant_id, action, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id
        ON memory_events(memory_id, created_at DESC);
    `);


    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_cleanup_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL
          CHECK (status IN ('running', 'completed', 'failed')),
        run_reason TEXT NOT NULL
          CHECK (run_reason IN ('daily_intelligence', 'manual')),
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_cleanup_runs_scope_created
        ON memory_cleanup_runs(tenant_id, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_cleanup_runs_scope_status
        ON memory_cleanup_runs(tenant_id, user_id, status, updated_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_cleanup_proposals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id UUID NOT NULL REFERENCES memory_cleanup_runs(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        proposal_type TEXT NOT NULL
          CHECK (proposal_type IN ('bucket', 'keep', 'promote', 'merge', 'rewrite', 'prune')),
        status TEXT NOT NULL
          CHECK (status IN ('proposed', 'contested', 'approved', 'rejected', 'applied', 'failed')),
        source_memory_ids UUID[] NOT NULL,
        target_memory_id UUID,
        proposed_content TEXT,
        rationale TEXT NOT NULL,
        risk_level TEXT NOT NULL
          CHECK (risk_level IN ('low', 'medium', 'high')),
        confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
        cleanup_bucket TEXT
          CHECK (cleanup_bucket IS NULL OR cleanup_bucket IN ('short_term', 'long_term', 'permanent')),
        cleanup_bucket_reason TEXT,
        cleanup_bucket_confidence NUMERIC(5,4),
        consolidator_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        adversary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        debate_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        judge_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        apply_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_cleanup_proposals_run
        ON memory_cleanup_proposals(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_cleanup_proposals_scope_status
        ON memory_cleanup_proposals(tenant_id, user_id, status, updated_at DESC);
    `);

    await client.query(`
      ALTER TABLE memory_cleanup_proposals
      DROP CONSTRAINT IF EXISTS memory_cleanup_proposals_proposal_type_check;
      ALTER TABLE memory_cleanup_proposals
      ADD CONSTRAINT memory_cleanup_proposals_proposal_type_check
      CHECK (proposal_type IN ('bucket', 'keep', 'promote', 'merge', 'rewrite', 'prune'));
      ALTER TABLE memory_cleanup_proposals
      ADD COLUMN IF NOT EXISTS cleanup_bucket TEXT,
      ADD COLUMN IF NOT EXISTS cleanup_bucket_reason TEXT,
      ADD COLUMN IF NOT EXISTS cleanup_bucket_confidence NUMERIC(5,4);
      ALTER TABLE memory_cleanup_proposals
      DROP CONSTRAINT IF EXISTS memory_cleanup_proposals_cleanup_bucket_check;
      ALTER TABLE memory_cleanup_proposals
      ADD CONSTRAINT memory_cleanup_proposals_cleanup_bucket_check
      CHECK (cleanup_bucket IS NULL OR cleanup_bucket IN ('short_term', 'long_term', 'permanent'));
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_cleanup_memory_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        memory_id UUID NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
        last_run_id UUID NOT NULL REFERENCES memory_cleanup_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL
          CHECK (status IN ('reviewed', 'applied', 'skipped')),
        reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (tenant_id, user_id, memory_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_cleanup_memory_reviews_scope_reviewed
        ON memory_cleanup_memory_reviews(tenant_id, user_id, reviewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_cleanup_memory_reviews_run
        ON memory_cleanup_memory_reviews(last_run_id);
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
      DROP INDEX IF EXISTS idx_oauth_tokens_refresh;
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
      ADD COLUMN IF NOT EXISTS download_link TEXT,
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 4,
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP WITH TIME ZONE;

      ALTER TABLE uploaded_file_ingest_jobs
      DROP CONSTRAINT IF EXISTS uploaded_file_ingest_jobs_status_check;
      ALTER TABLE uploaded_file_ingest_jobs
      ADD CONSTRAINT uploaded_file_ingest_jobs_status_check
        CHECK (status IN ('pending', 'processing', 'done', 'failed'));

      UPDATE uploaded_file_ingest_jobs
      SET status = 'pending'
      WHERE status = 'processing';

      UPDATE uploaded_file_ingest_jobs
      SET next_attempt_at = COALESCE(next_attempt_at, CURRENT_TIMESTAMP),
          max_attempts = CASE WHEN max_attempts < 1 THEN 1 ELSE max_attempts END;

      CREATE INDEX IF NOT EXISTS idx_uploaded_file_ingest_jobs_pending
        ON uploaded_file_ingest_jobs(status, next_attempt_at ASC, created_at ASC)
        WHERE status = 'pending';

      CREATE INDEX IF NOT EXISTS idx_uploaded_file_ingest_jobs_status_attempts
        ON uploaded_file_ingest_jobs(status, attempt_count, max_attempts, next_attempt_at ASC)
        WHERE status IN ('pending', 'failed');
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chatgpt_import_jobs (
        ref TEXT PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'processing', 'done', 'failed')),
        request_json JSONB NOT NULL,
        progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        result_json JSONB,
        error_json JSONB,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 4,
        next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_attempt_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP WITH TIME ZONE
      );

      CREATE INDEX IF NOT EXISTS idx_chatgpt_import_jobs_tenant_user_created
        ON chatgpt_import_jobs(tenant_id, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chatgpt_import_jobs_tenant_user_status
        ON chatgpt_import_jobs(tenant_id, user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chatgpt_import_jobs_pending
        ON chatgpt_import_jobs(status, next_attempt_at ASC, created_at ASC)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_chatgpt_import_jobs_status_attempts
        ON chatgpt_import_jobs(status, attempt_count, max_attempts, next_attempt_at ASC)
        WHERE status IN ('pending', 'failed');
    `);

    await client.query(`
      ALTER TABLE chatgpt_import_jobs
      ADD COLUMN IF NOT EXISTS storage_ref TEXT,
      ADD COLUMN IF NOT EXISTS original_filename TEXT;
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
      ALTER TABLE orchestration_sessions
      ADD COLUMN IF NOT EXISTS collab_task_id UUID REFERENCES collab_tasks(id) ON DELETE SET NULL;
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
      DROP INDEX IF EXISTS idx_browser_flow_templates_learned;
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

        -- Intentionally retain cache rows when source key is missing.
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

        -- Intentionally retain cache rows even when matching keys no longer exist.
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

        -- Intentionally retain cache rows even when source rows are missing.
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

    // Intentionally do not delete from api_key_context_cache during migration.

    // #13 + #9: Hash-only token storage + family-based rotation
    // Intentionally preserve existing oauth_tokens.
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
    // Intentionally preserve existing jwt_revocations.

    // #10: HMAC-pepper for API key hashes
    // Intentionally preserve existing api_keys.
    await client.query(`
      ALTER TABLE api_keys
        DROP COLUMN IF EXISTS pepper_version;
    `);

    await applySupabaseRlsPolicies(client);

    console.log("Database schema initialized successfully.");
  } catch (error) {
    console.error("Error initializing database schema:", error);
    throw error;
  } finally {
    if (migrationSessionConfigured) {
      try {
        await restorePoolSessionTimeouts(client);
      } catch {
        // Discard broken connections instead of returning them to the pool.
        client.release(true);
        return;
      }
    }
    client.release();
  }
}
