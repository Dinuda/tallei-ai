import { randomUUID } from "node:crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { evaluateAgentGoal } from "../loop-engine/goal-eval.js";
import {
  applyGateDecisionToRunMemory,
  buildAgentHandoff,
  isMisclassifiedDraftReviewGate,
  type RunMemory,
} from "./memory.js";
import { runLoopAgent } from "../loop-executor/agent-runner.js";
import { loopRunAgentSchema, type LoopGateType, type LoopRunAgent } from "../loop-executor/types.js";
import { buildCanvasEmailTemplate, type CanvasEmailTemplate } from "./email-canvas.js";
import { runtimeContextSchema, runtimeDefinitionSchema, type RuntimeContext, type RuntimeDefinition } from "./types.js";

const WORKER_LEASE_MS = 60_000;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const;
const workerId = `loop-runtime-${randomUUID()}`;

type CommandRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  run_id: string;
  step_attempt_id: string | null;
  command_type: "start_run" | "execute_step" | "continue_after_gate" | "finalize_run" | "retry_step";
  attempts: number;
  max_attempts: number;
  payload_json: unknown;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function runMemoryFromContext(context: RuntimeContext): RunMemory {
  return {
    inputs: context.inputs,
    approvedMemories: context.approvedMemories,
    updatedAt: new Date().toISOString(),
  };
}

function compactArtifactBody(body: string, maxChars = 6_000) {
  if (body.length <= maxChars) return body;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.floor(maxChars * 0.2);
  return [
    body.slice(0, headChars),
    `[truncated ${body.length - headChars - tailChars} chars]`,
    body.slice(body.length - tailChars),
  ].join("\n");
}

function compactArtifactData(data: unknown, maxChars = 6_000) {
  try {
    const text = JSON.stringify(data);
    if (text.length <= maxChars) return data;
    return {
      truncated: true,
      originalSizeChars: text.length,
      excerpt: text.slice(0, maxChars),
    };
  } catch {
    return null;
  }
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|rate limit|temporarily unavailable|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

async function insertEvent(input: {
  tenantId: string;
  userId: string;
  runId: string;
  stepAttemptId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO loop_engine_events
     (tenant_id, user_id, run_id, step_attempt_id, event_type, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [input.tenantId, input.userId, input.runId, input.stepAttemptId ?? null, input.eventType, JSON.stringify(input.payload ?? {})],
  );
}

async function enqueueCommand(input: {
  tenantId: string;
  userId: string;
  runId: string;
  stepAttemptId?: string | null;
  commandType: CommandRow["command_type"];
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  notBefore?: Date;
}) {
  await pool.query(
    `INSERT INTO loop_engine_commands
     (tenant_id, user_id, run_id, step_attempt_id, command_type, idempotency_key, payload_json, not_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      input.tenantId,
      input.userId,
      input.runId,
      input.stepAttemptId ?? null,
      input.commandType,
      input.idempotencyKey,
      JSON.stringify(input.payload ?? {}),
      input.notBefore ?? new Date(),
    ],
  );
}

export async function startManualLoopRun(auth: AuthContext, workflowId: string) {
  const workflowResult = await pool.query<{ id: string; title: string; metadata_json: unknown }>(
    `SELECT id, title, metadata_json FROM workflows
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'active'
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId],
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) throw new Error("Loop workflow not found");
  const metadata = asObject(workflow.metadata_json);
  const definition = runtimeDefinitionSchema.parse(metadata.loopDefinition);
  const runId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO loop_engine_runs
       (id, tenant_id, user_id, workflow_id, status, definition_snapshot, context_json)
       VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, $6::jsonb)`,
      [runId, auth.tenantId, auth.userId, workflowId, JSON.stringify(definition), JSON.stringify({ inputs: {}, approvedMemories: [] })],
    );
    await client.query(
      `INSERT INTO loop_engine_commands
       (tenant_id, user_id, run_id, command_type, idempotency_key)
       VALUES ($1, $2, $3, 'start_run', $4)`,
      [auth.tenantId, auth.userId, runId, `run:${runId}:start`],
    );
    await client.query(
      `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, event_type, payload_json)
       VALUES ($1, $2, $3, 'run_queued', $4::jsonb)`,
      [auth.tenantId, auth.userId, runId, JSON.stringify({ workflowId, workflowTitle: workflow.title })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getLoopRuntimeProjection(auth, runId);
}

async function createAttempt(input: {
  tenantId: string;
  userId: string;
  runId: string;
  stepIndex: number;
  agent: LoopRunAgent;
  attempt: number;
  inputJson?: Record<string, unknown>;
}) {
  const id = randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO loop_engine_step_attempts
     (id, tenant_id, user_id, run_id, step_index, agent_id, agent_snapshot, attempt, status, input_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'queued', $9::jsonb)
     ON CONFLICT (run_id, step_index, attempt)
     DO UPDATE SET updated_at = loop_engine_step_attempts.updated_at
     RETURNING id`,
    [
      id,
      input.tenantId,
      input.userId,
      input.runId,
      input.stepIndex,
      input.agent.id,
      JSON.stringify(input.agent),
      input.attempt,
      JSON.stringify(input.inputJson ?? {}),
    ],
  );
  return result.rows[0]!.id;
}

