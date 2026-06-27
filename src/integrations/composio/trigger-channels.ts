import { randomUUID } from "crypto";

import { pool } from "../../infrastructure/db/index.js";
import { getComposioClient, isComposioConfigured, toObjectRecord } from "./client.js";

export type WorkspaceTriggerChannelRow = {
  id: string;
  workspace_id: string;
  toolkit: string;
  connected_account_id: string;
  composio_trigger_slug: string;
  composio_instance_id: string | null;
  ref_count: number;
  status: string;
};

export type LoopTriggerSubscriptionRow = {
  id: string;
  loop_id: string;
  workspace_id: string;
  channel_id: string;
  status: string;
};

async function upsertComposioTriggerInstance(input: {
  triggerSlug: string;
  connectedAccountId: string;
}): Promise<string> {
  const composio = getComposioClient() as unknown as {
    client?: {
      triggerInstances?: {
        upsert?: (slug: string, body: Record<string, unknown>) => Promise<unknown>;
        delete?: (id: string) => Promise<unknown>;
      };
    };
  };
  const response = toObjectRecord(
    await composio.client?.triggerInstances?.upsert?.(input.triggerSlug, {
      connected_account_id: input.connectedAccountId,
      toolkit_versions: "latest",
      trigger_config: {},
    }),
  );
  const triggerId = String(
    response.trigger_id ?? toObjectRecord(response.deprecated).uuid ?? "",
  ).trim();
  if (!triggerId) throw new Error("Composio did not return a trigger ID");
  return triggerId;
}

async function deleteComposioTriggerInstance(instanceId: string): Promise<void> {
  const composio = getComposioClient() as unknown as {
    client?: {
      triggerInstances?: {
        delete?: (id: string) => Promise<unknown>;
      };
    };
  };
  try {
    await composio.client?.triggerInstances?.delete?.(instanceId);
  } catch (error) {
    console.warn(`[integrations/composio] failed to delete trigger instance ${instanceId}:`, error);
  }
}

export async function getWorkspaceTriggerChannel(
  workspaceId: string,
  connectedAccountId: string,
  composioTriggerSlug: string,
): Promise<WorkspaceTriggerChannelRow | null> {
  const result = await pool.query<WorkspaceTriggerChannelRow>(
    `SELECT id, workspace_id, toolkit, connected_account_id, composio_trigger_slug,
            composio_instance_id, ref_count, status
     FROM workspace_trigger_channels
     WHERE workspace_id = $1
       AND connected_account_id = $2
       AND composio_trigger_slug = $3
     LIMIT 1`,
    [workspaceId, connectedAccountId, composioTriggerSlug.toUpperCase()],
  );
  return result.rows[0] ?? null;
}

