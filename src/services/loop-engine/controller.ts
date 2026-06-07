/**
 * controller.ts — Goal-evaluated agent controller for the agentic loop engine.
 */

import { z } from "zod";
import { pool } from "../../infrastructure/db/index.js";
import { runLoopAgent } from "../loop-executor/agent-runner.js";
import { applyEmailApprovalResult, persistBuiltEmailTemplate } from "../loop-executor/approval.js";
import { isEmailBuildAgent } from "../loop-executor/agent-responsibilities.js";
import { extractPrimaryContentFromComments } from "../loop-executor/presets/newsletter.js";
import { authFromContext, loadRunContext } from "../loop-executor/run-context.js";
import { scheduleHeartbeat } from "../loop-executor/run-heartbeat.js";
import {
  insertComment,
  insertEvent,
  loadRunArtifacts,
  loadRunComments,
  readObject,
  upsertEngineArtifact,
} from "../loop-executor/run-store.js";
import { markRunBlocked } from "../loop-executor/run-status.js";
import { getEffectiveLoopConstraints, validateAgentRoster } from "../loop-executor/tool-catalog.js";
import { loopRunAgentSchema, loopToolAssignmentSchema } from "../loop-executor/types.js";
import {
  ENGINE_MAX_AGENT_RETRIES,
  assertDeliveryRouting,
  isEngineV3Definition,
} from "./contracts.js";
import { evaluateAgentGoal } from "./goal-eval.js";
import { buildGatePayload, createEngineGate } from "./gates.js";
import {
  buildAgentHandoff,
  hasRequiredRunInputs,
  isInputValidationAgent,
  loadRunMemory,
} from "./run-memory.js";

function readAgentSpec(
  task: { agent_spec: unknown; agent_id: string; agent_name: string; tool_key: string; assigned_tools: unknown },
  taskInput: Record<string, unknown>,
) {
  const fromColumn = readObject(task.agent_spec);
  if (typeof fromColumn.id === "string") {
    return loopRunAgentSchema.parse(fromColumn);
  }
  const fromInput = readObject(taskInput.agent);
  if (typeof fromInput.id === "string") {
    return loopRunAgentSchema.parse(fromInput);
  }
  return loopRunAgentSchema.parse({
    id: task.agent_id,
    name: task.agent_name,
    task: typeof fromInput.task === "string" ? fromInput.task : task.tool_key,
    tools: [],
  });
}

function readAssignedTools(
  task: { assigned_tools: unknown },
  agentSpec: ReturnType<typeof readAgentSpec>,
) {
  if (Array.isArray(task.assigned_tools) && task.assigned_tools.length > 0) {
    return z.array(loopToolAssignmentSchema).parse(task.assigned_tools);
  }
  return agentSpec.tools;
}

async function collectPriorAgentArtifacts(
  context: Awaited<ReturnType<typeof loadRunContext>>,
  agentSpec: ReturnType<typeof readAgentSpec>,
) {
  const artifacts = await loadRunArtifacts(context);
  const byId = new Map(artifacts.map((row) => [row.artifact_id as string, row]));
  const children = context.definition.agentGraph?.children ?? [];
  const priorOutputs: Record<string, unknown> = {};

  for (const child of children) {
    if (!child.outputArtifactId || child.id === agentSpec.id) continue;
    const artifact = byId.get(child.outputArtifactId);
    if (artifact) {
      priorOutputs[child.id] = {
        artifactId: child.outputArtifactId,
        body: artifact.body,
        data: artifact.data_json,
      };
    }
  }

  return priorOutputs;
}

async function buildStructuredInput(context: Awaited<ReturnType<typeof loadRunContext>>, agentSpec: ReturnType<typeof readAgentSpec>) {
  const [runMemory, priorOutputs] = await Promise.all([
    loadRunMemory(context),
    collectPriorAgentArtifacts(context, agentSpec),
  ]);
  return buildAgentHandoff(agentSpec, runMemory, priorOutputs);
}

