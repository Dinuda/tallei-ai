import type pg from "pg";

type DbClient = pg.PoolClient;

const WORKSPACE_AND_LOOP_TABLES_REMOVED_FROM_DROP_LIST = true;

async function tableExists(client: DbClient, tableName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return Boolean(result.rows[0]?.exists);
}

async function tableHasColumn(client: DbClient, tableName: string, columnName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [tableName, columnName],
  );
  return Boolean(result.rows[0]?.exists);
}

/** Legacy conductor used loop_specs (tenant_id, slug, version). Loop engine uses loop_id + revision. */
export async function migrateLegacyLoopSpecsTable(client: DbClient): Promise<void> {
  if (!(await tableExists(client, "loop_specs"))) return;

  const hasLoopId = await tableHasColumn(client, "loop_specs", "loop_id");
  const hasRevision = await tableHasColumn(client, "loop_specs", "revision");
  const hasTenantId = await tableHasColumn(client, "loop_specs", "tenant_id");

  if (hasLoopId && hasRevision) return;

  if (hasTenantId && !hasLoopId) {
    if (!(await tableExists(client, "loop_specs_legacy"))) {
      await client.query(`ALTER TABLE loop_specs RENAME TO loop_specs_legacy`);
      return;
    }
    // Both legacy and a partial new table exist — keep legacy, drop conflicting shell.
    await client.query(`DROP TABLE loop_specs`);
  }
}

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

  await migrateLegacyLoopSpecsTable(client);

  await client.query(`
    CREATE TABLE IF NOT EXISTS loop_specs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      loop_id UUID NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
      revision INT NOT NULL,
      spec_json JSONB NOT NULL,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(loop_id, revision)
    );
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
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_loop_run_steps_run
      ON loop_run_steps(run_id, step_index);
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
      temporal_workflow_id TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace_status
      ON approval_requests(workspace_id, status, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS workspace_trigger_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES loop_workspaces(id) ON DELETE CASCADE,
      toolkit TEXT NOT NULL,
      connected_account_id TEXT NOT NULL,
      composio_trigger_slug TEXT NOT NULL,
      composio_instance_id TEXT,
      ref_count INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (workspace_id, connected_account_id, composio_trigger_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_trigger_channels_lookup
      ON workspace_trigger_channels(workspace_id, composio_trigger_slug, status);
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
    CREATE TABLE IF NOT EXISTS loop_trigger_registrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      loop_id UUID NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES loop_workspaces(id) ON DELETE CASCADE,
      toolkit TEXT NOT NULL,
      event_type TEXT NOT NULL,
      composio_trigger_slug TEXT NOT NULL,
      composio_instance_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (loop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_loop_trigger_registrations_workspace
      ON loop_trigger_registrations(workspace_id, status);
  `);

  await client.query(`
    ALTER TABLE loops
      ADD COLUMN IF NOT EXISTS active_plan_id UUID;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS loop_chat_threads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      loop_id UUID NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES loop_workspaces(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL,
      user_id UUID NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('build', 'run')),
      run_id UUID REFERENCES loop_runs(id) ON DELETE CASCADE,
      spec_revision INT,
      compiled_plan_id UUID REFERENCES compiled_plans(id) ON DELETE SET NULL,
      messages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_chat_build
      ON loop_chat_threads(loop_id, tenant_id, user_id)
      WHERE kind = 'build' AND run_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_chat_run
      ON loop_chat_threads(run_id)
      WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_loop_chat_threads_loop_kind
      ON loop_chat_threads(loop_id, kind, updated_at DESC);
  `);

  await migrateLoopConductorChatsToThreads(client);

  await migrateLoopTriggerRegistrationsToChannels(client);
}