async function handleStartRun(command: CommandRow) {
  const result = await pool.query<{ definition_snapshot: unknown; status: string }>(
    `SELECT definition_snapshot, status FROM loop_engine_runs WHERE id = $1 LIMIT 1`,
    [command.run_id],
  );
  const row = result.rows[0];
  if (!row || row.status !== "queued") return;
  const definition = runtimeDefinitionSchema.parse(row.definition_snapshot);
  const firstAgent = definition.agentGraph!.children[0]!;
  const attemptId = await createAttempt({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepIndex: 0,
    agent: firstAgent,
    attempt: 1,
  });
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'running', current_step_index = 0, started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [command.run_id],
  );
  await enqueueCommand({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepAttemptId: attemptId,
    commandType: "execute_step",
    idempotencyKey: `attempt:${attemptId}:execute`,
  });
  await insertEvent({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    eventType: "run_started",
  });
}

async function createGate(input: {
  command: CommandRow;
  attemptId: string;
  gateType: LoopGateType;
  question: string;
  payload: Record<string, unknown>;
}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO loop_engine_gates
     (id, tenant_id, user_id, run_id, step_attempt_id, gate_type, question, payload_json, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      id,
      input.command.tenant_id,
      input.command.user_id,
      input.command.run_id,
      input.attemptId,
      input.gateType,
      input.question,
      JSON.stringify(input.payload),
      `attempt:${input.attemptId}:gate:${input.gateType}`,
    ],
  );
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'waiting_for_gate', updated_at = NOW() WHERE id = $1`,
    [input.attemptId],
  );
  await pool.query(
    `UPDATE loop_engine_runs SET status = 'waiting_for_gate', updated_at = NOW() WHERE id = $1`,
    [input.command.run_id],
  );
  await insertEvent({
    tenantId: input.command.tenant_id,
    userId: input.command.user_id,
    runId: input.command.run_id,
    stepAttemptId: input.attemptId,
    eventType: "gate_waiting",
    payload: { gateType: input.gateType, question: input.question },
  });
}

function gatePayloadForResult(
  gateType: LoopGateType,
  agentId: string,
  stepIndex: number,
  output: Record<string, unknown>,
  resultData: Record<string, unknown>,
) {
  const items = (Array.isArray(resultData.sources) ? resultData.sources : [])
    .map((row) => {
      const item = asObject(row);
      const id = typeof item.id === "string" ? item.id : "";
      const excerpt = typeof item.text === "string" ? item.text : typeof item.excerpt === "string" ? item.excerpt : "";
      return id && excerpt
        ? {
            id,
            excerpt,
            include: true,
            ...(typeof item.score === "number" ? { score: item.score } : {}),
            ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
            ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
            ...(typeof item.evidenceRole === "string" ? { evidenceRole: item.evidenceRole } : {}),
            ...(asObject(item.metadata) ? { metadata: asObject(item.metadata) } : {}),
          }
        : null;
    })
    .filter((row): row is { id: string; excerpt: string; include: boolean } & Record<string, unknown> => row !== null);
  return {
    agentId,
    stepIndex,
    result: output,
    ...(gateType === "memory_confirmation" ? { items } : {}),
  };
}

function gateQuestionForEvaluation(input: {
  agent: LoopRunAgent;
  gateType: LoopGateType;
  reason: string;
}) {
  return input.agent.gate?.type === input.gateType
    ? input.agent.gate.question
    : input.reason;
}

function isAffirmativeGateInput(value: Record<string, unknown>) {
  const raw = typeof value.value === "string"
    ? value.value
    : typeof value.text === "string"
      ? value.text
      : "";
  return /\b(yes|yep|yeah|approve|approved|go ahead|looks good|proceed|continue|ship|use it|ok|okay)\b/i.test(raw.trim());
}

async function persistArtifact(input: {
  command: CommandRow;
  attemptId: string;
  artifactKey: string;
  kind: string;
  body: string;
  data: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO loop_engine_artifacts
     (tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json)
     SELECT $1, $2, $3, $4, $5,
            COALESCE(MAX(version), 0) + 1, $6, $7, $8::jsonb
     FROM loop_engine_artifacts WHERE run_id = $3 AND artifact_key = $5`,
    [
      input.command.tenant_id,
      input.command.user_id,
      input.command.run_id,
      input.attemptId,
      input.artifactKey,
      input.kind,
      input.body,
      JSON.stringify(input.data),
    ],
  );
}

