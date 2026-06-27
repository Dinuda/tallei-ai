import { createHash, randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import type { CompiledPlan, LoopSpec } from "./spec.js";
import { compiledPlanSchema, loopSpecSchema, parseStoredCompiledPlan, parseStoredLoopSpec } from "./spec.js";

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
  input: { workspaceId: string; name: string; templateId?: string; prompt?: string },
): Promise<{ loop: ReturnType<typeof mapLoop>; spec: LoopSpec }> {
  const loopId = randomUUID();
  const result = await pool.query<LoopRow>(
    `INSERT INTO loops (id, tenant_id, user_id, workspace_id, name, status)
     VALUES ($1, $2, $3, $4, $5, 'draft')
     RETURNING *`,
    [loopId, auth.tenantId, auth.userId, input.workspaceId, input.name.trim()]
  );
  const { applySpecPatch, seedSpecFromTemplate } = await import("./patch.js");
  let spec = seedSpecFromTemplate(input.workspaceId, input.templateId ?? "");
  const prompt = input.prompt?.trim();
  if (prompt && !input.templateId) {
    spec = applySpecPatch(spec, {
      intent: {
        goal: prompt,
        outcome: prompt,
      },
    });
  }
  const saved = await saveSpecDraft(auth, loopId, spec, input.templateId ?? "manual");
  return { loop: mapLoop(result.rows[0]), spec: saved };
}

