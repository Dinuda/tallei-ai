import { createHash, randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import type { CompiledPlan, LoopSpec } from "./spec.js";
import { compiledPlanSchema, loopSpecSchema } from "./spec.js";

export type LoopRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  status: string;
  active_plan_id: string | null;
  created_at: string;
  updated_at: string;
};

export type LoopSpecRow = {
  id: string;
  loop_id: string;
  revision: number;
  spec_json: unknown;
  source: string | null;
  created_at: string;
};

export type CompiledPlanRow = {
  id: string;
  loop_id: string;
  workspace_id: string;
  spec_revision: number;
  revision: number;
  content_hash: string;
  profile: string;
  plan_json: unknown;
  status: string;
  compiled_at: string;
};

export type LoopRunRow = {
  id: string;
  loop_id: string;
  workspace_id: string;
  compiled_plan_id: string;
  temporal_workflow_id: string | null;
  temporal_run_id: string | null;
  trigger_kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_json: unknown;
  result_json: unknown;
};

export type LoopRunStepRow = {
  id: string;
  run_id: string;
  step_index: number;
  kind: string;
  tool_id: string | null;
  input_json: unknown;
  output_json: unknown;
  status: string;
  started_at: string;
  finished_at: string | null;
};

export type ApprovalRequestRow = {
  id: string;
  run_id: string;
  loop_id: string;
  workspace_id: string;
  step_index: number;
  tool_id: string;
  proposed_action: unknown;
  status: string;
  decision_json: unknown;
  temporal_workflow_id: string | null;
  expires_at: string | null;
  created_at: string;
  resolved_at: string | null;
};