/** One channel per workspace + Composio connected account + trigger slug. */
export async function migrateTriggerChannelsWorkspaceScope(client: DbClient): Promise<void> {
  if (!(await tableExists(client, "workspace_trigger_channels"))) return;

  await client.query(`DROP INDEX IF EXISTS uq_trigger_channels_tenant_user_account_slug`);
  await client.query(`DROP INDEX IF EXISTS idx_trigger_channels_tenant_user_slug`);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_trigger_channels_workspace_account_slug
      ON workspace_trigger_channels(workspace_id, connected_account_id, composio_trigger_slug);
  `);
}

/** @deprecated Renamed to migrateTriggerChannelsWorkspaceScope */
export const migrateTriggerChannelsCrossWorkspace = migrateTriggerChannelsWorkspaceScope;

export async function migrateLoopConductorChatsToThreads(client: DbClient): Promise<void> {
  if (!(await tableExists(client, "loop_conductor_chats"))) return;
  if (!(await tableExists(client, "loop_chat_threads"))) return;

  await client.query(`
    INSERT INTO loop_chat_threads (
      loop_id, workspace_id, tenant_id, user_id, kind, messages_json, updated_at
    )
    SELECT c.loop_id, c.workspace_id, c.tenant_id, c.user_id, 'build', c.messages_json, c.updated_at
    FROM loop_conductor_chats c
    WHERE NOT EXISTS (
      SELECT 1 FROM loop_chat_threads t
      WHERE t.loop_id = c.loop_id
        AND t.tenant_id = c.tenant_id
        AND t.user_id = c.user_id
        AND t.kind = 'build'
        AND t.run_id IS NULL
    )
  `);

  await client.query(`DROP TABLE IF EXISTS loop_conductor_chats`);
}

/**
 * One-time data migration: legacy per-loop Composio instances → shared channels + subscriptions.
 * Re-activate still preferred when connected_account_id was never stored on legacy rows.
 */
export async function migrateLoopTriggerRegistrationsToChannels(client: DbClient): Promise<void> {
  if (!(await tableExists(client, "loop_trigger_registrations"))) return;

  const legacy = await client.query<{
    loop_id: string;
    workspace_id: string;
    toolkit: string;
    composio_trigger_slug: string;
    composio_instance_id: string | null;
    status: string;
  }>(
    `SELECT loop_id, workspace_id, toolkit, composio_trigger_slug, composio_instance_id, status
     FROM loop_trigger_registrations
     WHERE status = 'active'`,
  );
  if (!legacy.rows.length) return;

  for (const row of legacy.rows) {
    const existingSub = await client.query(
      `SELECT 1 FROM loop_trigger_subscriptions WHERE loop_id = $1 LIMIT 1`,
      [row.loop_id],
    );
    if (existingSub.rows.length > 0) continue;

    const slug = row.composio_trigger_slug.toUpperCase();
    let channelId: string | null = null;

    if (row.composio_instance_id) {
      const byInstance = await client.query<{ id: string }>(
        `SELECT id FROM workspace_trigger_channels
         WHERE composio_instance_id = $1
         LIMIT 1`,
        [row.composio_instance_id],
      );
      channelId = byInstance.rows[0]?.id ?? null;
    }

    if (!channelId) {
      const connectedAccountId = `legacy:${row.workspace_id}:${slug}`;
      const bySlug = await client.query<{ id: string }>(
        `SELECT id FROM workspace_trigger_channels
         WHERE workspace_id = $1
           AND composio_trigger_slug = $2
           AND connected_account_id LIKE 'legacy:%'
         LIMIT 1`,
        [row.workspace_id, slug],
      );
      channelId = bySlug.rows[0]?.id ?? null;

      if (!channelId) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO workspace_trigger_channels (
             workspace_id, toolkit, connected_account_id, composio_trigger_slug,
             composio_instance_id, ref_count, status
           ) VALUES ($1, $2, $3, $4, $5, 0, 'active')
           ON CONFLICT (workspace_id, connected_account_id, composio_trigger_slug) DO UPDATE
             SET composio_instance_id = COALESCE(workspace_trigger_channels.composio_instance_id, EXCLUDED.composio_instance_id),
                 updated_at = NOW()
           RETURNING id`,
          [row.workspace_id, row.toolkit, connectedAccountId, slug, row.composio_instance_id],
        );
        channelId = inserted.rows[0]?.id ?? null;
      }
    }

    if (!channelId) continue;

    await client.query(
      `INSERT INTO loop_trigger_subscriptions (loop_id, workspace_id, channel_id, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (loop_id) DO NOTHING`,
      [row.loop_id, row.workspace_id, channelId],
    );

    await client.query(
      `UPDATE workspace_trigger_channels
       SET ref_count = (
         SELECT COUNT(*)::int
         FROM loop_trigger_subscriptions
         WHERE channel_id = $1 AND status = 'active'
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [channelId],
    );
  }
}