export async function listLoops(auth: AuthContext, workspaceId: string) {
  const result = await pool.query<LoopRow>(
    `SELECT * FROM loops
     WHERE tenant_id = $1 AND user_id = $2 AND workspace_id = $3 AND status <> 'archived'
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
  return parseStoredLoopSpec(row.spec_json);
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
  await linkBuildChatThread({ auth, loopId, specRevision: revision });
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
  await linkBuildChatThread({
    auth,
    loopId,
    specRevision: parsed.specRevision,
    compiledPlanId: parsed.id,
  });
  return parsed;
}

export async function getCompiledPlan(planId: string): Promise<CompiledPlan | null> {
  const result = await pool.query<CompiledPlanRow>(
    `SELECT * FROM compiled_plans WHERE id = $1 LIMIT 1`,
    [planId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return parseStoredCompiledPlan(row.plan_json);
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
  skipChatThread?: boolean;
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
  const owner = await pool.query<{ tenant_id: string; user_id: string }>(
    `SELECT tenant_id, user_id FROM loops WHERE id = $1 LIMIT 1`,
    [input.loopId],
  );
  const row = owner.rows[0];
  if (row && !input.skipChatThread) {
    await ensureRunChatThread({
      loopId: input.loopId,
      runId: id,
      workspaceId: input.workspaceId,
      tenantId: row.tenant_id,
      userId: row.user_id,
      compiledPlanId: input.compiledPlanId,
    });
  }
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
  const { stepToChatMessages } = await import("./loop-chat.js");
  await appendRunChatMessages(input.runId, stepToChatMessages(input));
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

/** Latest completed smoke test for a compiled plan (survives across chat turns). */
export async function getLatestPassingTestRunForPlan(
  auth: AuthContext,
  loopId: string,
  compiledPlanId: string,
): Promise<{ runId: string } | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT r.id
     FROM loop_runs r
     INNER JOIN loops l ON l.id = r.loop_id
     WHERE r.loop_id = $1
       AND r.compiled_plan_id = $2
       AND r.trigger_kind = 'test'
       AND r.status = 'completed'
       AND COALESCE(r.result_json->>'testRun', 'false') = 'true'
       AND COALESCE(r.result_json->>'status', '') = 'passed'
       AND l.tenant_id = $3
       AND l.user_id = $4
     ORDER BY r.finished_at DESC NULLS LAST, r.started_at DESC
     LIMIT 1`,
    [loopId, compiledPlanId, auth.tenantId, auth.userId],
  );
  const row = result.rows[0];
  return row ? { runId: row.id } : null;
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

export type ComposioTriggerLoopMatch = {
  loopId: string;
  activePlanId: string;
  workspaceId: string;
  tenantId: string;
  userId: string;
};

export async function findActiveLoopsByComposioTriggerSlug(
  composioTriggerSlug: string,
  filters: { workspaceId?: string; connectedAccountId?: string } = {},
): Promise<ComposioTriggerLoopMatch[]> {
  const slug = composioTriggerSlug.toUpperCase();
  const conditions = [
    "l.status = 'active'",
    "l.active_plan_id IS NOT NULL",
    "s.status = 'active'",
    "c.status = 'active'",
    "c.composio_trigger_slug = $1",
  ];
  const params: unknown[] = [slug];

  if (filters.workspaceId) {
    params.push(filters.workspaceId);
    conditions.push(`l.workspace_id = $${params.length}`);
  }
  if (filters.connectedAccountId) {
    params.push(filters.connectedAccountId);
    conditions.push(`c.connected_account_id = $${params.length}`);
  }

  const result = await pool.query<{
    loop_id: string;
    active_plan_id: string;
    workspace_id: string;
    tenant_id: string;
    user_id: string;
  }>(
    `SELECT l.id AS loop_id, l.active_plan_id, l.workspace_id, l.tenant_id, l.user_id
     FROM loops l
     INNER JOIN loop_trigger_subscriptions s ON s.loop_id = l.id AND s.status = 'active'
     INNER JOIN workspace_trigger_channels c ON c.id = s.channel_id AND c.status = 'active'
     WHERE ${conditions.join(" AND ")}`,
    params,
  );
  return result.rows
    .filter((r) => r.active_plan_id)
    .map((r) => ({
      loopId: r.loop_id,
      activePlanId: r.active_plan_id!,
      workspaceId: r.workspace_id,
      tenantId: r.tenant_id,
      userId: r.user_id,
    }));
}

export async function countRunningEventRuns(workspaceId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM loop_runs
     WHERE workspace_id = $1
       AND trigger_kind = 'event'
       AND status = 'running'`,
    [workspaceId],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function getLoopEventTriggerStatus(
  loopId: string,
): Promise<{
  subscribed: boolean;
  subscriptionStatus: string | null;
  composioTriggerSlug: string | null;
  channelStatus: string | null;
  composioInstanceId: string | null;
} | null> {
  const result = await pool.query<{
    sub_status: string | null;
    composio_trigger_slug: string | null;
    channel_status: string | null;
    composio_instance_id: string | null;
  }>(
    `SELECT s.status AS sub_status,
            c.composio_trigger_slug,
            c.status AS channel_status,
            c.composio_instance_id
     FROM loops l
     LEFT JOIN loop_trigger_subscriptions s ON s.loop_id = l.id
     LEFT JOIN workspace_trigger_channels c ON c.id = s.channel_id
     WHERE l.id = $1
     LIMIT 1`,
    [loopId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const subscribed = row.sub_status === "active" && row.channel_status === "active";
  return {
    subscribed,
    subscriptionStatus: row.sub_status,
    composioTriggerSlug: row.composio_trigger_slug,
    channelStatus: row.channel_status,
    composioInstanceId: row.composio_instance_id,
  };
}

export async function getConductorChatMessages(
  auth: AuthContext,
  loopId: string,
): Promise<import("ai").UIMessage[]> {
  return getBuildChatMessages(auth, loopId);
}

export async function saveConductorChatMessages(
  auth: AuthContext,
  loopId: string,
  messages: import("ai").UIMessage[],
): Promise<import("ai").UIMessage[]> {
  return saveBuildChatMessages(auth, loopId, messages);
}

export async function getBuildChatThreadMeta(
  auth: AuthContext,
  loopId: string,
): Promise<import("./loop-chat.js").LoopChatThreadMeta | null> {
  const result = await pool.query<{ spec_revision: number | null; compiled_plan_id: string | null }>(
    `SELECT spec_revision, compiled_plan_id
     FROM loop_chat_threads
     WHERE loop_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND kind = 'build'
       AND run_id IS NULL
     LIMIT 1`,
    [loopId, auth.tenantId, auth.userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    specRevision: row.spec_revision,
    compiledPlanId: row.compiled_plan_id,
  };
}

export async function getBuildChatMessages(
  auth: AuthContext,
  loopId: string,
): Promise<import("ai").UIMessage[]> {
  const loop = await getLoop(auth, loopId);
  if (!loop) return [];
  const { parseStoredConductorChatMessages } = await import("./conductor-chat.js");
  const result = await pool.query<{ messages_json: unknown }>(
    `SELECT messages_json
     FROM loop_chat_threads
     WHERE loop_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND kind = 'build'
       AND run_id IS NULL
     LIMIT 1`,
    [loopId, auth.tenantId, auth.userId],
  );
  return parseStoredConductorChatMessages(result.rows[0]?.messages_json ?? []);
}

export async function saveBuildChatMessages(
  auth: AuthContext,
  loopId: string,
  messages: import("ai").UIMessage[],
): Promise<import("ai").UIMessage[]> {
  const loop = await getLoop(auth, loopId);
  if (!loop) throw new Error("Loop not found");
  const { sanitizeConductorChatMessages } = await import("./conductor-chat.js");
  const sanitized = sanitizeConductorChatMessages(messages);
  await pool.query(
    `INSERT INTO loop_chat_threads (
       loop_id, workspace_id, tenant_id, user_id, kind, messages_json, updated_at
     )
     SELECT $1, $2, $3, $4, 'build', $5::jsonb, NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM loop_chat_threads
       WHERE loop_id = $1
         AND tenant_id = $3
         AND user_id = $4
         AND kind = 'build'
         AND run_id IS NULL
     )`,
    [loopId, loop.workspaceId, auth.tenantId, auth.userId, JSON.stringify(sanitized)],
  );
  await pool.query(
    `UPDATE loop_chat_threads
     SET workspace_id = $2,
         messages_json = $3::jsonb,
         updated_at = NOW()
     WHERE loop_id = $1
       AND tenant_id = $4
       AND user_id = $5
       AND kind = 'build'
       AND run_id IS NULL`,
    [loopId, loop.workspaceId, JSON.stringify(sanitized), auth.tenantId, auth.userId],
  );
  return sanitized;
}

export async function linkBuildChatThread(input: {
  auth: AuthContext;
  loopId: string;
  specRevision?: number;
  compiledPlanId?: string;
}): Promise<void> {
  const loop = await getLoop(input.auth, input.loopId);
  if (!loop) return;
  await pool.query(
    `INSERT INTO loop_chat_threads (
       loop_id, workspace_id, tenant_id, user_id, kind, messages_json, spec_revision, compiled_plan_id, updated_at
     )
     SELECT $1, $2, $3, $4, 'build', '[]'::jsonb, $5, $6, NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM loop_chat_threads
       WHERE loop_id = $1
         AND tenant_id = $3
         AND user_id = $4
         AND kind = 'build'
         AND run_id IS NULL
     )`,
    [
      input.loopId,
      loop.workspaceId,
      input.auth.tenantId,
      input.auth.userId,
      input.specRevision ?? null,
      input.compiledPlanId ?? null,
    ],
  );
  await pool.query(
    `UPDATE loop_chat_threads
     SET spec_revision = COALESCE($4, spec_revision),
         compiled_plan_id = COALESCE($5, compiled_plan_id),
         updated_at = NOW()
     WHERE loop_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND kind = 'build'
       AND run_id IS NULL`,
    [
      input.loopId,
      input.auth.tenantId,
      input.auth.userId,
      input.specRevision ?? null,
      input.compiledPlanId ?? null,
    ],
  );
}

export async function ensureRunChatThread(input: {
  loopId: string;
  runId: string;
  workspaceId: string;
  tenantId: string;
  userId: string;
  compiledPlanId: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO loop_chat_threads (
       loop_id, workspace_id, tenant_id, user_id, kind, run_id, compiled_plan_id, messages_json, updated_at
     )
     SELECT $1, $2, $3, $4, 'run', $5, $6, '[]'::jsonb, NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM loop_chat_threads WHERE run_id = $5 AND kind = 'run'
     )`,
    [
      input.loopId,
      input.workspaceId,
      input.tenantId,
      input.userId,
      input.runId,
      input.compiledPlanId,
    ],
  );
}

