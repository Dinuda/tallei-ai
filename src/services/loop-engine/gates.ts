/**
 * gates.ts — Human gates for the agentic loop engine (memory, missing input, draft, pre-send).
 */

import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { assertRunAccess, loadRunContext, mergeLoopExecutorMeta } from "../loop-executor/run-context.js";
import { scheduleHeartbeat } from "../loop-executor/run-heartbeat.js";
import { insertEvent, upsertEngineArtifact } from "../loop-executor/run-store.js";
import { releaseInProgressTasksExcept } from "../loop-executor/run-execution-guard.js";
import { markRunBlocked } from "../loop-executor/run-status.js";
import type { LoopGateType, LoopRunAgent } from "../loop-executor/types.js";
import type { LoopRunContext } from "../loop-executor/run-context.js";
import { isEngineV3Definition } from "./contracts.js";

export type EngineGatePayload = {
  gateType: LoopGateType;
  question: string;
  agentId: string;
  taskId: string;
  items?: Array<{ id: string; excerpt: string; include: boolean }>;
  fields?: Array<{ key: string; label: string; required: boolean }>;
  draft?: string;
  provider?: string;
  target?: string;
  recipients?: Array<{ email: string; name?: string }>;
};

function gateKindForType(gateType: LoopGateType): "approval" | "input" {
  return gateType === "missing_input" ? "input" : "approval";
}