type QueryExecutor = Pick<typeof pool, "query">;

function canvasPreviewArtifactKeys(artifactKey: string) {
  const keys = new Set([artifactKey]);
  keys.add(artifactKey.replace(/:canvas\.preview$/, ":canvas.email"));
  return [...keys];
}

async function markCanvasArtifactPreview(
  db: QueryExecutor,
  input: {
    runId: string;
    artifactKey: string;
  },
) {
  const previewState = JSON.stringify({ canvas_state: "preview" });
  for (const artifactKey of canvasPreviewArtifactKeys(input.artifactKey)) {
    await db.query(
      `UPDATE loop_engine_artifacts
       SET data_json = data_json || $1::jsonb
       WHERE run_id = $2 AND artifact_key = $3 AND kind IN ('canvas_email', 'canvas_preview') AND invalidated_at IS NULL`,
      [previewState, input.runId, artifactKey],
    );
  }
}

async function persistCanvasEmailArtifact(input: {
  command: CommandRow;
  attemptId: string;
  artifactKey: string;
  markdown: string;
}) {
  const emailTemplate = buildCanvasEmailTemplate({ markdown: input.markdown });
  await persistArtifact({
    command: input.command,
    attemptId: input.attemptId,
    artifactKey: input.artifactKey,
    kind: "canvas_email",
    body: emailTemplate.html,
    data: {
      renderTarget: "canvas.email",
      emailTemplate,
    },
  });
  return emailTemplate;
}

async function persistCanvasPreviewArtifact(input: {
  command: CommandRow;
  attemptId: string;
  artifactKey: string;
  markdown: string;
}) {
  const emailTemplate = buildCanvasEmailTemplate({ markdown: input.markdown });
  await persistArtifact({
    command: input.command,
    attemptId: input.attemptId,
    artifactKey: input.artifactKey,
    kind: "canvas_email",
    body: emailTemplate.html,
    data: {
      renderTarget: "canvas.preview",
      emailTemplate,
    },
  });
  await markCanvasArtifactPreview(pool, {
    runId: input.command.run_id,
    artifactKey: input.artifactKey,
  });
  return emailTemplate;
}

async function queueNextStep(command: CommandRow, definition: RuntimeDefinition, currentStep: number) {
  const nextIndex = currentStep + 1;
  const nextAgent = definition.agentGraph!.children[nextIndex];
  if (!nextAgent) {
    await enqueueCommand({
      tenantId: command.tenant_id,
      userId: command.user_id,
      runId: command.run_id,
      commandType: "finalize_run",
      idempotencyKey: `run:${command.run_id}:finalize`,
    });
    return;
  }
  const attemptId = await createAttempt({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepIndex: nextIndex,
    agent: nextAgent,
    attempt: 1,
  });
  await pool.query(
    `UPDATE loop_engine_runs SET status = 'running', current_step_index = $2, updated_at = NOW() WHERE id = $1`,
    [command.run_id, nextIndex],
  );
  await enqueueCommand({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepAttemptId: attemptId,
    commandType: "execute_step",
    idempotencyKey: `attempt:${attemptId}:execute`,
  });
}