function mapLoop(row: LoopRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    activePlanId: row.active_plan_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createLoop(
  auth: AuthContext,
  input: { workspaceId: string; name: string; templateId?: string },
): Promise<{ loop: ReturnType<typeof mapLoop>; spec: LoopSpec }> {
  const loopId = randomUUID();
  const result = await pool.query<LoopRow>(
    `INSERT INTO loops (id, tenant_id, user_id, workspace_id, name, status)
     VALUES ($1, $2, $3, $4, $5, 'draft')
     RETURNING *`,
    [loopId, auth.tenantId, auth.userId, input.workspaceId, input.name.trim()]
  );
  const { seedSpecFromTemplate } = await import("./patch.js");
  const spec = seedSpecFromTemplate(input.workspaceId, input.templateId ?? "");
  const saved = await saveSpecDraft(auth, loopId, spec, input.templateId ?? "manual");
  return { loop: mapLoop(result.rows[0]), spec: saved };
}

export async function listLoops(auth: AuthContext, workspaceId: string) {
  const result = await pool.query<LoopRow>(
    `SELECT * FROM loops
     WHERE tenant_id = $1 AND user_id = $2 AND workspace_id = $3
     ORDER BY updated_at DESC`,
    [auth.tenantId, auth.userId, workspaceId]
  );
  return result.rows.map(mapLoop);
}

export async function getLoop(auth: AuthContext, loopId: string) {
  const result = await pool.query<LoopRow>(
    `SELECT * FROM loops
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [loopId, auth.tenantId, auth.userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return mapLoop(row);
}

export async function getLatestSpec(auth: AuthContext, loopId: string): Promise<LoopSpec | null> {
  const result = await pool.query<LoopSpecRow>(
    `SELECT * FROM loop_specs
     WHERE loop_id = $1
     ORDER BY revision DESC
     LIMIT 1`,
    [loopId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return loopSpecSchema.parse(row.spec_json);
}

export async function saveSpecDraft(
  auth: AuthContext,
  loopId: string,
  spec: LoopSpec,
  source = "chat",
): Promise<LoopSpec> {
  const parsed = loopSpecSchema.parse(spec);
  const revResult = await pool.query<{ next: number }>(
    `SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM loop_specs WHERE loop_id = $1`,
    [loopId]
  );
  const revision = revResult.rows[0]?.next ?? 1;
  await pool.query(
    `INSERT INTO loop_specs (id, loop_id, revision, spec_json, source)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [randomUUID(), loopId, revision, JSON.stringify(parsed), source]
  );
  await pool.query(
    `UPDATE loops SET updated_at = NOW() WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [loopId, auth.tenantId, auth.userId]
  );
  return parsed;
}

export async function getLatestSpecRevision(loopId: string): Promise<number> {
  const result = await pool.query<{ revision: number }>(
    `SELECT revision FROM loop_specs WHERE loop_id = $1 ORDER BY revision DESC LIMIT 1`,
    [loopId]
  );
  return result.rows[0]?.revision ?? 0;
}

export function hashPlan(plan: CompiledPlan): string {
  const canonical = JSON.stringify(plan, Object.keys(plan).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

export async function saveCompiledPlan(
  auth: AuthContext,
  loopId: string,
  plan: CompiledPlan,
): Promise<CompiledPlan> {
  const parsed = compiledPlanSchema.parse(plan);
  await pool.query(
    `INSERT INTO compiled_plans
       (id, loop_id, workspace_id, spec_revision, revision, content_hash, profile, plan_json, status, compiled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      parsed.id,
      loopId,
      parsed.workspaceId,
      parsed.specRevision,
      parsed.revision,
      parsed.contentHash,
      parsed.profile,
      JSON.stringify(parsed),
      parsed.status,
      parsed.compiledAt,
    ]
  );
  await pool.query(
    `UPDATE loops SET updated_at = NOW() WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [loopId, auth.tenantId, auth.userId]
  );
  return parsed;
}

export async function getCompiledPlan(planId: string): Promise<CompiledPlan | null> {
  const result = await pool.query<CompiledPlanRow>(
    `SELECT * FROM compiled_plans WHERE id = $1 LIMIT 1`,
    [planId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return compiledPlanSchema.parse(row.plan_json);
}

export async function getNextPlanRevision(loopId: string): Promise<number> {
  const result = await pool.query<{ next: number }>(
    `SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM compiled_plans WHERE loop_id = $1`,
    [loopId]
  );
  return result.rows[0]?.next ?? 1;
}

export async function activateCompiledPlan(
  auth: AuthContext,
  loopId: string,
  planId: string,
): Promise<void> {
  await pool.query(
    `UPDATE compiled_plans SET status = 'superseded'
     WHERE loop_id = $1 AND status = 'active' AND id <> $2`,
    [loopId, planId]
  );
  await pool.query(
    `UPDATE compiled_plans SET status = 'active' WHERE id = $1`,
    [planId]
  );
  await pool.query(
    `UPDATE loops
     SET status = 'active', active_plan_id = $4, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [loopId, auth.tenantId, auth.userId, planId]
  );
}

export async function setLoopStatus(
  auth: AuthContext,
  loopId: string,
  status: "draft" | "active" | "paused" | "archived",
): Promise<void> {
  await pool.query(
    `UPDATE loops SET status = $4, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [loopId, auth.tenantId, auth.userId, status]
  );
}

export async function moveLoopToWorkspace(
  auth: AuthContext,
  loopId: string,
  targetWorkspaceId: string,
): Promise<void> {
  await pool.query(
    `UPDATE loops
     SET workspace_id = $4,
         active_plan_id = NULL,
         status = 'draft',
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [loopId, auth.tenantId, auth.userId, targetWorkspaceId]
  );
}

export async function createLoopRun(input: {
  id?: string;
  loopId: string;
  workspaceId: string;
  compiledPlanId: string;
  triggerKind: string;
  temporalWorkflowId?: string;
  resultJson?: unknown;
}): Promise<LoopRunRow> {
  const id = input.id ?? randomUUID();
  const result = await pool.query<LoopRunRow>(
    `INSERT INTO loop_runs
       (id, loop_id, workspace_id, compiled_plan_id, trigger_kind, temporal_workflow_id, status, result_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb)
     RETURNING *`,
    [
      id,
      input.loopId,
      input.workspaceId,
      input.compiledPlanId,
      input.triggerKind,
      input.temporalWorkflowId ?? null,
      input.resultJson ? JSON.stringify(input.resultJson) : null,
    ]
  );
  return result.rows[0];
}

export async function updateLoopRun(
  runId: string,
  patch: Partial<{
    status: string;
    temporalWorkflowId: string;
    temporalRunId: string;
    finishedAt: string;
    errorJson: unknown;
    resultJson: unknown;
  }>,
): Promise<void> {
  await pool.query(
    `UPDATE loop_runs
     SET status = COALESCE($2, status),
         temporal_workflow_id = COALESCE($3, temporal_workflow_id),
         temporal_run_id = COALESCE($4, temporal_run_id),
         finished_at = COALESCE($5::timestamptz, finished_at),
         error_json = COALESCE($6::jsonb, error_json),
         result_json = COALESCE($7::jsonb, result_json)
     WHERE id = $1`,
    [
      runId,
      patch.status ?? null,
      patch.temporalWorkflowId ?? null,
      patch.temporalRunId ?? null,
      patch.finishedAt ?? null,
      patch.errorJson ? JSON.stringify(patch.errorJson) : null,
      patch.resultJson ? JSON.stringify(patch.resultJson) : null,
    ]
  );
}

export async function getLoopRunById(runId: string): Promise<LoopRunRow | null> {
  const result = await pool.query<LoopRunRow>(
    `SELECT * FROM loop_runs WHERE id = $1 LIMIT 1`,
    [runId],
  );
  return result.rows[0] ?? null;
}

export async function insertRunStep(input: {
  runId: string;
  stepIndex: number;
  kind: string;
  toolId?: string;
  inputJson?: unknown;
  outputJson?: unknown;
  status: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO loop_run_steps (id, run_id, step_index, kind, tool_id, input_json, output_json, status, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, NOW())`,
    [
      randomUUID(),
      input.runId,
      input.stepIndex,
      input.kind,
      input.toolId ?? null,
      input.inputJson ? JSON.stringify(input.inputJson) : null,
      input.outputJson ? JSON.stringify(input.outputJson) : null,
      input.status,
    ]
  );
}

export async function listLoopRuns(auth: AuthContext, loopId: string): Promise<LoopRunRow[]> {
  const result = await pool.query<LoopRunRow>(
    `SELECT r.* FROM loop_runs r
     INNER JOIN loops l ON l.id = r.loop_id
     WHERE r.loop_id = $1 AND l.tenant_id = $2 AND l.user_id = $3
     ORDER BY r.started_at DESC`,
    [loopId, auth.tenantId, auth.userId]
  );
  return result.rows;
}

export async function getLoopRun(
  auth: AuthContext,
  loopId: string,
  runId: string,
): Promise<LoopRunRow | null> {
  const result = await pool.query<LoopRunRow>(
    `SELECT r.* FROM loop_runs r
     INNER JOIN loops l ON l.id = r.loop_id
     WHERE r.id = $1 AND r.loop_id = $2 AND l.tenant_id = $3 AND l.user_id = $4
     LIMIT 1`,
    [runId, loopId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ?? null;
}

export async function listLoopRunSteps(
  auth: AuthContext,
  loopId: string,
  runId: string,
): Promise<LoopRunStepRow[]> {
  const result = await pool.query<LoopRunStepRow>(
    `SELECT s.* FROM loop_run_steps s
     INNER JOIN loop_runs r ON r.id = s.run_id
     INNER JOIN loops l ON l.id = r.loop_id
     WHERE s.run_id = $1 AND r.loop_id = $2 AND l.tenant_id = $3 AND l.user_id = $4
     ORDER BY s.step_index ASC`,
    [runId, loopId, auth.tenantId, auth.userId],
  );
  return result.rows;
}

export async function createApprovalRequest(input: {
  runId: string;
  loopId: string;
  workspaceId: string;
  stepIndex: number;
  toolId: string;
  proposedAction: unknown;
  temporalWorkflowId: string;
  expiresAt: string;
}): Promise<ApprovalRequestRow> {
  const id = randomUUID();
  const result = await pool.query<ApprovalRequestRow>(
    `INSERT INTO approval_requests
       (id, run_id, loop_id, workspace_id, step_index, tool_id, proposed_action, temporal_workflow_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamptz)
     RETURNING *`,
    [
      id,
      input.runId,
      input.loopId,
      input.workspaceId,
      input.stepIndex,
      input.toolId,
      JSON.stringify(input.proposedAction),
      input.temporalWorkflowId,
      input.expiresAt,
    ]
  );
  return result.rows[0];
}

export async function getApprovalRequest(id: string): Promise<ApprovalRequestRow | null> {
  const result = await pool.query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests WHERE id = $1 LIMIT 1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function listPendingApprovals(auth: AuthContext, workspaceId: string): Promise<ApprovalRequestRow[]> {
  const result = await pool.query<ApprovalRequestRow>(
    `SELECT a.* FROM approval_requests a
     INNER JOIN workspace_memberships m ON m.workspace_id = a.workspace_id AND m.user_id = $2
     WHERE a.workspace_id = $1 AND a.status = 'pending'
     ORDER BY a.created_at DESC`,
    [workspaceId, auth.userId]
  );
  return result.rows;
}

export async function getPendingApprovalForRun(
  auth: AuthContext,
  loopId: string,
  runId: string,
): Promise<ApprovalRequestRow | null> {
  const result = await pool.query<ApprovalRequestRow>(
    `SELECT a.* FROM approval_requests a
     INNER JOIN loop_runs r ON r.id = a.run_id
     INNER JOIN loops l ON l.id = r.loop_id
     WHERE a.run_id = $1 AND r.loop_id = $2 AND a.status = 'pending'
       AND l.tenant_id = $3 AND l.user_id = $4
     ORDER BY a.created_at DESC
     LIMIT 1`,
    [runId, loopId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ?? null;
}

export async function resolveApprovalRequest(
  id: string,
  status: string,
  decisionJson: unknown,
): Promise<ApprovalRequestRow | null> {
  const result = await pool.query<ApprovalRequestRow>(
    `UPDATE approval_requests
     SET status = $2, decision_json = $3::jsonb, resolved_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, status, JSON.stringify(decisionJson)]
  );
  return result.rows[0] ?? null;
}