export async function ensureWorkspaceTriggerChannel(input: {
  workspaceId: string;
  toolkit: string;
  connectedAccountId: string;
  composioTriggerSlug: string;
}): Promise<WorkspaceTriggerChannelRow> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }

  const slug = input.composioTriggerSlug.toUpperCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<WorkspaceTriggerChannelRow>(
      `SELECT id, workspace_id, toolkit, connected_account_id, composio_trigger_slug,
              composio_instance_id, ref_count, status
       FROM workspace_trigger_channels
       WHERE workspace_id = $1
         AND connected_account_id = $2
         AND composio_trigger_slug = $3
       FOR UPDATE`,
      [input.workspaceId, input.connectedAccountId, slug],
    );
    const row = existing.rows[0];
    if (row) {
      const updated = await client.query<WorkspaceTriggerChannelRow>(
        `UPDATE workspace_trigger_channels
         SET ref_count = ref_count + 1,
             status = 'active',
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, workspace_id, toolkit, connected_account_id, composio_trigger_slug,
                   composio_instance_id, ref_count, status`,
        [row.id],
      );
      await client.query("COMMIT");
      return updated.rows[0]!;
    }

    const composioInstanceId = await upsertComposioTriggerInstance({
      triggerSlug: slug,
      connectedAccountId: input.connectedAccountId,
    });
    const id = randomUUID();
    const inserted = await client.query<WorkspaceTriggerChannelRow>(
      `INSERT INTO workspace_trigger_channels (
         id, workspace_id, toolkit, connected_account_id, composio_trigger_slug,
         composio_instance_id, ref_count, status
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'active')
       RETURNING id, workspace_id, toolkit, connected_account_id, composio_trigger_slug,
                 composio_instance_id, ref_count, status`,
      [id, input.workspaceId, input.toolkit, input.connectedAccountId, slug, composioInstanceId],
    );
    await client.query("COMMIT");
    return inserted.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseWorkspaceTriggerChannel(channelId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<WorkspaceTriggerChannelRow>(
      `SELECT id, composio_instance_id, ref_count
       FROM workspace_trigger_channels
       WHERE id = $1
       FOR UPDATE`,
      [channelId],
    );
    const row = existing.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return;
    }
    const nextRef = Math.max(0, row.ref_count - 1);
    if (nextRef === 0) {
      if (row.composio_instance_id) {
        await deleteComposioTriggerInstance(row.composio_instance_id);
      }
      await client.query(
        `UPDATE workspace_trigger_channels
         SET ref_count = 0,
             composio_instance_id = NULL,
             status = 'inactive',
             updated_at = NOW()
         WHERE id = $1`,
        [channelId],
      );
    } else {
      await client.query(
        `UPDATE workspace_trigger_channels
         SET ref_count = $2, updated_at = NOW()
         WHERE id = $1`,
        [channelId, nextRef],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getLoopTriggerSubscription(
  loopId: string,
): Promise<LoopTriggerSubscriptionRow | null> {
  const result = await pool.query<LoopTriggerSubscriptionRow>(
    `SELECT id, loop_id, workspace_id, channel_id, status
     FROM loop_trigger_subscriptions
     WHERE loop_id = $1
     LIMIT 1`,
    [loopId],
  );
  return result.rows[0] ?? null;
}

export async function upsertLoopTriggerSubscription(input: {
  loopId: string;
  workspaceId: string;
  channelId: string;
}): Promise<LoopTriggerSubscriptionRow> {
  const id = randomUUID();
  const result = await pool.query<LoopTriggerSubscriptionRow>(
    `INSERT INTO loop_trigger_subscriptions (id, loop_id, workspace_id, channel_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (loop_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       channel_id = EXCLUDED.channel_id,
       status = 'active',
       updated_at = NOW()
     RETURNING id, loop_id, workspace_id, channel_id, status`,
    [id, input.loopId, input.workspaceId, input.channelId],
  );
  return result.rows[0]!;
}

export async function deactivateLoopTriggerSubscription(loopId: string): Promise<string | null> {
  const existing = await getLoopTriggerSubscription(loopId);
  if (!existing) return null;
  await pool.query(
    `UPDATE loop_trigger_subscriptions
     SET status = 'inactive', updated_at = NOW()
     WHERE loop_id = $1`,
    [loopId],
  );
  return existing.channel_id;
}

export async function claimWebhookEventDelivery(input: {
  externalEventId: string;
  loopId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO webhook_event_deliveries (id, external_event_id, loop_id, status)
     VALUES ($1, $2, $3, 'started')
     ON CONFLICT (external_event_id, loop_id) DO NOTHING
     RETURNING id`,
    [randomUUID(), input.externalEventId, input.loopId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function attachWebhookEventDeliveryRun(input: {
  externalEventId: string;
  loopId: string;
  runId: string;
}): Promise<void> {
  await pool.query(
    `UPDATE webhook_event_deliveries
     SET run_id = $3
     WHERE external_event_id = $1
       AND loop_id = $2`,
    [input.externalEventId, input.loopId, input.runId],
  );
}
