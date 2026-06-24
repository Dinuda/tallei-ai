import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { getComposioClient, isComposioConfigured, toObjectRecord } from "./client.js";
import { resolveConnectedAccountId } from "./accounts.js";
import { normalizeToolkitSlug } from "./auth.js";
import { lookupStaticTriggerSlug, scoreTriggerSlugMatch } from "../../loops/trigger-catalog.js";
import { pool } from "../../infrastructure/db/index.js";

type ComposioTriggerTypeRow = {
  slug: string;
  name: string;
};

async function listComposioTriggerTypes(toolkit: string): Promise<ComposioTriggerTypeRow[]> {
  const composio = getComposioClient() as unknown as {
    client?: {
      triggersTypes?: {
        list?: (input: Record<string, unknown>) => Promise<unknown>;
      };
    };
  };
  const response = toObjectRecord(
    await composio.client?.triggersTypes?.list?.({
      toolkit_slugs: [toolkit],
      toolkit_versions: "latest",
      limit: 50,
    }),
  );
  const items = Array.isArray(response.items) ? response.items : [];
  return items.flatMap((item) => {
    const row = toObjectRecord(item);
    const slug = String(row.slug ?? "").trim();
    if (!slug) return [];
    return [{ slug, name: String(row.name ?? slug).trim() }];
  });
}

function pickAvailableSlug(
  candidate: string | null | undefined,
  available: ComposioTriggerTypeRow[],
): string | null {
  if (!candidate) return null;
  const upper = candidate.toUpperCase();
  const match = available.find((row) => row.slug.toUpperCase() === upper);
  return match?.slug ?? null;
}

export async function resolveTriggerSlugWithCatalog(
  toolkit: string,
  eventType: string,
): Promise<string> {
  const normalizedToolkit = normalizeToolkitSlug(toolkit);
  const available = await listComposioTriggerTypes(normalizedToolkit);

  const fromStatic = pickAvailableSlug(
    lookupStaticTriggerSlug(normalizedToolkit, eventType),
    available,
  );
  if (fromStatic) return fromStatic;

  const fromEventAsSlug = pickAvailableSlug(eventType.trim(), available);
  if (fromEventAsSlug) return fromEventAsSlug;

  let best: { slug: string; score: number } | null = null;
  for (const row of available) {
    const score = scoreTriggerSlugMatch(eventType, row.slug, row.name);
    if (!best || score > best.score) best = { slug: row.slug, score };
  }
  if (best && best.score >= 4) return best.slug;

  const fallbackStatic = lookupStaticTriggerSlug(normalizedToolkit, eventType);
  if (fallbackStatic && available.length === 0) return fallbackStatic;

  throw new Error(
    `No Composio trigger for ${normalizedToolkit}/${eventType}. ` +
      `Available: ${available.map((row) => row.slug).join(", ") || "none"}`,
  );
}

export type LoopTriggerRegistrationRow = {
  id: string;
  loop_id: string;
  workspace_id: string;
  toolkit: string;
  event_type: string;
  composio_trigger_slug: string;
  composio_instance_id: string | null;
  status: string;
};

export async function getLoopTriggerRegistration(loopId: string): Promise<LoopTriggerRegistrationRow | null> {
  const result = await pool.query<LoopTriggerRegistrationRow>(
    `SELECT id, loop_id, workspace_id, toolkit, event_type, composio_trigger_slug, composio_instance_id, status
     FROM loop_trigger_registrations
     WHERE loop_id = $1
     LIMIT 1`,
    [loopId],
  );
  return result.rows[0] ?? null;
}

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

export async function registerLoopEventTrigger(input: {
  auth: AuthContext;
  loopId: string;
  workspaceId: string;
  source: string;
  eventType: string;
}): Promise<LoopTriggerRegistrationRow> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }
  const toolkit = normalizeToolkitSlug(input.source);
  const composioTriggerSlug = await resolveTriggerSlugWithCatalog(toolkit, input.eventType);
  const connectedAccountId = await resolveConnectedAccountId(input.auth, toolkit);
  if (!connectedAccountId) {
    throw new Error(`Connect ${toolkit} before enabling its event trigger`);
  }

  const existing = await getLoopTriggerRegistration(input.loopId);
  if (existing?.composio_instance_id) {
    await deleteComposioTriggerInstance(existing.composio_instance_id);
  }

  const composioInstanceId = await upsertComposioTriggerInstance({
    triggerSlug: composioTriggerSlug,
    connectedAccountId,
  });

  const id = existing?.id ?? randomUUID();
  const result = await pool.query<LoopTriggerRegistrationRow>(
    `INSERT INTO loop_trigger_registrations (
       id, loop_id, workspace_id, toolkit, event_type, composio_trigger_slug, composio_instance_id, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
     ON CONFLICT (loop_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       toolkit = EXCLUDED.toolkit,
       event_type = EXCLUDED.event_type,
       composio_trigger_slug = EXCLUDED.composio_trigger_slug,
       composio_instance_id = EXCLUDED.composio_instance_id,
       status = 'active',
       updated_at = NOW()
     RETURNING id, loop_id, workspace_id, toolkit, event_type, composio_trigger_slug, composio_instance_id, status`,
    [
      id,
      input.loopId,
      input.workspaceId,
      toolkit,
      input.eventType,
      composioTriggerSlug,
      composioInstanceId,
    ],
  );
  return result.rows[0]!;
}

export async function unregisterLoopEventTrigger(loopId: string): Promise<void> {
  const existing = await getLoopTriggerRegistration(loopId);
  if (!existing) return;
  if (existing.composio_instance_id) {
    await deleteComposioTriggerInstance(existing.composio_instance_id);
  }
  await pool.query(
    `UPDATE loop_trigger_registrations
     SET status = 'inactive', composio_instance_id = NULL, updated_at = NOW()
     WHERE loop_id = $1`,
    [loopId],
  );
}
