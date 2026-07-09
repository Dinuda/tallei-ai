import { createHash, randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import type { CompiledPlan, LoopSpec } from "./spec.js";
import { compiledPlanSchema } from "./spec.js";
import {
  projectLoopSpec,
  buildCommandResult,
  commitBuildArtifact,
  createBuildState,
  recoverBuildState,
  loopBuildStateSchema,
  type BuildPhase,
  type LoopBuildState,
} from "./build-state.js";
import {
  appendLoopBuildEventsWithClient,
  eventsFromUiMessages,
  getLatestArtifactEvent,
  listAuthorizedBuildEvents,
  listAuthorizedRunEvents,
  projectChatMessages,
  type LoopBuildEvent,
  type NewLoopBuildEvent,
} from "./build-events.js";
import {
  projectBuildStateFromEvents,
  projectLoopBuild,
  type LoopBuildProjection,
  type LoopBuildProjectionContext,
} from "./build-state-projection.js";

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
  idempotency_key: string | null;
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
  idempotency_key: string | null;
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
): Promise<{ loop: ReturnType<typeof mapLoop>; buildState: LoopBuildState }> {
  const loopId = randomUUID();
  const { seedSpecFromTemplate } = await import("./patch.js");
  const seeded = seedSpecFromTemplate(input.workspaceId, input.templateId ?? "");
  const prompt = input.prompt?.trim() || seeded.intent.goal || input.name.trim();
  const initial = commitBuildArtifact({
    state: createBuildState(),
    phase: "intent",
    artifact: {
      workspaceId: input.workspaceId,
      intent: input.templateId ? seeded.intent : { goal: prompt, outcome: prompt, successCriteria: [] },
      startCondition: input.templateId
        ? (seeded.trigger.kind === "manual" ? "Started manually" : `Starts from ${seeded.trigger.kind}`)
        : "As described by the user",
      sourceHints: seeded.trigger.kind === "event"
        ? [{ channel: seeded.trigger.eventType || "event", userMentionedApp: seeded.trigger.source }]
        : [],
    },
  });
  const initialState = loopBuildStateSchema.parse({ ...initial.state, buildPhase: "intent" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<LoopRow>(
      `INSERT INTO loops (id, tenant_id, user_id, workspace_id, name, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')
       RETURNING *`,
      [loopId, auth.tenantId, auth.userId, input.workspaceId, input.name.trim()],
    );
    await appendLoopBuildEventsWithClient({
      client,
      loopId,
      events: [{
        eventKey: `artifact:${initial.envelope.id}`,
        type: "artifact.committed",
        payload: {
          phase: "intent",
          source: input.templateId ?? "manual",
          envelope: initial.envelope,
          invalidatedPhases: [],
          state: initialState,
        },
      }],
    });
    await client.query("COMMIT");
    return { loop: mapLoop(result.rows[0]), buildState: initialState };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  const projection = await getLoopBuildProjection(auth, loopId);
  return projection.spec;
}

export async function getLatestBuildState(auth: AuthContext, loopId: string): Promise<LoopBuildState | null> {
  const projection = await getLoopBuildProjection(auth, loopId);
  return projection.state;
}

export async function getLoopBuildProjection(
  auth: AuthContext,
  loopId: string,
  context: LoopBuildProjectionContext = {},
): Promise<LoopBuildProjection> {
  const events = await getBuildEvents(auth, loopId);
  return projectLoopBuild(events, context);
}

export function projectLoopBuildFromEvents(
  events: LoopBuildEvent[],
  context: LoopBuildProjectionContext = {},
): LoopBuildProjection {
  return projectLoopBuild(events, context);
}

export { projectBuildStateFromEvents };

export async function commitLoopBuildArtifact(input: {
  auth: AuthContext;
  loopId: string;
  phase: BuildPhase;
  artifact: unknown;
  expectedParentHash?: string;
  reason?: string;
  source?: string;
}): Promise<ReturnType<typeof buildCommandResult> & { state: LoopBuildState }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(`SELECT id FROM loops WHERE id = $1 AND tenant_id = $2 AND user_id = $3 FOR UPDATE`,
      [input.loopId, input.auth.tenantId, input.auth.userId]);
    if (!owner.rows[0]) throw new Error("Loop not found");
    const latest = await getLatestArtifactEvent(client, input.loopId);
    const state = latest?.payload.state ? loopBuildStateSchema.parse(latest.payload.state) : createBuildState();
    const committed = commitBuildArtifact({
      state, phase: input.phase, artifact: input.artifact,
      expectedParentHash: input.expectedParentHash, reason: input.reason,
    });
    if (state.artifacts[input.phase]?.id === committed.envelope.id) {
      await client.query("COMMIT");
      return { ...buildCommandResult(committed.state, committed.envelope, []), state: committed.state };
    }
    await appendLoopBuildEventsWithClient({
      client,
      loopId: input.loopId,
      events: [{
        eventKey: `artifact:${committed.envelope.id}`,
        type: "artifact.committed",
        payload: {
          phase: input.phase,
          source: input.source ?? input.phase,
          envelope: committed.envelope,
          invalidatedPhases: committed.invalidatedPhases,
          state: committed.state,
        },
      }],
    });
    await client.query(`UPDATE loops SET updated_at = NOW() WHERE id = $1`, [input.loopId]);
    await client.query("COMMIT");
    return { ...buildCommandResult(committed.state, committed.envelope, committed.invalidatedPhases), state: committed.state };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverLoopBuildPhase(input: {
  auth: AuthContext;
  loopId: string;
  phase: BuildPhase;
  reason: string;
  parentArtifactHash: string;
}): Promise<{ state: LoopBuildState; invalidatedPhases: BuildPhase[]; recovered: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      `SELECT id FROM loops WHERE id = $1 AND tenant_id = $2 AND user_id = $3 FOR UPDATE`,
      [input.loopId, input.auth.tenantId, input.auth.userId],
    );
    if (!owner.rows[0]) throw new Error("Loop not found");
    const latest = await getLatestArtifactEvent(client, input.loopId);
    if (!latest?.payload.state) throw new Error("Loop build state not found");
    const current = loopBuildStateSchema.parse(latest.payload.state);
    if (current.buildPhase === input.phase && !current.artifacts[input.phase]) {
      await client.query("COMMIT");
      return { state: current, invalidatedPhases: [], recovered: false };
    }
    const recovered = recoverBuildState({ state: current, phase: input.phase, reason: input.reason });
    const artifactRevision = current.artifacts[input.phase]?.artifactHash ?? input.parentArtifactHash;
    await appendLoopBuildEventsWithClient({
      client,
      loopId: input.loopId,
      events: [{
        eventKey: `phase-recovery:${input.phase}:${artifactRevision}:${createHash("sha256").update(input.reason).digest("hex")}`,
        type: "phase.recovery_requested",
        payload: {
          sourcePhase: current.buildPhase,
          recoveryPhase: input.phase,
          parentArtifactHash: input.parentArtifactHash,
          artifactRevision,
          reason: input.reason,
          invalidatedPhases: recovered.invalidatedPhases,
          continuation: "next_phase",
          state: recovered.state,
        },
      }],
    });
    await client.query(`UPDATE loops SET updated_at = NOW() WHERE id = $1`, [input.loopId]);
    await client.query("COMMIT");
    return { ...recovered, recovered: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getLatestSpecRevision(loopId: string): Promise<number> {
  const result = await pool.query<{ revision: string }>(
    `SELECT COALESCE(MAX(sequence), 0)::text AS revision
     FROM loop_build_events
     WHERE loop_id = $1 AND thread_kind = 'build' AND run_id IS NULL
       AND event_type = 'artifact.committed'
       AND payload->>'phase' IN ('intent', 'blueprint', 'connectors', 'bindings', 'review')`,
    [loopId],
  );
  return Number.parseInt(result.rows[0]?.revision ?? "0", 10);
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
    `WITH saved AS (
       INSERT INTO compiled_plans
       (id, loop_id, workspace_id, spec_revision, revision, content_hash, profile, plan_json, status, compiled_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10
       FROM loops owner
       WHERE owner.id = $2 AND owner.tenant_id = $11 AND owner.user_id = $12
       RETURNING loop_id
     )
     UPDATE loops
     SET updated_at = NOW()
     FROM saved
     WHERE loops.id = saved.loop_id AND loops.tenant_id = $11 AND loops.user_id = $12`,
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
      auth.tenantId,
      auth.userId,
    ]
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

export async function updateLoopName(
  auth: AuthContext,
  loopId: string,
  name: string,
): Promise<ReturnType<typeof mapLoop> | null> {
  const result = await pool.query<LoopRow>(
    `UPDATE loops SET name = $4, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     RETURNING *`,
    [loopId, auth.tenantId, auth.userId, name.trim()],
  );
  const row = result.rows[0];
  return row ? mapLoop(row) : null;
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
  idempotencyKey?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO loop_run_steps (id, run_id, step_index, kind, tool_id, input_json, output_json, status, idempotency_key, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, NOW())
     ON CONFLICT (run_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [
      randomUUID(),
      input.runId,
      input.stepIndex,
      input.kind,
      input.toolId ?? null,
      input.inputJson ? JSON.stringify(input.inputJson) : null,
      input.outputJson ? JSON.stringify(input.outputJson) : null,
      input.status,
      input.idempotencyKey ?? null,
    ]
  );
  const { stepToChatMessages } = await import("./loop-chat.js");
  await appendRunChatMessages(input.runId, stepToChatMessages(input));
}

export async function getRunStepByIdempotencyKey(
  runId: string,
  idempotencyKey: string,
): Promise<LoopRunStepRow | null> {
  const result = await pool.query<LoopRunStepRow>(
    `SELECT * FROM loop_run_steps WHERE run_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [runId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export async function claimRunStep(input: {
  runId: string;
  stepIndex: number;
  kind: string;
  toolId?: string;
  inputJson?: unknown;
  idempotencyKey: string;
}): Promise<{ claimed: boolean; step: LoopRunStepRow }> {
  const result = await pool.query<LoopRunStepRow>(
    `INSERT INTO loop_run_steps
       (id, run_id, step_index, kind, tool_id, input_json, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'running', $7)
     ON CONFLICT (run_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      randomUUID(), input.runId, input.stepIndex, input.kind, input.toolId ?? null,
      input.inputJson ? JSON.stringify(input.inputJson) : null, input.idempotencyKey,
    ],
  );
  if (result.rows[0]) return { claimed: true, step: result.rows[0] };
  const existing = await getRunStepByIdempotencyKey(input.runId, input.idempotencyKey);
  if (!existing) throw new Error("Idempotent run-step claim disappeared");
  return { claimed: false, step: existing };
}

export async function completeClaimedRunStep(input: {
  runId: string;
  idempotencyKey: string;
  outputJson: unknown;
  status: "completed" | "failed";
}): Promise<void> {
  await pool.query(
    `UPDATE loop_run_steps
     SET output_json = $3::jsonb, status = $4, finished_at = NOW()
     WHERE run_id = $1 AND idempotency_key = $2`,
    [input.runId, input.idempotencyKey, JSON.stringify(input.outputJson), input.status],
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
  idempotencyKey?: string;
}): Promise<ApprovalRequestRow> {
  const id = randomUUID();
  const result = await pool.query<ApprovalRequestRow>(
    `INSERT INTO approval_requests
       (id, run_id, loop_id, workspace_id, step_index, tool_id, proposed_action, temporal_workflow_id, expires_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamptz, $10)
     ON CONFLICT (run_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET proposed_action = EXCLUDED.proposed_action
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
      input.idempotencyKey ?? null,
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
  verifiedAt: string | null;
  verificationError: string | null;
} | null> {
  const result = await pool.query<{
    sub_status: string | null;
    composio_trigger_slug: string | null;
    channel_status: string | null;
    composio_instance_id: string | null;
    verified_at: string | null;
    verification_error: string | null;
  }>(
    `SELECT s.status AS sub_status,
            c.composio_trigger_slug,
            c.status AS channel_status,
            c.composio_instance_id,
            c.verified_at,
            c.verification_error
     FROM loops l
     LEFT JOIN loop_trigger_subscriptions s ON s.loop_id = l.id
     LEFT JOIN workspace_trigger_channels c ON c.id = s.channel_id
     WHERE l.id = $1
     LIMIT 1`,
    [loopId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const subscribed = row.sub_status === "active"
    && row.channel_status === "active"
    && Boolean(row.verified_at)
    && !row.verification_error;
  return {
    subscribed,
    subscriptionStatus: row.sub_status,
    composioTriggerSlug: row.composio_trigger_slug,
    channelStatus: row.channel_status,
    composioInstanceId: row.composio_instance_id,
    verifiedAt: row.verified_at,
    verificationError: row.verification_error,
  };
}

export async function getLoopBuildMeta(
  auth: AuthContext,
  loopId: string,
): Promise<import("./loop-chat.js").LoopBuildMeta> {
  const projection = await getLoopBuildProjection(auth, loopId);
  return buildLoopBuildMetaFromProjection(projection);
}

export function buildLoopBuildMetaFromProjection(
  projection: LoopBuildProjection,
): import("./loop-chat.js").LoopBuildMeta {
  const compileArtifact = projection.state?.artifacts.compile?.artifact as { compiledPlanId?: unknown } | undefined;
  return {
    compiledPlanId: typeof compileArtifact?.compiledPlanId === "string"
      ? compileArtifact.compiledPlanId
      : null,
  };
}

export async function getBuildChatMessages(
  auth: AuthContext,
  loopId: string,
): Promise<import("ai").UIMessage[]> {
  const projection = await getLoopBuildProjection(auth, loopId);
  return projection.chatMessages;
}

export async function getBuildEvents(auth: AuthContext, loopId: string) {
  return listAuthorizedBuildEvents(pool, {
    loopId,
    tenantId: auth.tenantId,
    userId: auth.userId,
  });
}

export async function appendBuildEvents(
  auth: AuthContext,
  loopId: string,
  events: NewLoopBuildEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      `SELECT id FROM loops WHERE id = $1 AND tenant_id = $2 AND user_id = $3 FOR UPDATE`,
      [loopId, auth.tenantId, auth.userId],
    );
    if (!owner.rows[0]) throw new Error("Loop not found");
    await appendLoopBuildEventsWithClient({ client, loopId, events });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function saveBuildChatMessages(
  auth: AuthContext,
  loopId: string,
  messages: import("ai").UIMessage[],
): Promise<import("ai").UIMessage[]> {
  const { prepareConductorChatMessagesForEventLog } = await import("./conductor-chat.js");
  const sanitized = prepareConductorChatMessagesForEventLog(messages);
  await appendBuildEvents(auth, loopId, eventsFromUiMessages(sanitized));
  return sanitized;
}

export async function getRunChatMessages(
  auth: AuthContext,
  loopId: string,
  runId: string,
): Promise<import("ai").UIMessage[]> {
  return projectChatMessages(await listAuthorizedRunEvents(pool, {
    loopId,
    runId,
    tenantId: auth.tenantId,
    userId: auth.userId,
  }));
}

async function appendRunEvents(loopId: string, runId: string, events: NewLoopBuildEvent[]): Promise<void> {
  if (events.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM loops WHERE id = $1 FOR UPDATE`, [loopId]);
    await appendLoopBuildEventsWithClient({ client, loopId, threadKind: "run", runId, events });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function appendRunChatMessages(
  runId: string,
  incoming: import("ai").UIMessage[],
): Promise<void> {
  if (!incoming.length) return;
  const run = await getLoopRunById(runId);
  if (!run) return;
  const { prepareConductorChatMessagesForEventLog } = await import("./conductor-chat.js");
  await appendRunEvents(
    run.loop_id,
    runId,
    eventsFromUiMessages(prepareConductorChatMessagesForEventLog(incoming)),
  );
}
