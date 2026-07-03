import type pg from "pg";

type DbClient = pg.PoolClient;

const WORKSPACE_AND_LOOP_TABLES_REMOVED_FROM_DROP_LIST = true;

export async function ensureLoopEngineSchema(client: DbClient): Promise<void> {
  if (!WORKSPACE_AND_LOOP_TABLES_REMOVED_FROM_DROP_LIST) return;

  await client.query(`
    CREATE TABLE IF NOT EXISTS loop_workspaces (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      user_id UUID NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      slug TEXT,
      kind TEXT NOT NULL DEFAULT 'custom',
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      icon TEXT,
      color TEXT,
      settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_loop_workspaces_tenant_user
      ON loop_workspaces(tenant_id, user_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS workspace_memberships (
      workspace_id UUID NOT NULL REFERENCES loop_workspaces(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL,
      user_id UUID NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user
      ON workspace_memberships(user_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_workspace_preferences (
      user_id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      last_active_workspace_id UUID REFERENCES loop_workspaces(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS connector_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      tenant_id UUID NOT NULL,
      user_id UUID NOT NULL,
      workspace_id UUID,
      toolkit TEXT NOT NULL,
      external_account_id TEXT,
      external_request_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'disconnected', 'failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE NULLS NOT DISTINCT (provider, tenant_id, user_id, workspace_id, toolkit)
    );
    CREATE INDEX IF NOT EXISTS idx_connector_connections_owner
      ON connector_connections(provider, tenant_id, user_id, workspace_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_connections_request
      ON connector_connections(provider, external_request_id)
      WHERE external_request_id IS NOT NULL;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS workspace_memory_records (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      workspace_id UUID NOT NULL REFERENCES loop_workspaces(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      content_ciphertext TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      summary_json JSONB,
      qdrant_point_id TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'fact',
      category TEXT,
      tier TEXT NOT NULL DEFAULT 'workspace',
      lifecycle TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_memory_workspace
      ON workspace_memory_records(workspace_id, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS loops (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      user_id UUID NOT NULL,
      workspace_id UUID NOT NULL REFERENCES loop_workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      active_plan_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_loops_workspace
      ON loops(workspace_id, updated_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS compiled_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      loop_id UUID NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES loop_workspaces(id) ON DELETE CASCADE,
      spec_revision INT NOT NULL,
      revision INT NOT NULL,
      content_hash TEXT NOT NULL,
      profile TEXT NOT NULL,
      plan_json JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      compiled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(loop_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_compiled_plans_loop_status
      ON compiled_plans(loop_id, status);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS loop_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      loop_id UUID NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL,
      compiled_plan_id UUID NOT NULL REFERENCES compiled_plans(id),
      temporal_workflow_id TEXT,
      temporal_run_id TEXT,
      trigger_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      error_json JSONB,
      result_json JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_loop_runs_loop
      ON loop_runs(loop_id, started_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS loop_run_steps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
      step_index INT NOT NULL,
      kind TEXT NOT NULL,
      tool_id TEXT,
      input_json JSONB,
      output_json JSONB,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_loop_run_steps_run
      ON loop_run_steps(run_id, step_index);
    ALTER TABLE loop_run_steps ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_run_steps_idempotency
      ON loop_run_steps(run_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
      loop_id UUID NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL,
      step_index INT NOT NULL,
      tool_id TEXT NOT NULL,
      proposed_action JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decision_json JSONB,
      idempotency_key TEXT,
      temporal_workflow_id TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace_status
      ON approval_requests(workspace_id, status, created_at DESC);
    ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_idempotency
      ON approval_requests(run_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS workspace_trigger_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES loop_workspaces(id) ON DELETE CASCADE,
      toolkit TEXT NOT NULL,
      connected_account_id TEXT NOT NULL,
      composio_trigger_slug TEXT NOT NULL,
      trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      config_hash TEXT NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      composio_instance_id TEXT,
      verified_at TIMESTAMPTZ,
      verification_error TEXT,
      ref_count INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, connected_account_id, composio_trigger_slug, config_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_trigger_channels_lookup
      ON workspace_trigger_channels(workspace_id, composio_trigger_slug, status);
    ALTER TABLE workspace_trigger_channels ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
    ALTER TABLE workspace_trigger_channels ADD COLUMN IF NOT EXISTS verification_error TEXT;
    ALTER TABLE workspace_trigger_channels ADD COLUMN IF NOT EXISTS trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE workspace_trigger_channels ADD COLUMN IF NOT EXISTS config_hash TEXT NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
  `);

  await migrateTriggerChannelsWorkspaceScope(client);

  await client.query(`
    CREATE TABLE IF NOT EXISTS loop_trigger_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      loop_id UUID NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES loop_workspaces(id) ON DELETE CASCADE,
      channel_id UUID NOT NULL REFERENCES workspace_trigger_channels(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (loop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_loop_trigger_subscriptions_channel
      ON loop_trigger_subscriptions(channel_id, status);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS webhook_event_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      external_event_id TEXT NOT NULL,
      loop_id UUID NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
      run_id UUID REFERENCES loop_runs(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'started',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (external_event_id, loop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_event_deliveries_event
      ON webhook_event_deliveries(external_event_id);
  `);

  await client.query(`
    ALTER TABLE loops
      ADD COLUMN IF NOT EXISTS active_plan_id UUID;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS loop_build_events (
      id UUID PRIMARY KEY,
      loop_id UUID NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
      thread_kind TEXT NOT NULL CHECK (thread_kind IN ('build', 'run')),
      run_id UUID REFERENCES loop_runs(id) ON DELETE CASCADE,
      sequence BIGINT NOT NULL,
      event_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      tool_call_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_build_events_sequence
      ON loop_build_events(loop_id, thread_kind, COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid), sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_build_events_key
      ON loop_build_events(loop_id, thread_kind, COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid), event_key);
    CREATE INDEX IF NOT EXISTS idx_loop_build_events_tool_call
      ON loop_build_events(loop_id, tool_call_id)
      WHERE tool_call_id IS NOT NULL;
  `);

  await client.query(`
    DROP TABLE IF EXISTS loop_chat_threads CASCADE;
    DROP TABLE IF EXISTS loop_conductor_chats CASCADE;
    DROP TABLE IF EXISTS loop_trigger_registrations CASCADE;
    DROP TABLE IF EXISTS loop_specs CASCADE;
    DROP TABLE IF EXISTS loop_specs_legacy CASCADE;
  `);

}

/** One channel per workspace + Composio connected account + trigger slug. */
export async function migrateTriggerChannelsWorkspaceScope(client: DbClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS uq_trigger_channels_tenant_user_account_slug`);
  await client.query(`DROP INDEX IF EXISTS idx_trigger_channels_tenant_user_slug`);
  await client.query(`DROP INDEX IF EXISTS uq_trigger_channels_workspace_account_slug`);
  await client.query(`ALTER TABLE workspace_trigger_channels DROP CONSTRAINT IF EXISTS workspace_trigger_channels_workspace_id_connected_account_id_composio_trigger_slug_key`);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_trigger_channels_workspace_account_slug_config
      ON workspace_trigger_channels(workspace_id, connected_account_id, composio_trigger_slug, config_hash);
  `);
}
