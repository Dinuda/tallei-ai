import { createHash, randomUUID } from "crypto";
import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { deleteLoopSchedule } from "../../temporal/schedules.js";
import { isTemporalEnabled } from "../../temporal/client.js";
import { nextCronRunAt, normalizeDesignCron } from "./cron.js";
import { parseLoopDefinition } from "../loop-runtime/spec-run-types.js";
import {
  LOOP_DEFINITION_VERSION,
  loopDefinitionSchema,
  type LoopDefinition,
  type LoopWorkflowView,
} from "./types.js";
import { findBuilderSessionIdForWorkflow } from "../loop-runtime/spec-runner.js";

export async function requireLoopAdmin(_auth: AuthContext): Promise<void> {
}

function mapLoopWorkflowRow(row: {
  id: string;
  workspace_id: string | null;
  title: string;
  status: string;
  schedule_rrule: string;
  next_run_at: string | null;
  last_scheduled_at: string | null;
  metadata_json: unknown;
  definition_version: string;
  created_at: string;
  updated_at: string;
}): LoopWorkflowView {
  const metadata = row.metadata_json && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
    ? row.metadata_json as Record<string, unknown>
    : {};
  if (!["verifying", "active", "paused", "archived"].includes(row.status)) {
    throw new Error(`Unsupported workflow status: ${row.status}`);
  }

  const definition = parseLoopDefinition(metadata);
  if (!definition) throw new Error("Workflow is missing a loop definition.");

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status as LoopWorkflowView["status"],
    scheduleRrule: row.schedule_rrule,
    nextRunAt: row.next_run_at,
    lastScheduledAt: row.last_scheduled_at,
    goal: definition.goal,
    definition,
    definitionVersion: row.definition_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type LatestRunRow = {
  id: string;
  status: string;
  context_json: unknown;
  created_at: string;
  updated_at: string;
};

function parseLatestRunFromRow(row: LatestRunRow | undefined): LoopWorkflowView["latestRun"] {
  if (!row) return null;
  const context = row.context_json && typeof row.context_json === "object" && !Array.isArray(row.context_json)
    ? row.context_json as Record<string, unknown>
    : {};
  const trigger = context.trigger && typeof context.trigger === "object" && !Array.isArray(context.trigger)
    ? context.trigger as Record<string, unknown>
    : {};
  const source = trigger.source;
  const triggerSource = source === "schedule" || source === "event" ? source : "manual";
  return {
    id: row.id,
    status: row.status === "waiting_for_interaction" ? "waiting_for_approval" : row.status,
    triggerSource,
    triggerLabel: typeof trigger.label === "string" ? trigger.label : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function attachWorkflowRunMeta(auth: AuthContext, workflow: LoopWorkflowView): Promise<LoopWorkflowView> {
  const [latestRunResult, builderSessionId] = await Promise.all([
    pool.query<LatestRunRow>(
      `SELECT id, status, context_json, created_at, updated_at
       FROM loop_engine_runs
       WHERE workflow_id = $1 AND tenant_id = $2 AND user_id = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [workflow.id, auth.tenantId, auth.userId],
    ),
    findBuilderSessionIdForWorkflow(auth, workflow.id),
  ]);
  return {
    ...workflow,
    latestRun: parseLatestRunFromRow(latestRunResult.rows[0]),
    builderSessionId,
  };
}

export async function createLoopFromDefinition(input: {
  auth: AuthContext;
  definition: LoopDefinition;
  title?: string;
  workspaceId?: string | null;
  initialStatus?: "active" | "verifying";
  provenance?: Record<string, unknown>;
}): Promise<LoopWorkflowView> {
  await requireLoopAdmin(input.auth);
  const parsed = loopDefinitionSchema.parse(input.definition);
  const workflowId = randomUUID();
  const title = input.title?.trim() || parsed.builderMeta?.noSlopSpec?.title || "Untitled loop";
  const cron = normalizeDesignCron(parsed.schedule.cron, parsed.goal);
  const fingerprint = createHash("sha256")
    .update(`${LOOP_DEFINITION_VERSION}:${parsed.goal}:${cron}:${title}`)
    .digest("hex")
    .slice(0, 24);
  const initialStatus = input.initialStatus ?? "verifying";
  const nextRunAt = initialStatus === "active" ? nextCronRunAt(cron).toISOString() : null;

  await pool.query(
    `INSERT INTO workflows
     (id, tenant_id, user_id, workspace_id, title, fingerprint, instruction, schedule_rrule, status, requires_connector, connector_provider, connector_scope_keys, metadata_json, definition_version, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, NULL, '[]'::jsonb, $10::jsonb, $11, $12::timestamptz)`,
    [
      workflowId,
      input.auth.tenantId,
      input.auth.userId,
      input.workspaceId ?? input.auth.workspaceId ?? null,
      title,
      fingerprint,
      parsed.goal,
      cron,
      initialStatus,
      JSON.stringify({
        loopDefinition: parsed,
        ...(input.provenance ? { provenance: input.provenance } : {}),
      }),
      LOOP_DEFINITION_VERSION,
      nextRunAt,
    ],
  );

  const created = await getLoopWorkflow(input.auth, workflowId);
  if (!created) throw new Error("Failed to create definition-driven loop workflow");
  return created;
}

export async function getLoopWorkflow(auth: AuthContext, workflowId: string): Promise<LoopWorkflowView | null> {
  await requireLoopAdmin(auth);
  const result = await pool.query<{
    id: string;
    title: string;
    workspace_id: string | null;
    status: string;
    schedule_rrule: string;
    next_run_at: string | null;
    last_scheduled_at: string | null;
    metadata_json: unknown;
    definition_version: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, workspace_id, title, status, schedule_rrule, next_run_at, last_scheduled_at, metadata_json, definition_version, created_at, updated_at
     FROM workflows
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND definition_version = $4
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION],
  );
  const row = result.rows[0];
  if (!row) return null;
  return attachWorkflowRunMeta(auth, mapLoopWorkflowRow(row));
}

export async function listLoopWorkflows(auth: AuthContext): Promise<LoopWorkflowView[]> {
  await requireLoopAdmin(auth);
  const workspaceId = auth.workspaceId;
  const result = await pool.query<{
    id: string;
    title: string;
    workspace_id: string | null;
    status: string;
    schedule_rrule: string;
    next_run_at: string | null;
    last_scheduled_at: string | null;
    metadata_json: unknown;
    definition_version: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, workspace_id, title, status, schedule_rrule, next_run_at, last_scheduled_at, metadata_json, definition_version, created_at, updated_at
     FROM workflows
     WHERE tenant_id = $1
       AND user_id = $2
       AND definition_version = $3
       AND status IN ('verifying', 'active')
       ${workspaceId ? "AND workspace_id = $4" : ""}
     ORDER BY updated_at DESC
     LIMIT 50`,
    workspaceId
      ? [auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION, workspaceId]
      : [auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION],
  );
  const workflows = result.rows.map(mapLoopWorkflowRow);
  return Promise.all(workflows.map((workflow) => attachWorkflowRunMeta(auth, workflow)));
}

export async function deleteLoopWorkflow(auth: AuthContext, workflowId: string): Promise<void> {
  await requireLoopAdmin(auth);
  const result = await pool.query(
    `UPDATE workflows
     SET status = 'archived', updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND definition_version = $4
       AND status IN ('verifying', 'active')
     RETURNING id`,
    [workflowId, auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION],
  );
  if (!result.rowCount) {
    throw new Error("Loop workflow not found");
  }
  if (isTemporalEnabled()) {
    await deleteLoopSchedule(auth.tenantId, workflowId);
  }
}
