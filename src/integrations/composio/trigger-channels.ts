import { createHash, randomUUID } from "crypto";

import { pool } from "../../infrastructure/db/index.js";
import { getComposioClient, isComposioConfigured, toObjectRecord } from "./client.js";

export type WorkspaceTriggerChannelRow = {
  id: string;
  workspace_id: string;
  toolkit: string;
  connected_account_id: string;
  composio_trigger_slug: string;
  trigger_config: Record<string, unknown>;
  config_hash: string;
  composio_instance_id: string | null;
  verified_at: string | null;
  verification_error: string | null;
  ref_count: number;
  status: string;
};

export type TriggerVerificationFailure =
  | "api_failure"
  | "missing_instance"
  | "disabled_instance"
  | "account_mismatch"
  | "slug_mismatch";

export class ComposioTriggerVerificationError extends Error {
  constructor(
    readonly code: TriggerVerificationFailure,
    message: string,
  ) {
    super(message);
    this.name = "ComposioTriggerVerificationError";
  }
}

type RemoteTriggerInstance = {
  id: string;
  connectedAccountId: string;
  triggerName: string;
  disabledAt: string | null;
};

function canonicalConfig(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalConfig).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalConfig(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function triggerConfigHash(config: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalConfig(config)).digest("hex");
}

function readRemoteTriggerInstance(value: unknown): RemoteTriggerInstance | null {
  const row = toObjectRecord(value);
  const id = String(row.id ?? row.trigger_id ?? "").trim();
  if (!id) return null;
  return {
    id,
    connectedAccountId: String(row.connected_account_id ?? row.connectedAccountId ?? "").trim(),
    triggerName: String(row.trigger_slug ?? row.trigger_name ?? row.triggerName ?? "").trim().toUpperCase(),
    disabledAt: row.disabled_at || row.disabledAt ? String(row.disabled_at ?? row.disabledAt) : null,
  };
}

export async function verifyComposioTriggerInstance(input: {
  instanceId: string;
  triggerSlug: string;
  connectedAccountId: string;
  attempts?: number;
  listActive?: (query: Record<string, unknown>) => Promise<unknown>;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const composio = (input.listActive ? null : getComposioClient()) as unknown as {
    client?: { triggerInstances?: { listActive?: (query: Record<string, unknown>) => Promise<unknown> } };
  } | null;
  const sdkListActive = composio?.client?.triggerInstances?.listActive;
  const listActive = input.listActive ?? (sdkListActive
    ? (query: Record<string, unknown>) => sdkListActive.call(composio?.client?.triggerInstances, query)
    : undefined);
  if (!listActive) throw new ComposioTriggerVerificationError("api_failure", "Composio trigger listing is unavailable");
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = input.attempts ?? 3;
  let lastApiError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = toObjectRecord(await listActive({
        trigger_ids: [input.instanceId],
        show_disabled: true,
        limit: 10,
      }));
      const items = Array.isArray(response.items) ? response.items : [];
      const instance = items.map(readRemoteTriggerInstance).find((row) => row?.id === input.instanceId) ?? null;
      console.info("[integrations/composio] verifying trigger instance", {
        instanceId: input.instanceId,
        triggerSlug: input.triggerSlug,
        attempt,
        found: Boolean(instance),
      });
      if (instance) {
        if (instance.disabledAt) throw new ComposioTriggerVerificationError("disabled_instance", "Composio trigger instance is disabled");
        if (instance.connectedAccountId !== input.connectedAccountId) {
          throw new ComposioTriggerVerificationError("account_mismatch", "Composio trigger connected account does not match");
        }
        if (instance.triggerName !== input.triggerSlug.toUpperCase()) {
          throw new ComposioTriggerVerificationError("slug_mismatch", "Composio trigger slug does not match");
        }
        return;
      }
      lastApiError = undefined;
    } catch (error) {
      if (error instanceof ComposioTriggerVerificationError) throw error;
      lastApiError = error;
    }
    if (attempt < attempts) await wait(attempt * 250);
  }
  if (lastApiError) {
    throw new ComposioTriggerVerificationError(
      "api_failure",
      `Failed to verify Composio trigger: ${lastApiError instanceof Error ? lastApiError.message : String(lastApiError)}`,
    );
  }
  throw new ComposioTriggerVerificationError("missing_instance", "Composio trigger instance was not found after provisioning");
}

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
  config: Record<string, unknown>;
}): Promise<string> {
  const composio = getComposioClient() as unknown as {
    client?: {
      triggerInstances?: {
        upsert?: (slug: string, body: Record<string, unknown>) => Promise<unknown>;
      };
    };
  };
  const response = toObjectRecord(
    await composio.client?.triggerInstances?.upsert?.(input.triggerSlug, {
      connected_account_id: input.connectedAccountId,
      toolkit_versions: "latest",
      trigger_config: input.config,
    }),
  );
  const triggerId = String(
    response.trigger_id ?? "",
  ).trim();
  if (!triggerId) throw new Error("Composio did not return a trigger ID");
  await verifyComposioTriggerInstance({
    instanceId: triggerId,
    triggerSlug: input.triggerSlug,
    connectedAccountId: input.connectedAccountId,
  });
  return triggerId;
}

async function deleteComposioTriggerInstance(instanceId: string): Promise<void> {
  const composio = getComposioClient() as unknown as {
    client?: {
      triggerInstances?: {
        manage?: { delete?: (id: string) => Promise<unknown> };
      };
    };
  };
  try {
    await composio.client?.triggerInstances?.manage?.delete?.(instanceId);
  } catch (error) {
    console.warn(`[integrations/composio] failed to delete trigger instance ${instanceId}:`, error);
  }
}