async function handleExecuteStep(command: CommandRow) {
  if (!command.step_attempt_id) throw new Error("execute_step command has no attempt");
  const result = await pool.query<{
    run_status: string;
    definition_snapshot: unknown;
    context_json: unknown;
    workflow_id: string;
    workflow_title: string;
    attempt_status: string;
    step_index: number;
    agent_snapshot: unknown;
    attempt: number;
  }>(
    `SELECT r.status AS run_status, r.definition_snapshot, r.context_json, r.workflow_id,
            w.title AS workflow_title, a.status AS attempt_status, a.step_index, a.agent_snapshot, a.attempt
     FROM loop_engine_step_attempts a
     JOIN loop_engine_runs r ON r.id = a.run_id
     JOIN workflows w ON w.id = r.workflow_id
     WHERE a.id = $1 LIMIT 1`,
    [command.step_attempt_id],
  );
  const row = result.rows[0];
  if (!row || row.run_status === "cancelled" || row.attempt_status !== "queued") return;
  const definition = runtimeDefinitionSchema.parse(row.definition_snapshot);
  const context = runtimeContextSchema.parse(row.context_json);
  const agent = loopRunAgentSchema.parse(row.agent_snapshot);

  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'running', lease_owner = $2, lease_expires_at = NOW() + INTERVAL '60 seconds',
         heartbeat_at = NOW(), started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [command.step_attempt_id, workerId],
  );

  const artifactRows = await pool.query<{
    artifact_key: string;
    kind: string;
    body: string;
    data_json: unknown;
    step_index: number;
  }>(
    `SELECT DISTINCT ON (artifact_key) artifact_key, kind, body, data_json, step_index
     FROM (
       SELECT a.artifact_key, a.kind, a.body, a.data_json, s.step_index, a.version
       FROM loop_engine_artifacts a
       JOIN loop_engine_step_attempts s ON s.id = a.step_attempt_id
       WHERE a.run_id = $1
         AND a.invalidated_at IS NULL
         AND a.kind <> 'canvas_email'
         AND s.step_index < $2
     ) upstream
     ORDER BY artifact_key, version DESC`,
    [command.run_id, row.step_index],
  );
  const priorOutputs = Object.fromEntries(
    artifactRows.rows.map((artifact) => [
      artifact.artifact_key,
      {
        artifactId: artifact.artifact_key,
        kind: artifact.kind,
        stepIndex: artifact.step_index,
        body: compactArtifactBody(artifact.body),
        data: compactArtifactData(artifact.data_json),
      },
    ]),
  );
  const agentHandoff = buildAgentHandoff(agent, runMemoryFromContext(context), priorOutputs);
  const priorComments = artifactRows.rows.map((artifact) => ({
    author: artifact.artifact_key,
    body: compactArtifactBody(artifact.body),
  }));

  const agentResult = await runLoopAgent({
    auth: {
      tenantId: command.tenant_id,
      userId: command.user_id,
      authMode: "internal",
      plan: "pro",
    },
    goal: definition.goal,
    agent,
    assignedTools: agent.tools,
    draftPolicy: definition.draftPolicy,
    priorComments,
    agentHandoff,
    runId: command.run_id,
    workflowId: row.workflow_id,
    workflowTitle: row.workflow_title,
    definition,
  });
  const goalEval = await evaluateAgentGoal({
    agent,
    result: agentResult,
    definition,
    runMemory: runMemoryFromContext(context),
  });
  const output = { text: agentResult.text, data: agentResult.data, goalEval };

  if (goalEval.status === "fail") {
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'failed', output_json = $2::jsonb, error_json = $3::jsonb, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [command.step_attempt_id, JSON.stringify(output), JSON.stringify({ message: goalEval.reason })],
    );
    if (row.attempt < 3) {
      const retryId = await createAttempt({
        tenantId: command.tenant_id,
        userId: command.user_id,
        runId: command.run_id,
        stepIndex: row.step_index,
        agent,
        attempt: row.attempt + 1,
      });
      await enqueueCommand({
        tenantId: command.tenant_id,
        userId: command.user_id,
        runId: command.run_id,
        stepAttemptId: retryId,
        commandType: "retry_step",
        idempotencyKey: `attempt:${retryId}:retry`,
        notBefore: new Date(Date.now() + RETRY_DELAYS_MS[Math.min(row.attempt - 1, RETRY_DELAYS_MS.length - 1)]),
      });
      return;
    }
    await pool.query(
      `UPDATE loop_engine_runs SET status = 'blocked', error_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [command.run_id, JSON.stringify({ message: goalEval.reason, code: "goal_eval_failed" })],
    );
    return;
  }

  await pool.query(
    `UPDATE loop_engine_step_attempts SET output_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [command.step_attempt_id, JSON.stringify(output)],
  );
  await persistArtifact({
    command,
    attemptId: command.step_attempt_id,
    artifactKey: agent.outputArtifactId ?? `${agent.id}_output`,
    kind: "structured_output",
    body: agentResult.text,
    data: output,
  });
  const canvasArtifactKey = (() => {
    if (agent.renderTarget === "canvas.email") return `${agent.outputArtifactId ?? `${agent.id}_output`}:canvas.email`;
    if (agent.renderTarget === "canvas.preview") return `${agent.outputArtifactId ?? `${agent.id}_output`}:canvas.email`;
    return null;
  })();
  if (agent.renderTarget === "canvas.email") {
    await persistCanvasEmailArtifact({
      command,
      attemptId: command.step_attempt_id,
      artifactKey: canvasArtifactKey!,
      markdown: agentResult.text,
    });
  } else if (agent.renderTarget === "canvas.preview") {
    await persistCanvasPreviewArtifact({
      command,
      attemptId: command.step_attempt_id,
      artifactKey: canvasArtifactKey!,
      markdown: agentResult.text,
    });
  }

  if (goalEval.status === "needs_input") {
    const gateType = goalEval.gateType ?? agent.gate?.type ?? "missing_input";
    await createGate({
      command,
      attemptId: command.step_attempt_id,
      gateType,
      question: gateQuestionForEvaluation({ agent, gateType, reason: goalEval.reason }),
      payload: {
        ...gatePayloadForResult(gateType, agent.id, row.step_index, output, agentResult.data),
        ...(canvasArtifactKey ? { renderTarget: agent.renderTarget, canvasArtifactKey } : {}),
      },
    });
    return;
  }

  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'succeeded', finished_at = NOW(), lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [command.step_attempt_id],
  );
  await insertEvent({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepAttemptId: command.step_attempt_id,
    eventType: "step_succeeded",
    payload: { agentId: agent.id, stepIndex: row.step_index },
  });
  await queueNextStep(command, definition, row.step_index);
}

