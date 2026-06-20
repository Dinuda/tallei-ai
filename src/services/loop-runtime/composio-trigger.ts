import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { selectedLoopTrigger } from "../loop-engine/build-contract.js";
import { getLoopWorkflow } from "../loop-executor/creator.js";
import { enqueueLoopRunCommand } from "./spec-run-commands.js";
import { resolveLoopRunAuth } from "./resolve-loop-run-auth.js";
import { createSpecLoopRun } from "./spec-runner.js";
import { startLoopRunWorkflow } from "../../temporal/start-loop-run.js";
import { gmailTriggerDedupeKey } from "./trigger-normalizers/gmail.js";

type WorkflowTriggerActivityView = {
  mode: "event" | "schedule" | "none";
  registration: {
    toolkit: string;
    triggerSlug: string;
    triggerInstanceId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  schedule: {
    cron: string;
    timezone: string;
    nextRunAt: string | null;
    lastScheduledAt: string | null;
  } | null;
  recentEvents: Array<{
    id: string;
    externalEventId: string;
    runId: string | null;
    receivedAt: string;
  }>;
};

export async function getWorkflowTriggerActivity(
  auth: AuthContext,
  workflowId: string,
): Promise<WorkflowTriggerActivityView> {
  const workflow = await getLoopWorkflow(auth, workflowId);
  if (!workflow) throw new Error("Loop workflow not found");

  const buildContract = workflow.runnableSpec?.buildContract
    ?? workflow.runnableSpec?.noSlopSpec?.buildContract
    ?? workflow.runnableSpec?.noSlopSpec?.specJson?.buildContract
    ?? null;
  const selected = buildContract ? selectedLoopTrigger(buildContract) : null;
  const mode = selected?.mode === "event" ? "event" : selected?.mode === "schedule" ? "schedule" : "none";

  const registrationResult = await pool.query<{
    toolkit: string;
    trigger_slug: string;
    trigger_instance_id: string;
    status: string;
    created_at: string | Date;
    updated_at: string | Date;
  }>(
    `SELECT toolkit, trigger_slug, trigger_instance_id, status, created_at, updated_at
     FROM workflow_connector_triggers
     WHERE workflow_id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId],
  );
  const registrationRow = registrationResult.rows[0];
  const registration = registrationRow ? {
    toolkit: registrationRow.toolkit,
    triggerSlug: registrationRow.trigger_slug,
    triggerInstanceId: registrationRow.trigger_instance_id,
    status: registrationRow.status,
    createdAt: registrationRow.created_at instanceof Date ? registrationRow.created_at.toISOString() : registrationRow.created_at,
    updatedAt: registrationRow.updated_at instanceof Date ? registrationRow.updated_at.toISOString() : registrationRow.updated_at,
  } : null;

  const eventsResult = registration
    ? await pool.query<{
        id: string;
        external_event_id: string;
        run_id: string | null;
        received_at: string | Date;
      }>(
        `SELECT id, external_event_id, run_id, received_at
         FROM workflow_connector_trigger_events
         WHERE trigger_instance_id = $1
         ORDER BY received_at DESC
         LIMIT 25`,
        [registration.triggerInstanceId],
      )
    : { rows: [] as Array<{ id: string; external_event_id: string; run_id: string | null; received_at: string | Date }> };

  const schedule = selected?.mode === "schedule" || workflow.nextRunAt != null
    ? {
        cron: selected?.mode === "schedule" ? selected.cron : workflow.scheduleRrule.replace(/^CRON:/i, ""),
        timezone: selected?.mode === "schedule" ? selected.timezone : "UTC",
        nextRunAt: workflow.nextRunAt,
        lastScheduledAt: workflow.lastScheduledAt,
      }
    : null;

  return {
    mode,
    registration,
    schedule,
    recentEvents: eventsResult.rows.map((row) => ({
      id: row.id,
      externalEventId: row.external_event_id,
      runId: row.run_id,
      receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
    })),
  };
}

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

function triggerDedupeKey(event: TriggerEnvelope): string | null {
  if (event.metadata.trigger_slug.includes("GMAIL")) {
    return gmailTriggerDedupeKey(event.data);
  }
  return null;
}

async function findReservedTriggerEvent(input: {
  triggerInstanceId: string;
  externalEventId: string;
  dedupeKey: string | null;
}): Promise<{ run_id: string | null } | null> {
  const result = await pool.query<{ run_id: string | null }>(
    `SELECT run_id
     FROM workflow_connector_trigger_events
     WHERE trigger_instance_id = $1
       AND (
         external_event_id = $2
         OR ($3::text IS NOT NULL AND dedupe_key = $3)
       )
     ORDER BY received_at ASC
     LIMIT 1`,
    [input.triggerInstanceId, input.externalEventId, input.dedupeKey],
  );
  return result.rows[0] ?? null;
}

export async function handleComposioTriggerWebhook(payload: unknown): Promise<{ ok: true; processed: boolean; runId?: string | null }> {
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

  const payloadJson = JSON.stringify({ data: event.data, metadata: event.metadata });
  const dedupeKey = triggerDedupeKey(event);

  const reserved = await pool.query(
    `INSERT INTO workflow_connector_trigger_events (trigger_instance_id, external_event_id, dedupe_key, payload_json)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT DO NOTHING`,
    [event.metadata.trigger_id, event.id, dedupeKey, payloadJson],
  );
  if (!reserved.rowCount) {
    const existing = await findReservedTriggerEvent({
      triggerInstanceId: event.metadata.trigger_id,
      externalEventId: event.id,
      dedupeKey,
    });
    return { ok: true, processed: true, runId: existing?.run_id ?? null };
  }

  const auth = await resolveLoopRunAuth({
    tenantId: target.tenant_id,
    userId: target.user_id,
    workflowId: target.workflow_id,
  });
  try {
    const triggerLabel = event.metadata.trigger_slug;
    const run = await createSpecLoopRun(auth, target.workflow_id, {
      source: "event",
      label: triggerLabel,
      eventId: event.id,
      triggerSlug: event.metadata.trigger_slug,
      triggerInstanceId: event.metadata.trigger_id,
    });
    await enqueueLoopRunCommand({
      auth,
      runId: run.id,
      commandType: "start_run",
      idempotencyKey: `spec-run:${run.id}:start`,
      payload: { trigger: run.triggerLabel ?? triggerLabel },
    });
    await startLoopRunWorkflow({
      tenantId: auth.tenantId,
      userId: auth.userId,
      workflowId: target.workflow_id,
      runId: run.id,
      trigger: {
        source: "event",
        label: triggerLabel,
        eventId: event.id,
        triggerSlug: event.metadata.trigger_slug,
        triggerInstanceId: event.metadata.trigger_id,
      },
    });
    const runId = run.id;
    if (runId) {
      await pool.query(
        `UPDATE workflow_connector_trigger_events SET run_id = $3 WHERE trigger_instance_id = $1 AND external_event_id = $2`,
        [event.metadata.trigger_id, event.id, runId],
      );
    }
    return { ok: true, processed: true, runId };
  } catch (error) {
    await pool.query(
      `DELETE FROM workflow_connector_trigger_events WHERE trigger_instance_id = $1 AND external_event_id = $2`,
      [event.metadata.trigger_id, event.id],
    );
    throw error;
  }
}
