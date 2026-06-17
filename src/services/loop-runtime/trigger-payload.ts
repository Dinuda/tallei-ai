import { pool } from "../../infrastructure/db/index.js";

export type StoredTriggerPayload = {
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  triggerSlug: string;
  triggerInstanceId: string;
  externalEventId: string;
};

export async function storeTriggerEventPayload(input: {
  triggerInstanceId: string;
  externalEventId: string;
  payload: { data: Record<string, unknown>; metadata: Record<string, unknown> };
}): Promise<void> {
  await pool.query(
    `UPDATE workflow_connector_trigger_events
     SET payload_json = $3::jsonb
     WHERE trigger_instance_id = $1 AND external_event_id = $2`,
    [
      input.triggerInstanceId,
      input.externalEventId,
      JSON.stringify(input.payload),
    ],
  );
}

export async function loadTriggerPayloadForRun(input: {
  triggerInstanceId?: string;
  externalEventId?: string;
  runId?: string;
}): Promise<StoredTriggerPayload | null> {
  if (input.runId) {
    const byRun = await pool.query<{
      trigger_instance_id: string;
      external_event_id: string;
      payload_json: unknown;
    }>(
      `SELECT trigger_instance_id, external_event_id, payload_json
       FROM workflow_connector_trigger_events
       WHERE run_id = $1
       LIMIT 1`,
      [input.runId],
    );
    const row = byRun.rows[0];
    if (row?.payload_json && typeof row.payload_json === "object" && !Array.isArray(row.payload_json)) {
      return parseStoredPayload(row.trigger_instance_id, row.external_event_id, row.payload_json as Record<string, unknown>);
    }
  }

  if (!input.triggerInstanceId || !input.externalEventId) return null;

  const result = await pool.query<{
    trigger_instance_id: string;
    external_event_id: string;
    payload_json: unknown;
  }>(
    `SELECT trigger_instance_id, external_event_id, payload_json
     FROM workflow_connector_trigger_events
     WHERE trigger_instance_id = $1 AND external_event_id = $2
     LIMIT 1`,
    [input.triggerInstanceId, input.externalEventId],
  );
  const row = result.rows[0];
  if (!row?.payload_json || typeof row.payload_json !== "object" || Array.isArray(row.payload_json)) {
    return null;
  }
  return parseStoredPayload(row.trigger_instance_id, row.external_event_id, row.payload_json as Record<string, unknown>);
}

function parseStoredPayload(
  triggerInstanceId: string,
  externalEventId: string,
  raw: Record<string, unknown>,
): StoredTriggerPayload | null {
  const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
    ? raw.data as Record<string, unknown>
    : null;
  const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? raw.metadata as Record<string, unknown>
    : null;
  if (!data || !metadata) return null;
  const triggerSlug = typeof metadata.trigger_slug === "string"
    ? metadata.trigger_slug
    : typeof raw.triggerSlug === "string"
      ? raw.triggerSlug
      : "";
  return {
    data,
    metadata,
    triggerSlug,
    triggerInstanceId,
    externalEventId,
  };
}