async function handleContinueAfterGate(command: CommandRow) {
  const payload = asObject(command.payload_json);
  const gateId = typeof payload.gateId === "string" ? payload.gateId : null;
  if (!gateId) throw new Error("continue_after_gate command has no gate");
  const result = await pool.query<{
    gate_type: LoopGateType;
    status: string;
    payload_json: unknown;
    step_attempt_id: string;
    step_index: number;
    attempt: number;
    agent_snapshot: unknown;
    definition_snapshot: unknown;
    context_json: unknown;
  }>(
    `SELECT g.gate_type, g.status, g.payload_json, g.step_attempt_id, a.step_index, a.attempt,
            a.agent_snapshot, r.definition_snapshot, r.context_json
     FROM loop_engine_gates g
     JOIN loop_engine_step_attempts a ON a.id = g.step_attempt_id
     JOIN loop_engine_runs r ON r.id = g.run_id
     WHERE g.id = $1 AND g.run_id = $2 LIMIT 1`,
    [gateId, command.run_id],
  );
  const row = result.rows[0];
  if (!row) return;
  const definition = runtimeDefinitionSchema.parse(row.definition_snapshot);
  const context = runtimeContextSchema.parse(row.context_json);
  const agent = loopRunAgentSchema.parse(row.agent_snapshot);
  const treatAsDraftReview = isMisclassifiedDraftReviewGate({
    gateType: row.gate_type,
    gateStatus: row.status,
    agent,
    gatePayload: asObject(row.payload_json),
    definition,
    runMemory: runMemoryFromContext(context),
  });
  if (row.gate_type === "missing_input" && !treatAsDraftReview) {
    await pool.query(
      `UPDATE loop_engine_step_attempts SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'waiting_for_gate'`,
      [row.step_attempt_id],
    );
    const retryId = await createAttempt({
      tenantId: command.tenant_id,
      userId: command.user_id,
      runId: command.run_id,
      stepIndex: row.step_index,
      agent,
      attempt: row.attempt + 1,
    });
    await pool.query(
      `UPDATE loop_engine_runs SET status = 'running', current_step_index = $2, updated_at = NOW() WHERE id = $1`,
      [command.run_id, row.step_index],
    );
    await enqueueCommand({
      tenantId: command.tenant_id,
      userId: command.user_id,
      runId: command.run_id,
      stepAttemptId: retryId,
      commandType: "execute_step",
      idempotencyKey: `attempt:${retryId}:execute`,
    });
    return;
  }
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'succeeded', finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'waiting_for_gate'`,
    [row.step_attempt_id],
  );
  await queueNextStep(command, definition, row.step_index);
}

async function handleFinalizeRun(command: CommandRow) {
  const pending = await pool.query(
    `SELECT id FROM loop_engine_gates WHERE run_id = $1 AND status = 'pending' LIMIT 1`,
    [command.run_id],
  );
  if (pending.rows[0]) throw new Error("Cannot finalize a run with a pending gate");
  const reviewedArtifacts = await pool.query<{ canvas_artifact_key: string | null }>(
    `SELECT DISTINCT payload_json->>'canvasArtifactKey' AS canvas_artifact_key
     FROM loop_engine_gates
     WHERE run_id = $1
       AND status = 'approved'
       AND payload_json ? 'canvasArtifactKey'`,
    [command.run_id],
  );
  for (const row of reviewedArtifacts.rows) {
    if (row.canvas_artifact_key) {
      await markCanvasArtifactPreview(pool, {
        runId: command.run_id,
        artifactKey: row.canvas_artifact_key,
      });
    }
  }
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'succeeded', finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status IN ('running', 'waiting_for_gate')`,
    [command.run_id],
  );
  await insertEvent({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    eventType: "run_succeeded",
  });
}

async function handleRetryStep(command: CommandRow) {
  if (!command.step_attempt_id) throw new Error("retry_step command has no attempt");
  await pool.query(
    `UPDATE loop_engine_runs SET status = 'running', updated_at = NOW() WHERE id = $1 AND status <> 'cancelled'`,
    [command.run_id],
  );
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'queued', updated_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [command.step_attempt_id],
  );
  await enqueueCommand({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepAttemptId: command.step_attempt_id,
    commandType: "execute_step",
    idempotencyKey: `attempt:${command.step_attempt_id}:execute`,
  });
}

