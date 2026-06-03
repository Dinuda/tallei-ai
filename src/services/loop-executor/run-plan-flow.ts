/**
 * run-plan-flow.ts — Advance plan-driven runs (gates, next task, finalizer).
 */

import { randomUUID } from "crypto";
import { pool } from "../../infrastructure/db/index.js";
import { deliverApprovalPrompt, deliverStatusNotification, getPrimaryNotificationChannel } from "../channels.js";
import { createWorkflowApprovalRequest } from "../approval-tokens.js";
import { isDynamicPlanDefinition, stageSeq } from "./plan.js";
import { authFromContext, mergeLoopExecutorMeta, type LoopRunContext } from "./run-context.js";
import { scheduleHeartbeat } from "./run-heartbeat.js";
import { insertEvent, loadArtifact, readObject } from "./run-store.js";
import type { LoopStage } from "./types.js";

export async function scheduleNextDynamicExecutable(input: {
  context: LoopRunContext;
  afterSeq: number;
}): Promise<{ status: string; taskId: string | null }> {
  const plan = isDynamicPlanDefinition(input.context.definition) ? input.context.definition.plan : null;
  if (!plan) return { status: input.context.runStatus, taskId: null };

  const nextTask = await pool.query<{ id: string }>(
    `SELECT id FROM loop_run_tasks
     WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3
       AND status = 'todo' AND seq > $4
     ORDER BY seq ASC LIMIT 1`,
    [input.context.runId, input.context.tenantId, input.context.userId, input.afterSeq]
  );
  const task = nextTask.rows[0];
  if (task) {
    await scheduleHeartbeat({
      tenantId: input.context.tenantId,
      userId: input.context.userId,
      runId: input.context.runId,
      jobType: "agent",
      taskId: task.id,
    });
    return { status: "running", taskId: task.id };
  }
  await scheduleHeartbeat({
    tenantId: input.context.tenantId,
    userId: input.context.userId,
    runId: input.context.runId,
    jobType: "ceo_finalize",
  });
  return { status: "finalizing", taskId: null };
}

export async function pauseForDynamicGate(input: {
  context: LoopRunContext;
  stage: LoopStage;
  seq: number;
}): Promise<{ status: string; gateId: string }> {
  const payload: Record<string, unknown> = { seq: input.seq, stage: input.stage };
  const artifactId = input.stage.kind === "approval_gate" ? input.stage.artifactId : null;
  if (artifactId) {
    const artifact = await loadArtifact(input.context, artifactId);
    payload.artifact = artifact
      ? { id: artifact.artifact_id, kind: artifact.kind, label: artifact.label, body: artifact.body, data: artifact.data_json }
      : null;
  }
  const gateId = randomUUID();
  const kind = input.stage.kind === "approval_gate" ? "approval" : "input";
  await pool.query(
    `INSERT INTO loop_run_gates
     (id, tenant_id, user_id, workflow_run_id, stage_id, kind, status, title, artifact_id, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9::jsonb)
     ON CONFLICT (tenant_id, user_id, workflow_run_id, stage_id) DO UPDATE
       SET status = CASE WHEN loop_run_gates.status IN ('approved', 'submitted') THEN loop_run_gates.status ELSE 'pending' END,
           title = EXCLUDED.title, artifact_id = EXCLUDED.artifact_id, payload_json = EXCLUDED.payload_json, updated_at = NOW()
     RETURNING id`,
    [
      gateId,
      input.context.tenantId,
      input.context.userId,
      input.context.runId,
      input.stage.id,
      kind,
      input.stage.label,
      artifactId,
      JSON.stringify(payload),
    ]
  );
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM loop_run_gates WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3 AND stage_id = $4 LIMIT 1`,
    [input.context.runId, input.context.tenantId, input.context.userId, input.stage.id]
  );
  const resolvedGateId = existing.rows[0]?.id ?? gateId;
  const pendingInput = input.stage.kind === "input_gate"
    ? {
        id: input.stage.id,
        kind: typeof input.stage.inputSchema.kind === "string" ? input.stage.inputSchema.kind : "input",
        label: input.stage.label,
        status: "pending" as const,
        requestedAt: new Date().toISOString(),
        instructions: "Submit the requested input to continue this run.",
        schema: input.stage.inputSchema,
      }
    : undefined;
  const loopExecutorPatch = mergeLoopExecutorMeta(input.context.metadataJson, {
    activeGateId: resolvedGateId,
    activeGateStageId: input.stage.id,
    ...(pendingInput ? { pendingInput } : {}),
  });
  await pool.query(
    `UPDATE workflow_runs
     SET status = 'waiting_for_gate', waiting_for_strategy_approval = FALSE,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      input.context.runId,
      input.context.tenantId,
      input.context.userId,
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]
  );
  const notificationAuth = authFromContext(input.context);
  if (kind === "approval") {
    void (async () => {
      const channel = await getPrimaryNotificationChannel(notificationAuth);
      if (!channel) return;
      const approval = await createWorkflowApprovalRequest({
        auth: notificationAuth,
        targetType: "workflow_gate",
        targetId: resolvedGateId,
        channel: channel.kind,
      });
      await deliverApprovalPrompt({
        auth: notificationAuth,
        channel,
        targetType: "workflow_gate",
        targetId: resolvedGateId,
        approvalUrl: approval.url,
        approvalToken: approval.token,
        title: `${input.context.workflowTitle} is waiting for approval`,
        reason: input.stage.label,
        suggestedPrompt: "Reply APPROVE to approve or SKIP to skip.",
        draftOutput: (payload.artifact as { body?: string } | null)?.body ?? null,
      });
    })().catch(() => undefined);
  } else {
    await deliverStatusNotification({
      auth: notificationAuth,
      title: `${input.context.workflowTitle} needs input`,
      body: `${input.stage.label}. Submit the requested input in Tallei to continue.`,
      metadata: { workflowId: input.context.workflowId, runId: input.context.runId, gateId: resolvedGateId, status: "waiting_for_gate" },
    }).catch(() => undefined);
  }
  await insertEvent({
    context: input.context,
    eventType: "gate_waiting",
    payload: { gateId: resolvedGateId, stageId: input.stage.id, kind },
  });
  return { status: "waiting_for_gate", gateId: resolvedGateId };
}

export async function advanceDynamicRunAfterSeq(
  context: LoopRunContext,
  currentSeq: number
): Promise<{ status: string; taskId?: string }> {
  if (!isDynamicPlanDefinition(context.definition)) return { status: context.runStatus };
  for (let seq = currentSeq + 1; seq < context.definition.plan!.stages.length; seq += 1) {
    const stage = context.definition.plan!.stages[seq];
    if (stage.kind === "approval_gate" || stage.kind === "input_gate") {
      const paused = await pauseForDynamicGate({ context, stage, seq });
      return { status: paused.status };
    }
    if (stage.kind === "agent" || stage.kind === "external_action") {
      const next = await scheduleNextDynamicExecutable({ context, afterSeq: seq - 1 });
      return { status: next.status, ...(next.taskId ? { taskId: next.taskId } : {}) };
    }
  }
  const next = await scheduleNextDynamicExecutable({ context, afterSeq: currentSeq });
  return { status: next.status, ...(next.taskId ? { taskId: next.taskId } : {}) };
}