export async function getRunChatMessages(
  auth: AuthContext,
  loopId: string,
  runId: string,
): Promise<import("ai").UIMessage[]> {
  const run = await getLoopRun(auth, loopId, runId);
  if (!run) return [];
  const { parseStoredConductorChatMessages } = await import("./conductor-chat.js");
  const result = await pool.query<{ messages_json: unknown }>(
    `SELECT messages_json
     FROM loop_chat_threads
     WHERE run_id = $1
       AND loop_id = $2
       AND tenant_id = $3
       AND user_id = $4
       AND kind = 'run'
     LIMIT 1`,
    [runId, loopId, auth.tenantId, auth.userId],
  );
  return parseStoredConductorChatMessages(result.rows[0]?.messages_json ?? []);
}

export async function appendRunChatMessages(
  runId: string,
  incoming: import("ai").UIMessage[],
): Promise<void> {
  if (!incoming.length) return;
  const run = await getLoopRunById(runId);
  if (!run) return;
  const loop = await pool.query<{ tenant_id: string; user_id: string }>(
    `SELECT tenant_id, user_id FROM loops WHERE id = $1 LIMIT 1`,
    [run.loop_id],
  );
  const owner = loop.rows[0];
  if (!owner) return;

  const { sanitizeConductorChatMessages, parseStoredConductorChatMessages } = await import("./conductor-chat.js");
  const { mergeChatMessages } = await import("./loop-chat.js");
  const existing = await pool.query<{ messages_json: unknown }>(
    `SELECT messages_json FROM loop_chat_threads WHERE run_id = $1 AND kind = 'run' LIMIT 1`,
    [runId],
  );
  const merged = mergeChatMessages(
    parseStoredConductorChatMessages(existing.rows[0]?.messages_json ?? []),
    sanitizeConductorChatMessages(incoming),
  );
  await ensureRunChatThread({
    loopId: run.loop_id,
    runId,
    workspaceId: run.workspace_id,
    tenantId: owner.tenant_id,
    userId: owner.user_id,
    compiledPlanId: run.compiled_plan_id,
  });
  await pool.query(
    `UPDATE loop_chat_threads
     SET messages_json = $2::jsonb, updated_at = NOW()
     WHERE run_id = $1 AND kind = 'run'`,
    [runId, JSON.stringify(merged)],
  );
}
