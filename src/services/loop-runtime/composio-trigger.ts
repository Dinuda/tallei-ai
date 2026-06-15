import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { startWebhookLoopRun } from "./runtime.js";

type TriggerEnvelope = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  metadata: {
    trigger_id: string;
    trigger_slug: string;
  };
};

function parseTriggerEnvelope(payload: unknown): TriggerEnvelope | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const event = payload as Record<string, unknown>;
  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? event.metadata as Record<string, unknown>
    : null;
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : null;
  if (!metadata || !data) return null;
  const id = typeof event.id === "string" ? event.id : null;
  const type = typeof event.type === "string" ? event.type : null;
  const triggerId = typeof metadata.trigger_id === "string" ? metadata.trigger_id : null;
  const triggerSlug = typeof metadata.trigger_slug === "string" ? metadata.trigger_slug : null;
  if (!id || !type || !triggerId || !triggerSlug || !type.includes("trigger")) return null;
  return { id, type, data, metadata: { trigger_id: triggerId, trigger_slug: triggerSlug } };
}

export async function handleComposioTriggerWebhook(payload: unknown): Promise<{ ok: true; processed: boolean }> {
  const event = parseTriggerEnvelope(payload);
  if (!event) return { ok: true, processed: false };

  const mapping = await pool.query<{ workflow_id: string; tenant_id: string; user_id: string }>(
    `SELECT workflow_id, tenant_id, user_id
     FROM workflow_connector_triggers
     WHERE trigger_instance_id = $1 AND trigger_slug = $2 AND status = 'active'
     LIMIT 1`,
    [event.metadata.trigger_id, event.metadata.trigger_slug],
  );
  const target = mapping.rows[0];
  if (!target) return { ok: true, processed: false };

  const reserved = await pool.query(
    `INSERT INTO workflow_connector_trigger_events (trigger_instance_id, external_event_id)
     VALUES ($1, $2)
     ON CONFLICT (trigger_instance_id, external_event_id) DO NOTHING`,
    [event.metadata.trigger_id, event.id],
  );
  if (!reserved.rowCount) return { ok: true, processed: true };

  const auth: AuthContext = {
    tenantId: target.tenant_id,
    userId: target.user_id,
    authMode: "internal",
    plan: "pro",
    scopes: ["loop:run"],
  };
  try {
    const projection = await startWebhookLoopRun(auth, target.workflow_id, {
      id: event.id,
      type: event.type,
      triggerSlug: event.metadata.trigger_slug,
      data: event.data,
    });
    const runId = projection && typeof projection === "object" && "run" in projection
      ? String((projection as { run?: { id?: unknown } }).run?.id ?? "")
      : "";
    if (runId) {
      await pool.query(
        `UPDATE workflow_connector_trigger_events SET run_id = $3 WHERE trigger_instance_id = $1 AND external_event_id = $2`,
        [event.metadata.trigger_id, event.id, runId],
      );
    }
    return { ok: true, processed: true };
  } catch (error) {
    await pool.query(
      `DELETE FROM workflow_connector_trigger_events WHERE trigger_instance_id = $1 AND external_event_id = $2`,
      [event.metadata.trigger_id, event.id],
    );
    throw error;
  }
}
