/**
 * run-store.ts — Shared DB helpers for loop runs (comments, events, artifacts).
 */

import { randomUUID } from "crypto";
import { pool } from "../../infrastructure/db/index.js";
import { artifactDefinition, isDynamicPlanDefinition } from "./plan.js";
import type { LoopRunContext } from "./run-context.js";
import type { LoopStage } from "./types.js";

export function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function insertEvent(input: {
  context: LoopRunContext;
  taskId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO loop_run_events
     (id, tenant_id, user_id, workflow_run_id, task_id, event_type, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      randomUUID(),
      input.context.tenantId,
      input.context.userId,
      input.context.runId,
      input.taskId ?? null,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
    ]
  );
}

export async function insertComment(input: {
  context: LoopRunContext;
  taskId?: string | null;
  author: string;
  body: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO loop_run_comments
     (id, tenant_id, user_id, workflow_run_id, task_id, author, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      input.context.tenantId,
      input.context.userId,
      input.context.runId,
      input.taskId ?? null,
      input.author,
      input.body,
    ]
  );
}

export async function loadRunComments(context: LoopRunContext) {
  const result = await pool.query<{ id: string; task_id: string | null; author: string; body: string; created_at: string }>(
    `SELECT id, task_id, author, body, created_at
     FROM loop_run_comments
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY created_at ASC`,
    [context.runId, context.tenantId, context.userId]
  );
  return result.rows;
}

export async function insertOrUpdateArtifact(input: {
  context: LoopRunContext;
  stage: LoopStage;
  artifactId: string;
  body: string;
  data: Record<string, unknown>;
}): Promise<void> {
  if (!isDynamicPlanDefinition(input.context.definition)) return;
  const definition = artifactDefinition(input.context.definition.plan!, input.artifactId);
  await pool.query(
    `INSERT INTO loop_run_artifacts
     (id, tenant_id, user_id, workflow_run_id, stage_id, artifact_id, kind, label, body, data_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (tenant_id, user_id, workflow_run_id, artifact_id) DO UPDATE
       SET stage_id = EXCLUDED.stage_id,
           kind = EXCLUDED.kind,
           label = EXCLUDED.label,
           body = EXCLUDED.body,
           data_json = EXCLUDED.data_json,
           updated_at = NOW()`,
    [
      randomUUID(),
      input.context.tenantId,
      input.context.userId,
      input.context.runId,
      input.stage.id,
      input.artifactId,
      definition?.kind ?? "custom",
      definition?.label ?? input.artifactId,
      input.body,
      JSON.stringify(input.data),
    ]
  );
}

export async function loadRunArtifacts(context: LoopRunContext) {
  const result = await pool.query(
    `SELECT id, stage_id, artifact_id, kind, label, body, data_json, created_at, updated_at
     FROM loop_run_artifacts
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY created_at ASC`,
    [context.runId, context.tenantId, context.userId]
  );
  return result.rows;
}

export async function loadArtifact(context: LoopRunContext, artifactId: string) {
  const result = await pool.query(
    `SELECT id, stage_id, artifact_id, kind, label, body, data_json, created_at, updated_at
     FROM loop_run_artifacts
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND artifact_id = $4
     LIMIT 1`,
    [context.runId, context.tenantId, context.userId, artifactId]
  );
  return result.rows[0] ?? null;
}