function formatStructuredInputBlock(structuredInput: Record<string, unknown>): string {
  if (Object.keys(structuredInput).length === 0) return "";
  const lines = [
    "Structured input from prior agents (use this instead of re-parsing prior comments):",
  ];
  if (typeof structuredInput.sprint_notes === "string" && structuredInput.sprint_notes.trim()) {
    lines.push("", "Operator-provided sprint_notes:", structuredInput.sprint_notes.trim());
  }
  lines.push("", JSON.stringify(structuredInput, null, 2));
  return lines.join("\n");
}

async function loadNextTask(context: Awaited<ReturnType<typeof loadRunContext>>, currentSeq: number) {
  const result = await pool.query(
    `SELECT * FROM loop_run_tasks
     WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3 AND seq = $4 LIMIT 1`,
    [context.runId, context.tenantId, context.userId, currentSeq + 1],
  );
  return result.rows[0] ?? null;
}

async function checkoutTask(runId: string, taskId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT t.* FROM loop_run_tasks t
       JOIN workflow_runs r ON r.id = t.workflow_run_id
       WHERE t.workflow_run_id = $1 AND t.id = $2 AND t.status = 'todo'
         AND r.status IN ('strategy_approved', 'running')
         AND NOT EXISTS (
           SELECT 1 FROM loop_run_gates g
           WHERE g.workflow_run_id = r.id AND g.status = 'pending'
         )
         AND NOT EXISTS (
           SELECT 1 FROM loop_run_tasks t2
           WHERE t2.workflow_run_id = r.id AND t2.status = 'in_progress'
         )
       FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
      [runId, taskId],
    );
    const task = result.rows[0];
    if (!task) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE loop_run_tasks SET status = 'in_progress', checkout_locked_at = NOW(),
       started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [task.id],
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

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|rate limit|temporarily unavailable|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

export function shouldUseEngineController(definition: { engineVersion?: string; builderMeta?: { engineVersion?: string } }): boolean {
  return isEngineV3Definition(definition as import("../loop-executor/types.js").LoopDefinition);
}