async function processCommand(command: CommandRow) {
  if (command.command_type === "start_run") return handleStartRun(command);
  if (command.command_type === "execute_step") return handleExecuteStep(command);
  if (command.command_type === "continue_after_gate") return handleContinueAfterGate(command);
  if (command.command_type === "finalize_run") return handleFinalizeRun(command);
  return handleRetryStep(command);
}

async function claimCommand(): Promise<CommandRow | null> {
  const result = await pool.query<CommandRow>(
    `WITH candidate AS (
       SELECT id FROM loop_engine_commands
       WHERE status = 'pending' AND not_before <= NOW()
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE loop_engine_commands c
     SET status = 'processing', attempts = attempts + 1, lease_owner = $1,
         lease_expires_at = NOW() + INTERVAL '60 seconds', updated_at = NOW()
     FROM candidate
     WHERE c.id = candidate.id
     RETURNING c.*`,
    [workerId],
  );
  return result.rows[0] ?? null;
}

export async function dispatchLoopRuntimeCommands(limit = 10) {
  await pool.query(
    `UPDATE loop_engine_step_attempts a
     SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
     FROM loop_engine_commands c
     WHERE c.step_attempt_id = a.id
       AND c.command_type IN ('execute_step', 'retry_step')
       AND c.status = 'processing'
       AND c.lease_expires_at < NOW()
       AND a.status = 'running'`,
  );
  await pool.query(
    `UPDATE loop_engine_commands
     SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
     WHERE status = 'processing' AND lease_expires_at < NOW()`,
  );
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const command = await claimCommand();
    if (!command) break;
    try {
      await processCommand(command);
      await pool.query(
        `UPDATE loop_engine_commands
         SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $1`,
        [command.id],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retry = isRetryableError(error) && command.attempts < command.max_attempts;
      await pool.query(
        `UPDATE loop_engine_commands
         SET status = $2, last_error = $3, lease_owner = NULL, lease_expires_at = NULL,
             not_before = CASE WHEN $2 = 'pending' THEN NOW() + INTERVAL '10 seconds' ELSE not_before END,
             updated_at = NOW()
         WHERE id = $1`,
        [command.id, retry ? "pending" : "failed", message],
      );
      if (retry && command.step_attempt_id) {
        await pool.query(
          `UPDATE loop_engine_step_attempts
           SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
           WHERE id = $1 AND status = 'running'`,
          [command.step_attempt_id],
        );
      }
      if (!retry) {
        if (command.step_attempt_id) {
          await pool.query(
            `UPDATE loop_engine_step_attempts
             SET status = 'failed', error_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND status IN ('queued', 'running')`,
            [command.step_attempt_id, JSON.stringify({ message, commandId: command.id })],
          );
        }
        await pool.query(
          `UPDATE loop_engine_runs SET status = 'failed', error_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status <> 'cancelled'`,
          [command.run_id, JSON.stringify({ message, commandId: command.id })],
        );
      }
    }
  }
  return { processed };
}

export async function getLoopRuntimeProjection(auth: AuthContext, runId: string) {
  const runResult = await pool.query(
    `SELECT r.*, w.title AS workflow_title
     FROM loop_engine_runs r JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1 AND r.tenant_id = $2 AND r.user_id = $3 LIMIT 1`,
    [runId, auth.tenantId, auth.userId],
  );
  const run = runResult.rows[0];
  if (!run) throw new Error("Loop run not found");
  const [steps, gates, artifacts, events] = await Promise.all([
    pool.query(`SELECT * FROM loop_engine_step_attempts WHERE run_id = $1 ORDER BY step_index, attempt`, [runId]),
    pool.query(`SELECT * FROM loop_engine_gates WHERE run_id = $1 ORDER BY created_at`, [runId]),
    pool.query(`SELECT * FROM loop_engine_artifacts WHERE run_id = $1 ORDER BY created_at`, [runId]),
    pool.query(`SELECT * FROM loop_engine_events WHERE run_id = $1 ORDER BY created_at, id`, [runId]),
  ]);
  return {
    ...run,
    definition: run.definition_snapshot,
    context: run.context_json,
    steps: steps.rows,
    gates: gates.rows,
    artifacts: artifacts.rows,
    events: events.rows,
  };
}

export async function listLoopRuntimeRuns(auth: AuthContext, workflowId: string) {
  const result = await pool.query(
    `SELECT id, workflow_id, status, current_step_index, error_json, started_at, finished_at, created_at, updated_at
     FROM loop_engine_runs
     WHERE workflow_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY created_at DESC LIMIT 50`,
    [workflowId, auth.tenantId, auth.userId],
  );
  return result.rows;
}

