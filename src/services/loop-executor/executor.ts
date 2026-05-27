import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import { runLoopTool } from "./integration-registry.js";
import { LOOP_DEFINITION_VERSION, loopDefinitionSchema, type LoopDefinition, type LoopToolKey } from "./types.js";

interface WorkflowRecord {
  id: string;
  title: string;
  status: string;
  metadata_json: unknown;
}

interface RunContext {
  runId: string;
  tenantId: string;
  userId: string;
  workflowId: string;
  workflowTitle: string;
  runStatus: string;
  draftOutput: string | null;
  metadataJson: unknown;
  definition: LoopDefinition;
}

interface LoopRunTaskRow {
  id: string;
  tenant_id: string;
  user_id: string;
  workflow_run_id: string;
  seq: number;
  agent_id: string;
  agent_name: string;
  tool_key: string;
  status: string;
  input_json: unknown;
  output_json: unknown;
}

interface LoopRunComment {
  id: string;
  task_id: string | null;
  author: string;
  body: string;
  created_at: string;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readLoopDefinition(metadata: unknown): LoopDefinition {
  const row = readObject(metadata);
  return loopDefinitionSchema.parse(row.loopDefinition);
}

async function loadWorkflow(auth: AuthContext, workflowId: string): Promise<WorkflowRecord> {
  const result = await pool.query<WorkflowRecord>(
    `SELECT id, title, status, metadata_json
     FROM workflows
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND definition_version = $4
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION]
  );
  const workflow = result.rows[0];
  if (!workflow) throw new Error("Loop workflow not found");
  if (workflow.status !== "active") throw new Error(`Loop workflow is ${workflow.status}`);
  return workflow;
}

async function loadRunContext(runId: string): Promise<RunContext> {
  const result = await pool.query<{
    id: string;
    tenant_id: string;
    user_id: string;
    workflow_id: string;
    status: string;
    draft_output: string | null;
    metadata_json: unknown;
    workflow_title: string;
    workflow_metadata_json: unknown;
  }>(
    `SELECT r.id,
            r.tenant_id,
            r.user_id,
            r.workflow_id,
            r.status,
            r.draft_output,
            r.metadata_json,
            w.title AS workflow_title,
            w.metadata_json AS workflow_metadata_json
     FROM workflow_runs r
     JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1
       AND w.definition_version = $2
     LIMIT 1`,
    [runId, LOOP_DEFINITION_VERSION]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Loop run not found");
  return {
    runId: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    workflowTitle: row.workflow_title,
    runStatus: row.status,
    draftOutput: row.draft_output,
    metadataJson: row.metadata_json,
    definition: readLoopDefinition(row.workflow_metadata_json),
  };
}

async function assertRunAccess(auth: AuthContext, runId: string): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `SELECT id
     FROM workflow_runs
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [runId, auth.tenantId, auth.userId]
  );
  if (!result.rows[0]) throw new Error("Loop run not found");
}

async function insertEvent(input: {
  context: Pick<RunContext, "tenantId" | "userId" | "runId">;
  taskId?: string | null;
  eventType: string;
  payload?: unknown;
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

async function insertComment(input: {
  context: Pick<RunContext, "tenantId" | "userId" | "runId">;
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

async function loadRunComments(context: Pick<RunContext, "tenantId" | "userId" | "runId">): Promise<LoopRunComment[]> {
  const result = await pool.query<LoopRunComment>(
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

async function completeLoopText(input: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const response = await aiProviderRegistry.chat({
    model: aiProviderRegistry.chatModelName(),
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    temperature: 0.2,
    maxTokens: input.maxTokens ?? 1200,
  });
  const text = response.text.trim();
  if (!text) throw new Error("Loop executor LLM returned an empty response");
  return text;
}

async function buildStrategy(context: RunContext): Promise<string> {
  return completeLoopText({
    system: "You are the CEO coordinator for a Paperclip-style multi-agent recurring loop. Produce a concise ordered execution strategy for the IC agents. Do not do their work.",
    user: [
      `Loop goal: ${context.definition.goal}`,
      "",
      `CEO policy: ${context.definition.ceo.policy}`,
      "",
      "Agents:",
      ...context.definition.agents.map((agent, index) => (
        `${index + 1}. ${agent.name} (${agent.id}) uses ${agent.toolPolicy.allowedTools[0]}: ${agent.task}`
      )),
      "",
      "Return a short plan with task order, handoff expectations, and approval constraints.",
    ].join("\n"),
  });
}

async function synthesizeFinalOutput(context: RunContext, comments: LoopRunComment[]): Promise<string> {
  const commentThread = comments
    .map((comment) => `[${comment.author}] ${comment.body}`)
    .join("\n\n")
    .slice(-16_000);
  return completeLoopText({
    system: "You are the CEO finalizer for a recurring loop. Synthesize the agent comments into the final run output. Preserve approval requirements and do not claim external publication occurred.",
    user: [
      `Loop title: ${context.workflowTitle}`,
      `Loop goal: ${context.definition.goal}`,
      "",
      `Comment thread:\n${commentThread || "No comments were posted."}`,
      "",
      "Return the final concise output for the run.",
    ].join("\n"),
    maxTokens: 1800,
  });
}

async function markRunBlocked(runId: string, message: string, taskId?: string | null): Promise<void> {
  const context = await loadRunContext(runId);
  await insertComment({
    context,
    taskId: taskId ?? null,
    author: "ceo",
    body: `Blocked: ${message}`,
  }).catch(() => undefined);
  await insertEvent({
    context,
    taskId: taskId ?? null,
    eventType: "run_blocked",
    payload: { message },
  }).catch(() => undefined);
  await pool.query(
    `UPDATE workflow_runs
     SET status = 'blocked',
         waiting_for_strategy_approval = FALSE,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [
      runId,
      context.tenantId,
      context.userId,
      JSON.stringify({ loop_executor: { blockedAt: new Date().toISOString(), error: { message } } }),
    ]
  );
}

function fireAndForget(promise: Promise<unknown>, runId: string): void {
  void promise.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    void markRunBlocked(runId, message).catch((blockError) => {
      console.error("[loop-executor] failed to mark run blocked:", blockError);
    });
  });
}

export async function runCeoStrategyHeartbeat(runId: string): Promise<{
  runId: string;
  status: "waiting_for_strategy_approval";
  strategyOutput: string;
}> {
  const context = await loadRunContext(runId);
  const strategyOutput = await buildStrategy(context);

  for (const [seq, agent] of context.definition.agents.entries()) {
    const [toolKey] = agent.toolPolicy.allowedTools;
    if (!toolKey) throw new Error(`Agent ${agent.name} must have exactly one tool`);
    if (agent.integration !== "internal" && !context.definition.integrations.includes(agent.integration)) {
      throw new Error(`Agent ${agent.name} requested unavailable integration ${agent.integration}`);
    }
    await pool.query(
      `INSERT INTO loop_run_tasks
       (id, tenant_id, user_id, workflow_run_id, seq, agent_id, agent_name, tool_key, status, input_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'todo', $9::jsonb)
       ON CONFLICT (tenant_id, user_id, workflow_run_id, seq) DO UPDATE
         SET agent_id = EXCLUDED.agent_id,
             agent_name = EXCLUDED.agent_name,
             tool_key = EXCLUDED.tool_key,
             input_json = EXCLUDED.input_json,
             updated_at = NOW()`,
      [
        randomUUID(),
        context.tenantId,
        context.userId,
        context.runId,
        seq,
        agent.id,
        agent.name,
        toolKey,
        JSON.stringify({ agent, strategyOutput }),
      ]
    );
  }

  await insertComment({
    context,
    author: "ceo",
    body: strategyOutput,
  });
  await insertEvent({
    context,
    eventType: "ceo_strategy_ready",
    payload: { agentCount: context.definition.agents.length },
  });

  await pool.query(
    `UPDATE workflow_runs
     SET status = 'waiting_for_strategy_approval',
         strategy_output = $4,
         waiting_for_strategy_approval = TRUE,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [
      context.runId,
      context.tenantId,
      context.userId,
      strategyOutput,
      JSON.stringify({ loop_executor: { strategyReadyAt: new Date().toISOString() } }),
    ]
  );

  return { runId: context.runId, status: "waiting_for_strategy_approval", strategyOutput };
}

async function checkoutTask(runId: string, taskId: string): Promise<LoopRunTaskRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<LoopRunTaskRow>(
      `SELECT t.*
       FROM loop_run_tasks t
       JOIN workflow_runs r ON r.id = t.workflow_run_id
       WHERE t.workflow_run_id = $1
         AND t.id = $2
         AND t.status = 'todo'
         AND r.status IN ('strategy_approved', 'running')
       FOR UPDATE OF t SKIP LOCKED
       LIMIT 1`,
      [runId, taskId]
    );
    const task = result.rows[0];
    if (!task) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE loop_run_tasks
       SET status = 'in_progress',
           checkout_locked_at = NOW(),
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [task.id]
    );
    await client.query("COMMIT");
    return { ...task, status: "in_progress" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadNextTask(context: RunContext, currentSeq: number): Promise<LoopRunTaskRow | null> {
  const result = await pool.query<LoopRunTaskRow>(
    `SELECT *
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND seq = $4
     LIMIT 1`,
    [context.runId, context.tenantId, context.userId, currentSeq + 1]
  );
  return result.rows[0] ?? null;
}

export async function runAgentHeartbeat(runId: string, taskId: string): Promise<{ status: string; taskId: string }> {
  const context = await loadRunContext(runId);
  const task = await checkoutTask(runId, taskId);
  if (!task) return { status: "skipped", taskId };

  try {
    await insertEvent({
      context,
      taskId: task.id,
      eventType: "agent_checked_out",
      payload: { agentId: task.agent_id, seq: task.seq },
    });

    const comments = await loadRunComments(context);
    const taskInput = readObject(task.input_json);
    const inputAgent = readObject(taskInput.agent);
    const agentTask = typeof inputAgent.task === "string" ? inputAgent.task : task.tool_key;
    const result = await runLoopTool(task.tool_key as LoopToolKey, {
      goal: context.definition.goal,
      agentName: task.agent_name,
      agentTask,
      priorComments: comments.map((comment) => ({
        author: comment.author,
        body: comment.body,
        taskId: comment.task_id,
        createdAt: comment.created_at,
      })),
    });

    await insertComment({
      context,
      taskId: task.id,
      author: task.agent_id,
      body: result.text,
    });
    await pool.query(
      `UPDATE loop_run_tasks
       SET status = 'done',
           output_json = $4::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`,
      [
        task.id,
        context.tenantId,
        context.userId,
        JSON.stringify({ text: result.text, data: result.data, draft: result.draft ?? null }),
      ]
    );
    await insertEvent({
      context,
      taskId: task.id,
      eventType: "agent_completed",
      payload: { agentId: task.agent_id, seq: task.seq, hasDraft: Boolean(result.draft) },
    });

    const nextTask = await loadNextTask(context, task.seq);
    if (nextTask) {
      fireAndForget(runAgentHeartbeat(runId, nextTask.id), runId);
    } else {
      fireAndForget(runCeoFinalizeHeartbeat(runId), runId);
    }
    return { status: "done", taskId: task.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE loop_run_tasks
       SET status = 'blocked',
           error_json = $4::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`,
      [task.id, context.tenantId, context.userId, JSON.stringify({ message })]
    );
    await markRunBlocked(runId, `Agent ${task.agent_name} blocked: ${message}`, task.id);
    return { status: "blocked", taskId: task.id };
  }
}

export async function runCeoFinalizeHeartbeat(runId: string): Promise<{ runId: string; status: string; finalOutput: string }> {
  const context = await loadRunContext(runId);
  const tasks = await pool.query<LoopRunTaskRow>(
    `SELECT *
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY seq ASC`,
    [context.runId, context.tenantId, context.userId]
  );
  const blocked = tasks.rows.find((task) => task.status === "blocked");
  if (blocked) {
    const message = `Agent ${blocked.agent_name} is blocked. Review the task comment thread before continuing.`;
    await markRunBlocked(runId, message, blocked.id);
    return { runId, status: "blocked", finalOutput: message };
  }

  const comments = await loadRunComments(context);
  const finalOutput = await synthesizeFinalOutput(context, comments);
  const drafts = tasks.rows
    .map((task) => readObject(task.output_json).draft)
    .filter((draft): draft is Record<string, unknown> => Boolean(draft && typeof draft === "object"));
  const draftRequired = drafts.length > 0 && context.definition.draftPolicy.requireDraftBeforeExternalAction;
  const status = draftRequired ? "waiting_for_approval" : "completed";

  await insertComment({
    context,
    author: "ceo",
    body: finalOutput,
  });
  await insertEvent({
    context,
    eventType: "ceo_finalized",
    payload: { draftRequired, draftCount: drafts.length, status },
  });
  await pool.query(
    `UPDATE workflow_runs
     SET status = $4,
         waiting_for_strategy_approval = FALSE,
         draft_output = $5,
         connector_action_status = $6,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $7::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [
      context.runId,
      context.tenantId,
      context.userId,
      status,
      finalOutput,
      draftRequired ? "pending_approval" : "not_required",
      JSON.stringify({
        loop_executor: {
          completedAt: new Date().toISOString(),
          draftRequired,
          drafts,
        },
      }),
    ]
  );

  return { runId: context.runId, status, finalOutput };
}

export async function approveLoopStrategy(input: {
  auth: AuthContext;
  runId: string;
}): Promise<{ runId: string; status: "strategy_approved"; firstTaskId: string | null }> {
  await assertRunAccess(input.auth, input.runId);
  const context = await loadRunContext(input.runId);
  if (context.runStatus !== "waiting_for_strategy_approval") {
    throw new Error(`Run is ${context.runStatus}, not waiting_for_strategy_approval`);
  }
  const firstTask = await pool.query<{ id: string }>(
    `SELECT id
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND status = 'todo'
     ORDER BY seq ASC
     LIMIT 1`,
    [context.runId, context.tenantId, context.userId]
  );
  const firstTaskId = firstTask.rows[0]?.id ?? null;
  await pool.query(
    `UPDATE workflow_runs
     SET status = 'strategy_approved',
         waiting_for_strategy_approval = FALSE,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [context.runId, context.tenantId, context.userId]
  );
  await insertComment({
    context,
    author: "user",
    body: "Strategy approved. Agents may begin execution.",
  });
  await insertEvent({
    context,
    eventType: "strategy_approved",
    payload: { firstTaskId },
  });

  if (firstTaskId) {
    fireAndForget(runAgentHeartbeat(context.runId, firstTaskId), context.runId);
  } else {
    fireAndForget(runCeoFinalizeHeartbeat(context.runId), context.runId);
  }

  return { runId: context.runId, status: "strategy_approved", firstTaskId };
}

export async function listLoopRunTasks(auth: AuthContext, runId: string): Promise<Array<{
  id: string;
  seq: number;
  agentId: string;
  agentName: string;
  toolKey: string;
  status: string;
  inputJson: unknown;
  outputJson: unknown;
  errorJson: unknown;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestComment: { id: string; author: string; body: string; createdAt: string } | null;
}>> {
  await assertRunAccess(auth, runId);
  const result = await pool.query<{
    id: string;
    seq: number;
    agent_id: string;
    agent_name: string;
    tool_key: string;
    status: string;
    input_json: unknown;
    output_json: unknown;
    error_json: unknown;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
    latest_comment_id: string | null;
    latest_comment_author: string | null;
    latest_comment_body: string | null;
    latest_comment_created_at: string | null;
  }>(
    `SELECT t.id,
            t.seq,
            t.agent_id,
            t.agent_name,
            t.tool_key,
            t.status,
            t.input_json,
            t.output_json,
            t.error_json,
            t.started_at,
            t.completed_at,
            t.created_at,
            t.updated_at,
            c.id AS latest_comment_id,
            c.author AS latest_comment_author,
            c.body AS latest_comment_body,
            c.created_at AS latest_comment_created_at
     FROM loop_run_tasks t
     LEFT JOIN LATERAL (
       SELECT id, author, body, created_at
       FROM loop_run_comments
       WHERE task_id = t.id
       ORDER BY created_at DESC
       LIMIT 1
     ) c ON TRUE
     WHERE t.workflow_run_id = $1
       AND t.tenant_id = $2
       AND t.user_id = $3
     ORDER BY t.seq ASC`,
    [runId, auth.tenantId, auth.userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    agentId: row.agent_id,
    agentName: row.agent_name,
    toolKey: row.tool_key,
    status: row.status,
    inputJson: row.input_json,
    outputJson: row.output_json,
    errorJson: row.error_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestComment: row.latest_comment_id && row.latest_comment_author && row.latest_comment_body && row.latest_comment_created_at
      ? {
        id: row.latest_comment_id,
        author: row.latest_comment_author,
        body: row.latest_comment_body,
        createdAt: row.latest_comment_created_at,
      }
      : null,
  }));
}

export async function getLoopRun(auth: AuthContext, runId: string): Promise<{
  id: string;
  workflowId: string;
  status: string;
  runMode: string;
  scheduledFor: string | null;
  strategyOutput: string | null;
  waitingForStrategyApproval: boolean;
  draftOutput: string | null;
  connectorActionStatus: string | null;
  createdAt: string;
  updatedAt: string;
}> {
  const result = await pool.query<{
    id: string;
    workflow_id: string;
    status: string;
    run_mode: string;
    scheduled_for: string | null;
    strategy_output: string | null;
    waiting_for_strategy_approval: boolean;
    draft_output: string | null;
    connector_action_status: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id,
            workflow_id,
            status,
            run_mode,
            scheduled_for,
            strategy_output,
            waiting_for_strategy_approval,
            draft_output,
            connector_action_status,
            created_at,
            updated_at
     FROM workflow_runs
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [runId, auth.tenantId, auth.userId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Loop run not found");
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    runMode: row.run_mode,
    scheduledFor: row.scheduled_for,
    strategyOutput: row.strategy_output,
    waitingForStrategyApproval: row.waiting_for_strategy_approval,
    draftOutput: row.draft_output,
    connectorActionStatus: row.connector_action_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listLoopRunComments(auth: AuthContext, runId: string): Promise<Array<{
  id: string;
  taskId: string | null;
  author: string;
  body: string;
  createdAt: string;
}>> {
  await assertRunAccess(auth, runId);
  const result = await pool.query<LoopRunComment>(
    `SELECT id, task_id, author, body, created_at
     FROM loop_run_comments
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY created_at ASC`,
    [runId, auth.tenantId, auth.userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
  }));
}

export async function executeLoopWorkflow(input: {
  auth: AuthContext;
  workflowId: string;
  runMode: "manual" | "scheduled";
  scheduledFor?: string | null;
}): Promise<{ runId: string; status: string; draftRequired: boolean; finalOutput: string; strategyOutput: string }> {
  const workflow = await loadWorkflow(input.auth, input.workflowId);
  const definition = readLoopDefinition(workflow.metadata_json);

  const runId = randomUUID();
  await pool.query(
    `INSERT INTO workflow_runs
     (id, tenant_id, user_id, workflow_id, run_mode, status, scheduled_for, draft_output, connector_action_status, metadata_json)
     VALUES ($1, $2, $3, $4, $5, 'running', $6::timestamptz, NULL, 'not_required', $7::jsonb)`,
    [
      runId,
      input.auth.tenantId,
      input.auth.userId,
      workflow.id,
      input.runMode,
      input.scheduledFor ?? null,
      JSON.stringify({
        loop_definition_version: definition.definitionVersion,
        scheduler_target: definition.schedulerTarget,
      }),
    ]
  );

  try {
    const strategy = await runCeoStrategyHeartbeat(runId);
    return {
      runId,
      status: strategy.status,
      draftRequired: false,
      finalOutput: strategy.strategyOutput,
      strategyOutput: strategy.strategyOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE workflow_runs
       SET status = 'failed',
           waiting_for_strategy_approval = FALSE,
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`,
      [
        runId,
        input.auth.tenantId,
        input.auth.userId,
        JSON.stringify({ loop_executor: { failedAt: new Date().toISOString(), error: { message } } }),
      ]
    );
    throw error;
  }
}