export async function runEngineAgentStep(runId: string, taskId: string): Promise<{ status: string; taskId: string }> {
  const context = await loadRunContext(runId);
  if (!shouldUseEngineController(context.definition)) {
    throw new Error("Run is not using the agentic loop engine");
  }

  if (context.definition.delivery) {
    assertDeliveryRouting(context.definition.delivery);
  }

  const task = await checkoutTask(runId, taskId);
  if (!task) {
    const fresh = await loadRunContext(runId);
    return { status: fresh.runStatus, taskId };
  }

  await pool.query(
    `UPDATE workflow_runs SET status = 'running', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'strategy_approved'`,
    [context.runId, context.tenantId, context.userId],
  );

  try {
    await insertEvent({
      context,
      taskId: task.id,
      eventType: "agent_checked_out",
      payload: { agentId: task.agent_id, seq: task.seq, engine: "loop_engine_v3" },
    });

    const comments = await loadRunComments(context);
    const taskInput = readObject(task.input_json);
    const agentSpec = readAgentSpec(task, taskInput);
    const assignedTools = readAssignedTools(task, agentSpec);
    const auth = authFromContext(context);

    if (assignedTools.some((tool) => tool.ref === "internal.resend_broadcast")) {
      throw new Error("Broadcast delivery runs through the delivery heartbeat after gates and approval.");
    }

    const connectorValidation = await validateAgentRoster({
      agents: [{ tools: assignedTools }],
      definition: getEffectiveLoopConstraints(context.definition),
      auth,
      strictConnectors: true,
    });
    if (!connectorValidation.ok) {
      const message = (connectorValidation.issues ?? []).map((issue) => issue.message).join("; ");
      throw new Error(message);
    }

    const runMemory = await loadRunMemory(context);
    const structuredInput = buildAgentHandoff(
      agentSpec,
      runMemory,
      await collectPriorAgentArtifacts(context, agentSpec),
    );
    const structuredBlock = formatStructuredInputBlock(structuredInput);

    if (isInputValidationAgent(agentSpec) && hasRequiredRunInputs(context.definition, runMemory)) {
      const keys = Object.keys(runMemory.inputs);
      const result = {
        text: [
          "valid=true",
          `missing=[]`,
          `note=Required inputs provided by operator: ${keys.join(", ")}`,
        ].join("\n"),
        data: {
          mode: "run_memory_short_circuit",
          valid: true,
          missing: [],
          provided: runMemory.inputs,
        },
      };
      const goalEval = await evaluateAgentGoal({
        agent: agentSpec,
        result,
        definition: context.definition,
        runMemory,
        skipLlmJudge: true,
      });
      const outputPayload = {
        text: result.text,
        data: result.data,
        draft: null,
        approvalRequest: null,
        artifactBody: null,
        emailTemplate: null,
        goalEval,
      };
      await insertComment({ context, taskId: task.id, author: task.agent_id, body: result.text });
      await pool.query(
        `UPDATE loop_run_tasks SET status = 'done', output_json = $4::jsonb, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [task.id, context.tenantId, context.userId, JSON.stringify(outputPayload)],
      );
      if (agentSpec.outputArtifactId) {
        await upsertEngineArtifact({
          context,
          artifactId: agentSpec.outputArtifactId,
          kind: "structured_output",
          label: agentSpec.name,
          body: result.text,
          data: { valid: true, missing: [], provided: runMemory.inputs },
          stageId: agentSpec.id,
        });
      }
      const nextTask = await loadNextTask(context, task.seq);
      if (nextTask) {
        await scheduleHeartbeat({
          tenantId: context.tenantId,
          userId: context.userId,
          runId,
          jobType: "agent",
          taskId: nextTask.id,
        });
      } else {
        await scheduleHeartbeat({
          tenantId: context.tenantId,
          userId: context.userId,
          runId,
          jobType: "ceo_finalize",
        });
      }
      return { status: "running", taskId: task.id };
    }

    const result = await runLoopAgent({
      auth,
      goal: context.definition.goal,
      agent: agentSpec,
      assignedTools,
      draftPolicy: context.definition.draftPolicy,
      priorComments: [
        ...comments.map((comment) => ({
          author: comment.author,
          body: comment.body,
          taskId: comment.task_id,
          createdAt: comment.created_at,
        })),
        ...(structuredBlock
          ? [{ author: "controller", body: structuredBlock, taskId: null, createdAt: new Date().toISOString() }]
          : []),
      ],
      runId: context.runId,
      workflowId: context.workflowId,
      workflowTitle: context.workflowTitle,
      definition: context.definition,
    });

    const goalEval = await evaluateAgentGoal({
      agent: agentSpec,
      result,
      definition: context.definition,
      runMemory,
    });

    await insertComment({
      context,
      taskId: task.id,
      author: task.agent_id,
      body: result.text,
    });

    const outputPayload = {
      text: result.text,
      data: result.data,
      draft: result.draft ?? null,
      approvalRequest: result.approvalRequest ?? null,
      artifactBody: result.artifactBody ?? null,
      emailTemplate: result.emailTemplate ?? null,
      goalEval,
    };

    if (goalEval.status === "fail") {
      const priorErrors = readObject(task.error_json);
      const retryCount = typeof priorErrors.retryCount === "number" ? priorErrors.retryCount + 1 : 1;
      if (retryCount < ENGINE_MAX_AGENT_RETRIES) {
        await pool.query(
          `UPDATE loop_run_tasks SET status = 'todo', error_json = $4::jsonb, checkout_locked_at = NULL, updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
          [task.id, context.tenantId, context.userId, JSON.stringify({ message: goalEval.reason, retryCount })],
        );
        await scheduleHeartbeat({
          tenantId: context.tenantId,
          userId: context.userId,
          runId,
          jobType: "agent",
          taskId: task.id,
        });
        return { status: "running", taskId: task.id };
      }

      await pool.query(
        `UPDATE loop_run_tasks SET status = 'blocked', output_json = $4::jsonb, error_json = $5::jsonb,
         completed_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [
          task.id,
          context.tenantId,
          context.userId,
          JSON.stringify(outputPayload),
          JSON.stringify({ message: goalEval.reason, code: "goal_eval_failed" }),
        ],
      );
      await markRunBlocked(runId, goalEval.reason, task.id);
      return { status: "blocked", taskId: task.id };
    }

    if (goalEval.status === "needs_input") {
      const gateType = goalEval.gateType ?? agentSpec.gate?.type ?? "missing_input";
      const question = gateType === agentSpec.gate?.type
        ? (agentSpec.gate?.question ?? goalEval.reason)
        : goalEval.reason;
      await pool.query(
        `UPDATE loop_run_tasks SET status = 'blocked', output_json = $4::jsonb, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [task.id, context.tenantId, context.userId, JSON.stringify(outputPayload)],
      );
      await createEngineGate({
        context,
        taskId: task.id,
        agent: agentSpec,
        gateType,
        question,
        payload: buildGatePayload({
          gateType,
          resultData: result.data,
          resultText: result.text,
          definition: context.definition,
        }),
      });
      return { status: "waiting_for_gate", taskId: task.id };
    }

    await pool.query(
      `UPDATE loop_run_tasks SET status = 'done', output_json = $4::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [task.id, context.tenantId, context.userId, JSON.stringify(outputPayload)],
    );

    if (agentSpec.outputArtifactId) {
      await upsertEngineArtifact({
        context,
        artifactId: agentSpec.outputArtifactId,
        kind: "structured_output",
        label: agentSpec.name,
        body: result.text,
        data: {
          result: result.data,
          goalEval,
          toolRefs: assignedTools.map((tool) => tool.ref),
        },
        stageId: agentSpec.id,
      });
    }

    await insertEvent({
      context,
      taskId: task.id,
      eventType: "agent_completed",
      payload: {
        agentId: task.agent_id,
        seq: task.seq,
        engine: "loop_engine_v3",
        goalStatus: goalEval.status,
      },
    });

    if (result.emailApprovalSent && result.approvalRequest && result.artifactBody) {
      await applyEmailApprovalResult({
        context,
        taskId: task.id,
        approvalRequest: result.approvalRequest,
        artifactBody: result.artifactBody,
        emailTemplate: result.emailTemplate,
      });
      return { status: "waiting_for_email_approval", taskId: task.id };
    }

    if (result.emailTemplate?.html && isEmailBuildAgent(agentSpec, false)) {
      const artifactBody = result.artifactBody
        ?? extractPrimaryContentFromComments([
          ...comments.map((comment) => ({ author: comment.author, body: comment.body })),
          { author: task.agent_id, body: result.text },
        ]);
      if (artifactBody.trim()) {
        await persistBuiltEmailTemplate({
          context,
          taskId: task.id,
          artifactBody,
          emailTemplate: result.emailTemplate,
        });
      }
    }

    const deliveryProvider = context.definition.delivery?.provider?.trim().toLowerCase();
    const isDeliveryAgent = assignedTools.some((tool) =>
      tool.ref === deliveryProvider
      || tool.ref === "composio.gmail.send_email"
      || tool.ref === "internal.resend_broadcast",
    );

    if (isDeliveryAgent && agentSpec.gate?.type === "pre_send") {
      await createEngineGate({
        context,
        taskId: task.id,
        agent: agentSpec,
        gateType: "pre_send",
        question: agentSpec.gate.question,
        payload: buildGatePayload({
          gateType: "pre_send",
          resultData: result.data,
          resultText: result.text,
          definition: context.definition,
        }),
      });
      return { status: "waiting_for_gate", taskId: task.id };
    }

    const nextTask = await loadNextTask(context, task.seq);
    if (nextTask) {
      await scheduleHeartbeat({
        tenantId: context.tenantId,
        userId: context.userId,
        runId,
        jobType: "agent",
        taskId: nextTask.id,
      });
    } else {
      await scheduleHeartbeat({
        tenantId: context.tenantId,
        userId: context.userId,
        runId,
        jobType: "ceo_finalize",
      });
    }

    return { status: "done", taskId: task.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isRetryableError(error)) {
      await pool.query(
        `UPDATE loop_run_tasks SET status = 'todo', error_json = $4::jsonb, checkout_locked_at = NULL, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [task.id, context.tenantId, context.userId, JSON.stringify({ message, retryable: true })],
      );
      throw error;
    }
    await pool.query(
      `UPDATE loop_run_tasks SET status = 'blocked', error_json = $4::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [task.id, context.tenantId, context.userId, JSON.stringify({ message })],
    );
    await markRunBlocked(runId, `Agent ${task.agent_name} blocked: ${message}`, task.id);
    return { status: "blocked", taskId: task.id };
  }
}