export async function decideLoopRuntimeGate(input: {
  auth: AuthContext;
  runId: string;
  gateId: string;
  decision: "approve" | "input" | "reject";
  value: Record<string, unknown>;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const gateResult = await client.query<{
      id: string;
      status: string;
      gate_type: LoopGateType;
      decision_json: unknown;
      payload_json: unknown;
      definition_snapshot: unknown;
      context_json: unknown;
      tenant_id: string;
      user_id: string;
    }>(
      `SELECT g.id, g.status, g.gate_type, g.decision_json, g.payload_json, r.definition_snapshot, r.context_json, r.tenant_id, r.user_id
       FROM loop_engine_gates g JOIN loop_engine_runs r ON r.id = g.run_id
       WHERE g.id = $1 AND g.run_id = $2 AND r.tenant_id = $3 AND r.user_id = $4
       FOR UPDATE`,
      [input.gateId, input.runId, input.auth.tenantId, input.auth.userId],
    );
    const gate = gateResult.rows[0];
    if (!gate) throw new Error("Loop gate not found");
    if (gate.status !== "pending") {
      await client.query("COMMIT");
      return { runId: input.runId, gateId: input.gateId, status: gate.status, decision: gate.decision_json };
    }
    const decision = input.decision === "input" && gate.gate_type !== "missing_input" && isAffirmativeGateInput(input.value)
      ? "approve"
      : input.decision;
    if (input.decision === "input" && gate.gate_type !== "missing_input" && decision !== "approve") {
      throw new Error("Approval gate requires an explicit approve or reject decision");
    }
    if (decision === "reject") {
      await client.query(
        `UPDATE loop_engine_gates SET status = 'rejected', decision_json = $2::jsonb, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [input.gateId, JSON.stringify(input.value)],
      );
      await client.query(
        `UPDATE loop_engine_runs SET status = 'blocked', error_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [input.runId, JSON.stringify({ message: "Gate rejected", gateId: input.gateId })],
      );
      await client.query(
        `UPDATE loop_engine_step_attempts
         SET status = 'failed', error_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
         WHERE id = (SELECT step_attempt_id FROM loop_engine_gates WHERE id = $1)
           AND status = 'waiting_for_gate'`,
        [input.gateId, JSON.stringify({ message: "Gate rejected", gateId: input.gateId })],
      );
      await client.query("COMMIT");
      return { runId: input.runId, gateId: input.gateId, status: "rejected" };
    }
    const definition = runtimeDefinitionSchema.parse(gate.definition_snapshot);
    const currentContext = runtimeContextSchema.parse(gate.context_json);
    const patch = applyGateDecisionToRunMemory({
      gateType: gate.gate_type,
      decision: input.value,
      definition,
    });
    const nextContext = runtimeContextSchema.parse({
      inputs: { ...currentContext.inputs, ...(patch.inputs ?? {}) },
      approvedMemories: patch.approvedMemories ?? currentContext.approvedMemories,
    });
    const status = decision === "input" ? "submitted" : "approved";
    await client.query(
      `UPDATE loop_engine_gates SET status = $2, decision_json = $3::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [input.gateId, status, JSON.stringify(input.value)],
    );
    if (decision === "approve") {
      const gatePayload = asObject(gate.payload_json);
      const canvasArtifactKey = typeof gatePayload.canvasArtifactKey === "string" ? gatePayload.canvasArtifactKey : null;
      if (canvasArtifactKey) {
        await markCanvasArtifactPreview(client, {
          runId: input.runId,
          artifactKey: canvasArtifactKey,
        });
      }
    }
    await client.query(
      `UPDATE loop_engine_runs SET context_json = $2::jsonb, status = 'running', updated_at = NOW() WHERE id = $1`,
      [input.runId, JSON.stringify(nextContext)],
    );
    await client.query(
      `INSERT INTO loop_engine_commands
       (tenant_id, user_id, run_id, command_type, idempotency_key, payload_json)
       VALUES ($1, $2, $3, 'continue_after_gate', $4, $5::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [gate.tenant_id, gate.user_id, input.runId, `gate:${input.gateId}:continue`, JSON.stringify({ gateId: input.gateId })],
    );
    await client.query("COMMIT");
    return { runId: input.runId, gateId: input.gateId, status };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelLoopRuntimeRun(auth: AuthContext, runId: string) {
  const result = await pool.query(
    `UPDATE loop_engine_runs SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status NOT IN ('succeeded', 'failed', 'cancelled')
     RETURNING id, status`,
    [runId, auth.tenantId, auth.userId],
  );
  if (!result.rows[0]) return getLoopRuntimeProjection(auth, runId);
  await pool.query(
    `UPDATE loop_engine_commands SET status = 'cancelled', updated_at = NOW()
     WHERE run_id = $1 AND status IN ('pending', 'processing')`,
    [runId],
  );
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND status IN ('queued', 'running', 'waiting_for_gate')`,
    [runId],
  );
  return getLoopRuntimeProjection(auth, runId);
}

export async function retryLoopRuntimeStep(auth: AuthContext, runId: string, stepAttemptId: string) {
  const result = await pool.query<{
    tenant_id: string;
    user_id: string;
    step_index: number;
    attempt: number;
    agent_snapshot: unknown;
  }>(
    `SELECT a.tenant_id, a.user_id, a.step_index, a.attempt, a.agent_snapshot
     FROM loop_engine_step_attempts a JOIN loop_engine_runs r ON r.id = a.run_id
     WHERE a.id = $1 AND a.run_id = $2 AND r.tenant_id = $3 AND r.user_id = $4
       AND a.status IN ('failed', 'cancelled')
     LIMIT 1`,
    [stepAttemptId, runId, auth.tenantId, auth.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Retryable step attempt not found");
  await pool.query(
    `UPDATE loop_engine_artifacts SET invalidated_at = NOW()
     WHERE run_id = $1 AND step_attempt_id IN (
       SELECT id FROM loop_engine_step_attempts WHERE run_id = $1 AND step_index >= $2
     ) AND invalidated_at IS NULL`,
    [runId, row.step_index],
  );
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND step_index > $2 AND status IN ('queued', 'running', 'waiting_for_gate', 'succeeded')`,
    [runId, row.step_index],
  );
  const retryId = await createAttempt({
    tenantId: row.tenant_id,
    userId: row.user_id,
    runId,
    stepIndex: row.step_index,
    agent: loopRunAgentSchema.parse(row.agent_snapshot),
    attempt: row.attempt + 1,
  });
  await pool.query(
    `UPDATE loop_engine_runs SET status = 'running', current_step_index = $2, error_json = '{}'::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [runId, row.step_index],
  );
  await enqueueCommand({
    tenantId: row.tenant_id,
    userId: row.user_id,
    runId,
    stepAttemptId: retryId,
    commandType: "retry_step",
    idempotencyKey: `attempt:${retryId}:retry`,
  });
  return getLoopRuntimeProjection(auth, runId);
}

export async function saveCanvasEmailArtifact(input: {
  auth: AuthContext;
  runId: string;
  artifactKey: string;
  emailTemplate: Pick<CanvasEmailTemplate, "design" | "html" | "text" | "subject" | "preview">;
}) {
  const existing = await pool.query<{
    tenant_id: string;
    user_id: string;
    step_attempt_id: string | null;
  }>(
    `SELECT a.tenant_id, a.user_id, a.step_attempt_id
     FROM loop_engine_artifacts a
     JOIN loop_engine_runs r ON r.id = a.run_id
     WHERE a.run_id = $1
       AND a.artifact_key = $2
       AND a.kind = 'canvas_email'
       AND a.invalidated_at IS NULL
       AND r.tenant_id = $3
       AND r.user_id = $4
     ORDER BY a.version DESC
     LIMIT 1`,
    [input.runId, input.artifactKey, input.auth.tenantId, input.auth.userId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Canvas email artifact not found");
  const emailTemplate: CanvasEmailTemplate = {
    ...input.emailTemplate,
    text: input.emailTemplate.text ?? "",
    subject: input.emailTemplate.subject ?? "Email draft",
    preview: input.emailTemplate.preview ?? input.emailTemplate.subject ?? "Email draft",
    updatedAt: new Date().toISOString(),
    source: "dashboard",
  };
  await pool.query(
    `INSERT INTO loop_engine_artifacts
     (tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json)
     SELECT $1, $2, $3, $4, $5,
            COALESCE(MAX(version), 0) + 1, 'canvas_email', $6, $7::jsonb
     FROM loop_engine_artifacts WHERE run_id = $3 AND artifact_key = $5`,
    [
      row.tenant_id,
      row.user_id,
      input.runId,
      row.step_attempt_id,
      input.artifactKey,
      emailTemplate.html,
      JSON.stringify({
        renderTarget: "canvas.email",
        emailTemplate,
      }),
    ],
  );
  await insertEvent({
    tenantId: row.tenant_id,
    userId: row.user_id,
    runId: input.runId,
    stepAttemptId: row.step_attempt_id,
    eventType: "canvas_email_saved",
    payload: { artifactKey: input.artifactKey },
  });
  return getLoopRuntimeProjection(input.auth, input.runId);
}

let timer: NodeJS.Timeout | null = null;

export function startLoopRuntimeWorker() {
  if (timer) return;
  timer = setInterval(() => {
    void dispatchLoopRuntimeCommands().catch((error) => {
      console.error("Stable loop runtime dispatch failed:", error);
    });
  }, 1_000);
  timer.unref();
}

export function stopLoopRuntimeWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