export async function getWorkspaceTriggerChannel(
  workspaceId: string,
  connectedAccountId: string,
  composioTriggerSlug: string,
  config: Record<string, unknown> = {},
): Promise<WorkspaceTriggerChannelRow | null> {
  const result = await pool.query<WorkspaceTriggerChannelRow>(
    `SELECT id, workspace_id, toolkit, connected_account_id, composio_trigger_slug, trigger_config, config_hash,
            composio_instance_id, verified_at, verification_error, ref_count, status
     FROM workspace_trigger_channels
     WHERE workspace_id = $1
       AND connected_account_id = $2
       AND composio_trigger_slug = $3
       AND config_hash = $4
     LIMIT 1`,
    [workspaceId, connectedAccountId, composioTriggerSlug.toUpperCase(), triggerConfigHash(config)],
  );
  return result.rows[0] ?? null;
}

export async function ensureWorkspaceTriggerChannel(input: {
  workspaceId: string;
  toolkit: string;
  connectedAccountId: string;
  composioTriggerSlug: string;
  config?: Record<string, unknown>;
}): Promise<WorkspaceTriggerChannelRow> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }

  const slug = input.composioTriggerSlug.toUpperCase();
  const config = input.config ?? {};
  const configHash = triggerConfigHash(config);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<WorkspaceTriggerChannelRow>(
      `SELECT id, workspace_id, toolkit, connected_account_id, composio_trigger_slug, trigger_config, config_hash,
              composio_instance_id, verified_at, verification_error, ref_count, status
       FROM workspace_trigger_channels
       WHERE workspace_id = $1
         AND connected_account_id = $2
         AND composio_trigger_slug = $3
         AND config_hash = $4
       FOR UPDATE`,
      [input.workspaceId, input.connectedAccountId, slug, configHash],
    );
    const row = existing.rows[0];
    if (row) {
      let composioInstanceId = row.composio_instance_id;
      let verified = false;
      if (composioInstanceId && row.status === "active" && row.verified_at) {
        try {
          await verifyComposioTriggerInstance({
            instanceId: composioInstanceId,
            triggerSlug: slug,
            connectedAccountId: input.connectedAccountId,
          });
          verified = true;
        } catch (error) {
          console.warn("[integrations/composio] existing trigger instance is stale", {
            instanceId: composioInstanceId,
            triggerSlug: slug,
            category: error instanceof ComposioTriggerVerificationError ? error.code : "api_failure",
          });
        }
      }
      if (!verified) {
        composioInstanceId = await upsertComposioTriggerInstance({
          triggerSlug: slug,
          connectedAccountId: input.connectedAccountId,
          config,
        });
      }
      const updated = await client.query<WorkspaceTriggerChannelRow>(
        `UPDATE workspace_trigger_channels
         SET ref_count = ref_count + 1,
             status = 'active',
             composio_instance_id = $2,
             verified_at = NOW(),
             verification_error = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, workspace_id, toolkit, connected_account_id, composio_trigger_slug, trigger_config, config_hash,
                   composio_instance_id, verified_at, verification_error, ref_count, status`,
        [row.id, composioInstanceId],
      );
      await client.query("COMMIT");
      return updated.rows[0]!;
    }

    const composioInstanceId = await upsertComposioTriggerInstance({
      triggerSlug: slug,
      connectedAccountId: input.connectedAccountId,
      config,
    });
    const id = randomUUID();
    const inserted = await client.query<WorkspaceTriggerChannelRow>(
      `INSERT INTO workspace_trigger_channels (
         id, workspace_id, toolkit, connected_account_id, composio_trigger_slug,
         trigger_config, config_hash, composio_instance_id, verified_at, verification_error, ref_count, status
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), NULL, 1, 'active')
       RETURNING id, workspace_id, toolkit, connected_account_id, composio_trigger_slug, trigger_config, config_hash,
                 composio_instance_id, verified_at, verification_error, ref_count, status`,
      [id, input.workspaceId, input.toolkit, input.connectedAccountId, slug, JSON.stringify(config), configHash, composioInstanceId],
    );
    await client.query("COMMIT");
    return inserted.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    const category = error instanceof ComposioTriggerVerificationError ? error.code : "api_failure";
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `INSERT INTO workspace_trigger_channels (
         id, workspace_id, toolkit, connected_account_id, composio_trigger_slug,
         trigger_config, config_hash, composio_instance_id, verified_at, verification_error, ref_count, status
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NULL, NULL, $8, 0, 'error')
       ON CONFLICT (workspace_id, connected_account_id, composio_trigger_slug, config_hash) DO UPDATE SET
         composio_instance_id = CASE WHEN workspace_trigger_channels.ref_count = 0 THEN NULL ELSE workspace_trigger_channels.composio_instance_id END,
         verified_at = CASE WHEN workspace_trigger_channels.ref_count = 0 THEN NULL ELSE workspace_trigger_channels.verified_at END,
         verification_error = CASE WHEN workspace_trigger_channels.ref_count = 0 THEN EXCLUDED.verification_error ELSE workspace_trigger_channels.verification_error END,
         status = CASE WHEN workspace_trigger_channels.ref_count = 0 THEN 'error' ELSE workspace_trigger_channels.status END,
         updated_at = NOW()`,
      [randomUUID(), input.workspaceId, input.toolkit, input.connectedAccountId, slug, JSON.stringify(config), configHash, `${category}:${message}`],
    );
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
      `SELECT id, composio_instance_id, verified_at, verification_error, ref_count, status
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
      if (row.composio_instance_id && row.verified_at) {
        await deleteComposioTriggerInstance(row.composio_instance_id);
      }
      await client.query(
        `UPDATE workspace_trigger_channels
         SET ref_count = 0,
             composio_instance_id = NULL,
             verified_at = NULL,
             verification_error = NULL,
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