export async function findActiveLoopsByEventTrigger(
  workspaceId: string,
  source: string,
  eventType: string,
): Promise<Array<{ loopId: string; activePlanId: string; workspaceId: string }>> {
  const result = await pool.query<{ loop_id: string; active_plan_id: string; workspace_id: string }>(
    `SELECT l.id AS loop_id, l.active_plan_id, l.workspace_id
     FROM loops l
     INNER JOIN compiled_plans p ON p.id = l.active_plan_id
     WHERE l.workspace_id = $1
       AND l.status = 'active'
       AND l.active_plan_id IS NOT NULL
       AND p.plan_json->'trigger'->>'kind' = 'event'
       AND p.plan_json->'trigger'->>'source' = $2
       AND p.plan_json->'trigger'->>'eventType' = $3`,
    [workspaceId, source, eventType]
  );
  return result.rows
    .filter((r) => r.active_plan_id)
    .map((r) => ({
      loopId: r.loop_id,
      activePlanId: r.active_plan_id!,
      workspaceId: r.workspace_id,
    }));
}

export async function findActiveLoopsByComposioTriggerSlug(
  workspaceId: string,
  composioTriggerSlug: string,
): Promise<Array<{ loopId: string; activePlanId: string; workspaceId: string }>> {
  const result = await pool.query<{ loop_id: string; active_plan_id: string; workspace_id: string }>(
    `SELECT l.id AS loop_id, l.active_plan_id, l.workspace_id
     FROM loops l
     INNER JOIN loop_trigger_registrations r ON r.loop_id = l.id
     WHERE l.workspace_id = $1
       AND l.status = 'active'
       AND l.active_plan_id IS NOT NULL
       AND r.status = 'active'
       AND r.composio_trigger_slug = $2`,
    [workspaceId, composioTriggerSlug],
  );
  return result.rows
    .filter((r) => r.active_plan_id)
    .map((r) => ({
      loopId: r.loop_id,
      activePlanId: r.active_plan_id!,
      workspaceId: r.workspace_id,
    }));
}
