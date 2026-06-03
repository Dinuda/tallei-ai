/**
 * gates.ts — Dynamic plan gate management (approval_gate, input_gate).
 *
 * Gates pause the run at `waiting_for_gate` until the operator approves, rejects, or submits input.
 */

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { consumeWorkflowApprovalToken, resolveWorkflowApprovalToken } from "../approval-tokens.js";
import { isDynamicPlanDefinition, stageSeq } from "./plan.js";
import { assertRunAccess, loadRunContext, mergeLoopExecutorMeta } from "./run-context.js";
import { advanceDynamicRunAfterSeq, scheduleNextDynamicExecutable } from "./run-plan-flow.js";
import { insertEvent, insertOrUpdateArtifact } from "./run-store.js";
import { markRunBlocked } from "./run-status.js";
import { parseContactListCsv } from "./presets/newsletter.js";

async function completeDynamicGate(input: {
  auth: AuthContext;
  runId: string;
  gateId: string;
  status: "approved" | "rejected" | "submitted";
  decision: Record<string, unknown>;
}) {
  await assertRunAccess(input.auth, input.runId);
  const context = await loadRunContext(input.runId);
  if (!isDynamicPlanDefinition(context.definition)) {
    throw new Error("Run does not use dynamic gates");
  }
  const gateResult = await pool.query(
    `SELECT id, stage_id, kind, status, title FROM loop_run_gates
     WHERE id = $1 AND workflow_run_id = $2 AND tenant_id = $3 AND user_id = $4 LIMIT 1`,
    [input.gateId, input.runId, input.auth.tenantId, input.auth.userId]
  );
  const gate = gateResult.rows[0];
  if (!gate) throw new Error("Loop gate not found");
  if (gate.status !== "pending") throw new Error(`Gate is ${gate.status}, not pending`);

  const seq = stageSeq(context.definition.plan!, gate.stage_id);
  if (seq < 0) throw new Error(`Gate stage ${gate.stage_id} not found in plan`);

  if (input.status === "rejected") {
    await pool.query(
      `UPDATE loop_run_gates SET status = 'rejected', decision_json = $5::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND workflow_run_id = $2 AND tenant_id = $3 AND user_id = $4`,
      [gate.id, input.runId, input.auth.tenantId, input.auth.userId, JSON.stringify(input.decision)]
    );
    await markRunBlocked(input.runId, `Gate rejected: ${gate.title}`, null);
    return { runId: input.runId, status: "blocked", gateId: gate.id };
  }

  await pool.query(
    `UPDATE loop_run_gates SET status = $5, decision_json = $6::jsonb, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND workflow_run_id = $2 AND tenant_id = $3 AND user_id = $4`,
    [gate.id, input.runId, input.auth.tenantId, input.auth.userId, input.status, JSON.stringify(input.decision)]
  );
  await pool.query(
    `UPDATE workflow_runs SET status = 'running',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      input.runId,
      input.auth.tenantId,
      input.auth.userId,
      JSON.stringify({
        loop_executor: mergeLoopExecutorMeta(context.metadataJson, {
          activeGateId: null,
          activeGateStageId: null,
          gateCompletedAt: new Date().toISOString(),
        }).loop_executor,
      }),
    ]
  );
  await insertEvent({
    context,
    eventType: "gate_completed",
    payload: { gateId: gate.id, stageId: gate.stage_id, status: input.status },
  });
  const freshContext = await loadRunContext(input.runId);
  const next = await scheduleNextDynamicExecutable({ context: freshContext, afterSeq: seq });
  return { runId: input.runId, status: next.status, gateId: gate.id };
}

export async function listLoopRunGates(auth: AuthContext, runId: string) {
  await assertRunAccess(auth, runId);
  const result = await pool.query(
    `SELECT id, stage_id, kind, status, title, artifact_id, payload_json, decision_json, created_at, completed_at, updated_at
     FROM loop_run_gates WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3 ORDER BY created_at ASC`,
    [runId, auth.tenantId, auth.userId]
  );
  return result.rows.map((gate) => ({
    id: gate.id,
    stageId: gate.stage_id,
    kind: gate.kind,
    status: gate.status,
    title: gate.title,
    artifactId: gate.artifact_id,
    payload: gate.payload_json,
    decision: gate.decision_json,
    createdAt: gate.created_at,
    completedAt: gate.completed_at,
    updatedAt: gate.updated_at,
  }));
}

export async function approveLoopRunGate(input: { auth: AuthContext; runId: string; gateId: string }) {
  return completeDynamicGate({
    auth: input.auth,
    runId: input.runId,
    gateId: input.gateId,
    status: "approved",
    decision: { approvedAt: new Date().toISOString(), channel: "ui" },
  });
}

export async function approveLoopRunGateApprovalToken(token: string) {
  const resolved = await resolveWorkflowApprovalToken(token);
  if (!resolved) throw new Error("Approval token not found");
  if (resolved.expired) throw new Error("Approval token expired");
  if (resolved.consumedAt) throw new Error("Approval token already used");
  if (resolved.targetType !== "workflow_gate") throw new Error("Invalid gate approval target");

  const gateResult = await pool.query(
    `SELECT g.workflow_run_id, r.workflow_id FROM loop_run_gates g
     JOIN workflow_runs r ON r.id = g.workflow_run_id
     WHERE g.id = $1 AND g.tenant_id = $2 AND g.user_id = $3 LIMIT 1`,
    [resolved.targetId, resolved.tenantId, resolved.userId]
  );
  const gate = gateResult.rows[0];
  if (!gate) throw new Error("Loop gate not found");

  const result = await completeDynamicGate({
    auth: { tenantId: resolved.tenantId, userId: resolved.userId, authMode: "internal", plan: "pro" },
    runId: gate.workflow_run_id,
    gateId: resolved.targetId,
    status: "approved",
    decision: { approvedAt: new Date().toISOString(), channel: resolved.channel || "email" },
  });
  await consumeWorkflowApprovalToken(token);
  return { runId: gate.workflow_run_id, workflowId: gate.workflow_id, status: result.status, gateId: resolved.targetId };
}

export async function rejectLoopRunGate(input: { auth: AuthContext; runId: string; gateId: string; reason?: string }) {
  return completeDynamicGate({
    auth: input.auth,
    runId: input.runId,
    gateId: input.gateId,
    status: "rejected",
    decision: { rejectedAt: new Date().toISOString(), channel: "ui", reason: input.reason ?? null },
  });
}

export async function submitLoopRunGateInput(input: {
  auth: AuthContext;
  runId: string;
  gateId: string;
  value: string;
}) {
  await assertRunAccess(input.auth, input.runId);
  const context = await loadRunContext(input.runId);
  if (!isDynamicPlanDefinition(context.definition)) throw new Error("Run does not use dynamic gates");

  const gateResult = await pool.query(
    `SELECT id, stage_id, kind, status FROM loop_run_gates
     WHERE id = $1 AND workflow_run_id = $2 AND tenant_id = $3 AND user_id = $4 LIMIT 1`,
    [input.gateId, input.runId, input.auth.tenantId, input.auth.userId]
  );
  const gate = gateResult.rows[0];
  if (!gate) throw new Error("Loop gate not found");
  if (gate.kind !== "input") throw new Error("Gate is not an input gate");
  if (gate.status !== "pending") throw new Error(`Gate is ${gate.status}, not pending`);

  const seq = stageSeq(context.definition.plan!, gate.stage_id);
  const stage = context.definition.plan!.stages[seq];
  if (!stage || stage.kind !== "input_gate") throw new Error(`Input stage ${gate.stage_id} not found in plan`);

  const schemaKind = typeof stage.inputSchema.kind === "string" ? stage.inputSchema.kind : "text";
  let body = input.value;
  let data: Record<string, unknown> = { value: input.value };
  let recipientCount: number | undefined;
  if (schemaKind === "csv") {
    const contacts = parseContactListCsv(input.value);
    body = `Uploaded ${contacts.length} recipients.`;
    data = { contacts, recipientCount: contacts.length };
    recipientCount = contacts.length;
  }
  await insertOrUpdateArtifact({ context, stage, artifactId: stage.outputArtifactId, body, data });
  const result = await completeDynamicGate({
    auth: input.auth,
    runId: input.runId,
    gateId: input.gateId,
    status: "submitted",
    decision: { submittedAt: new Date().toISOString(), channel: "ui", artifactId: stage.outputArtifactId },
  });
  return { ...result, artifactId: stage.outputArtifactId, ...(recipientCount !== undefined ? { recipientCount } : {}) };
}

export { advanceDynamicRunAfterSeq };