export async function createEngineGate(input: {
  context: LoopRunContext;
  taskId: string;
  agent: LoopRunAgent;
  gateType: LoopGateType;
  question: string;
  payload: Omit<EngineGatePayload, "gateType" | "question" | "agentId" | "taskId">;
}): Promise<string> {
  const gateId = randomUUID();
  const payload: EngineGatePayload = {
    gateType: input.gateType,
    question: input.question,
    agentId: input.agent.id,
    taskId: input.taskId,
    ...input.payload,
  };

  await pool.query(
    `INSERT INTO loop_run_gates
     (id, tenant_id, user_id, workflow_run_id, stage_id, kind, status, title, artifact_id, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9::jsonb)`,
    [
      gateId,
      input.context.tenantId,
      input.context.userId,
      input.context.runId,
      input.agent.id,
      gateKindForType(input.gateType),
      input.question,
      input.agent.outputArtifactId ?? null,
      JSON.stringify(payload),
    ],
  );

  const loopExecutorPatch = mergeLoopExecutorMeta(input.context.metadataJson, {
    activeGateId: gateId,
    activeGateStageId: input.agent.id,
    pendingInput: input.gateType === "missing_input"
      ? {
          id: gateId,
          kind: "text",
          label: input.question,
          status: "pending",
          requestedAt: new Date().toISOString(),
          instructions: input.question,
        }
      : undefined,
  });

  await pool.query(
    `UPDATE workflow_runs
     SET status = 'waiting_for_gate',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      input.context.runId,
      input.context.tenantId,
      input.context.userId,
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ],
  );

  await releaseInProgressTasksExcept({
    runId: input.context.runId,
    tenantId: input.context.tenantId,
    userId: input.context.userId,
    exceptTaskId: input.taskId,
  });

  await insertEvent({
    context: input.context,
    taskId: input.taskId,
    eventType: "gate_waiting",
    payload: { gateId, gateType: input.gateType, agentId: input.agent.id },
  });

  return gateId;
}

async function loadNextTaskAfterSeq(context: LoopRunContext, currentSeq: number) {
  const result = await pool.query(
    `SELECT id FROM loop_run_tasks
     WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3 AND seq = $4
     LIMIT 1`,
    [context.runId, context.tenantId, context.userId, currentSeq + 1],
  );
  return result.rows[0]?.id ?? null;
}

export async function completeEngineGate(input: {
  auth: AuthContext;
  runId: string;
  gateId: string;
  status: "approved" | "rejected" | "submitted";
  decision: Record<string, unknown>;
}): Promise<{ runId: string; status: string; gateId: string }> {
  await assertRunAccess(input.auth, input.runId);
  const context = await loadRunContext(input.runId);
  if (!isEngineV3Definition(context.definition)) {
    throw new Error("Run does not use the agentic loop engine");
  }

  const gateResult = await pool.query(
    `SELECT id, stage_id, kind, status, title, artifact_id, payload_json
     FROM loop_run_gates
     WHERE id = $1 AND workflow_run_id = $2 AND tenant_id = $3 AND user_id = $4
     LIMIT 1`,
    [input.gateId, input.runId, input.auth.tenantId, input.auth.userId],
  );
  const gate = gateResult.rows[0];
  if (!gate) throw new Error("Loop gate not found");
  if (gate.status !== "pending") {
    throw new Error(`Gate is ${gate.status}, not pending`);
  }

  const payload = gate.payload_json && typeof gate.payload_json === "object"
    ? gate.payload_json as EngineGatePayload
    : null;

  if (input.status === "rejected") {
    await pool.query(
      `UPDATE loop_run_gates SET status = 'rejected', decision_json = $5::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND workflow_run_id = $2 AND tenant_id = $3 AND user_id = $4`,
      [gate.id, input.runId, input.auth.tenantId, input.auth.userId, JSON.stringify(input.decision)],
    );
    await markRunBlocked(input.runId, `Gate rejected: ${gate.title}`, payload?.taskId ?? null);
    return { runId: input.runId, status: "blocked", gateId: gate.id };
  }

  if (payload?.gateType === "missing_input" && typeof input.decision.value === "string") {
    await upsertEngineArtifact({
      context,
      artifactId: `gate_input_${gate.stage_id}`,
      kind: "gate_input",
      label: "Operator input",
      body: input.decision.value,
      data: { gateId: gate.id, gateType: payload.gateType },
      stageId: gate.stage_id,
    });
  }

  if (payload?.gateType === "memory_confirmation" && Array.isArray(input.decision.items)) {
    await upsertEngineArtifact({
      context,
      artifactId: `approved_memories_${gate.stage_id}`,
      kind: "approved_memories",
      label: "Approved memories",
      body: JSON.stringify(input.decision.items, null, 2),
      data: { items: input.decision.items },
      stageId: gate.stage_id,
    });
  }

  await pool.query(
    `UPDATE loop_run_gates SET status = $5, decision_json = $6::jsonb, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND workflow_run_id = $2 AND tenant_id = $3 AND user_id = $4`,
    [gate.id, input.runId, input.auth.tenantId, input.auth.userId, input.status, JSON.stringify(input.decision)],
  );

  const taskResult = await pool.query<{ id: string; seq: number; status: string }>(
    `SELECT id, seq, status FROM loop_run_tasks
     WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3 AND agent_id = $4
     ORDER BY seq DESC LIMIT 1`,
    [input.runId, input.auth.tenantId, input.auth.userId, gate.stage_id],
  );
  const task = taskResult.rows[0];

  if (task && task.status === "blocked") {
    await pool.query(
      `UPDATE loop_run_tasks SET status = 'done', updated_at = NOW() WHERE id = $1`,
      [task.id],
    );
  }

  const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
    activeGateId: null,
    activeGateStageId: null,
    gateCompletedAt: new Date().toISOString(),
    pendingInput: undefined,
  });

  await pool.query(
    `UPDATE workflow_runs SET status = 'running',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      input.runId,
      input.auth.tenantId,
      input.auth.userId,
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ],
  );

  await insertEvent({
    context,
    taskId: task?.id ?? null,
    eventType: "gate_completed",
    payload: { gateId: gate.id, gateType: payload?.gateType ?? null, status: input.status },
  });

  const freshContext = await loadRunContext(input.runId);
  const nextTaskId = task ? await loadNextTaskAfterSeq(freshContext, task.seq) : null;

  if (nextTaskId) {
    await scheduleHeartbeat({
      tenantId: freshContext.tenantId,
      userId: freshContext.userId,
      runId: input.runId,
      jobType: "agent",
      taskId: nextTaskId,
    });
    return { runId: input.runId, status: "running", gateId: gate.id };
  }

  await scheduleHeartbeat({
    tenantId: freshContext.tenantId,
    userId: freshContext.userId,
    runId: input.runId,
    jobType: "ceo_finalize",
  });
  return { runId: input.runId, status: "running", gateId: gate.id };
}

export function buildGatePayload(input: {
  gateType: LoopGateType;
  resultData: unknown;
  resultText: string;
  definition: LoopRunContext["definition"];
}): Partial<EngineGatePayload> {
  if (input.gateType === "memory_confirmation") {
    const data = input.resultData && typeof input.resultData === "object"
      ? input.resultData as Record<string, unknown>
      : {};
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const items = sources.map((row) => {
      const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
      return {
        id: typeof item.id === "string" ? item.id : "",
        excerpt: typeof item.text === "string" ? item.text.slice(0, 240) : "",
        include: true,
      };
    }).filter((item) => item.id && item.excerpt);
    return { items };
  }

  if (input.gateType === "missing_input") {
    const fields = (input.definition.inputsRequired ?? []).map((key) => ({
      key,
      label: key.replace(/_/g, " "),
      required: true,
    }));
    return { fields: fields.length > 0 ? fields : [{ key: "input", label: "Required input", required: true }] };
  }

  if (input.gateType === "draft_review") {
    return { draft: input.resultText.slice(0, 12_000) };
  }

  if (input.gateType === "pre_send") {
    const delivery = input.definition.delivery;
    return {
      provider: delivery?.provider,
      target: delivery?.target,
      draft: input.resultText.slice(0, 4000),
    };
  }

  return {};
}
