/**
 * executor.ts — Loop run orchestration (heartbeats, queries, run lifecycle).
 *
 * Design-time workflow CRUD: creator.ts
 * Approvals: approval.ts | Gates: gates.ts | Delivery: distribution.ts
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import { pool } from "../../infrastructure/db/index.js";
import { deliverStatusNotification } from "../channels.js";
import { runLoopAgent } from "./agent-runner.js";
import { applyEmailApprovalResult } from "./approval.js";
import { advanceDynamicRunAfterSeq } from "./gates.js";
import { isDynamicPlanDefinition, normalizeRosterAgents, readLoopDefinition } from "./plan.js";
import { extractPrimaryContentFromComments, sanitizeSubscriberBody } from "./presets/newsletter.js";
import { resolveLoopPreset } from "./presets/registry.js";
import {
  assertRunAccess,
  authFromContext,
  loadRunContext,
  loadWorkflow,
  mergeLoopExecutorMeta,
  readLoopExecutorMeta,
} from "./run-context.js";
import { scheduleHeartbeat } from "./run-heartbeat.js";
import { synthesizeFinalOutput } from "./run-llm.js";
import { insertComment, insertEvent, insertOrUpdateArtifact, loadRunArtifacts, loadRunComments, readObject } from "./run-store.js";
import { buildCeoStrategyOutput, materializeTasksFromRoster } from "./run-strategy.js";
import { getEffectiveLoopConstraints, listAllowedLoopTools, validateAgentRoster } from "./tool-catalog.js";
import { loopRunAgentSchema, loopToolAssignmentSchema } from "./types.js";

import { markRunBlocked } from "./run-status.js";

export { markRunBlocked } from "./run-status.js";

function readAgentSpec(task: { agent_spec: unknown; agent_id: string; agent_name: string; tool_key: string; assigned_tools: unknown }, taskInput: Record<string, unknown>) {
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

function readAssignedTools(task, agentSpec) {
    if (Array.isArray(task.assigned_tools) && task.assigned_tools.length > 0) {
        return z.array(loopToolAssignmentSchema).parse(task.assigned_tools);
    }
    return agentSpec.tools;
}

export async function runCeoStrategyHeartbeat(runId: string) {
    const context = await loadRunContext(runId);
    const auth = authFromContext(context);
    const ceoOutput = await buildCeoStrategyOutput(context);
    const preset = resolveLoopPreset(context.definition);
    const rosterValidation = await validateAgentRoster({
        agents: ceoOutput.agents,
        definition: getEffectiveLoopConstraints(context.definition),
        auth,
        strictConnectors: false,
    });
    if (!rosterValidation.ok) {
        const message = (rosterValidation.issues ?? []).map((issue) => issue.message).join("; ");
        throw new Error(`CEO proposed invalid roster: ${message}`);
    }
    if (preset) {
        await materializeTasksFromRoster({ context, roster: ceoOutput.agents, strategyOutput: ceoOutput.strategyText });
        const firstTask = await pool.query<{ id: string }>(
            `SELECT id FROM loop_run_tasks WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3
             AND status = 'todo' ORDER BY seq ASC LIMIT 1`,
            [context.runId, context.tenantId, context.userId]
        );
        const firstTaskId = firstTask.rows[0]?.id ?? null;
        const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
            approvedRoster: ceoOutput.agents,
            rosterApprovedAt: new Date().toISOString(),
            strategyReadyAt: new Date().toISOString(),
        });
        await pool.query(`UPDATE workflow_runs
         SET status = 'strategy_approved',
             strategy_output = $4,
             waiting_for_strategy_approval = FALSE,
             metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb,
             updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3`, [
            context.runId,
            context.tenantId,
            context.userId,
            ceoOutput.strategyText,
            JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
        ]);
        await insertEvent({
            context,
            eventType: "preset_roster_started",
            payload: { presetId: preset.id, firstTaskId, agentCount: ceoOutput.agents.length },
        });
        if (firstTaskId) {
            await scheduleHeartbeat({
                tenantId: context.tenantId,
                userId: context.userId,
                runId: context.runId,
                jobType: "agent",
                taskId: firstTaskId,
            });
        } else {
            await scheduleHeartbeat({
                tenantId: context.tenantId,
                userId: context.userId,
                runId: context.runId,
                jobType: "ceo_finalize",
            });
        }
        return {
            runId: context.runId,
            status: "strategy_approved",
            strategyOutput: ceoOutput.strategyText,
            approvedRoster: ceoOutput.agents,
        };
    }
    await insertComment({
        context,
        author: "ceo",
        body: ceoOutput.strategyText,
    });
    await insertEvent({
        context,
        eventType: "ceo_strategy_ready",
        payload: { agentCount: ceoOutput.agents.length },
    });
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
        proposedRoster: ceoOutput.agents,
        strategyReadyAt: new Date().toISOString(),
    });
    await pool.query(`UPDATE workflow_runs
     SET status = 'waiting_for_strategy_approval',
         strategy_output = $4,
         waiting_for_strategy_approval = TRUE,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
        context.runId,
        context.tenantId,
        context.userId,
        ceoOutput.strategyText,
        JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]);
    await deliverStatusNotification({
        auth: auth,
        title: `${context.workflowTitle} strategy is ready`,
        body: "Review the proposed roster and approve the strategy to continue this loop.",
        metadata: { workflowId: context.workflowId, runId: context.runId, status: "waiting_for_strategy_approval" },
    }).catch(() => undefined);
    return {
        runId: context.runId,
        status: "waiting_for_strategy_approval",
        strategyOutput: ceoOutput.strategyText,
        proposedRoster: ceoOutput.agents,
    };
}

async function checkoutTask(runId, taskId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(`SELECT t.*
       FROM loop_run_tasks t
       JOIN workflow_runs r ON r.id = t.workflow_run_id
       WHERE t.workflow_run_id = $1
         AND t.id = $2
         AND t.status = 'todo'
         AND r.status IN ('strategy_approved', 'running')
       FOR UPDATE OF t SKIP LOCKED
       LIMIT 1`, [runId, taskId]);
        const task = result.rows[0];
        if (!task) {
            await client.query("COMMIT");
            return null;
        }
        await client.query(`UPDATE loop_run_tasks
       SET status = 'in_progress',
           checkout_locked_at = NOW(),
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`, [task.id]);
        await client.query("COMMIT");
        return { ...task, status: "in_progress" };
    }
    catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
    finally {
        client.release();
    }
}

async function loadNextTask(context, currentSeq) {
    const result = await pool.query(`SELECT *
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND seq = $4
     LIMIT 1`, [context.runId, context.tenantId, context.userId, currentSeq + 1]);
    return result.rows[0] ?? null;
}

function isRetryableLoopAgentError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out|timeout|aborted|aborterror|rate limit|temporarily unavailable|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

export async function runAgentHeartbeat(runId, taskId) {
    const context = await loadRunContext(runId);
    const task = await checkoutTask(runId, taskId);
    if (!task) {
        throw new Error(`Agent task ${taskId} could not be checked out (run status: ${context.runStatus})`);
    }
    await pool.query(`UPDATE workflow_runs
     SET status = 'running',
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND status = 'strategy_approved'`, [context.runId, context.tenantId, context.userId]);
    try {
        await insertEvent({
            context,
            taskId: task.id,
            eventType: "agent_checked_out",
            payload: { agentId: task.agent_id, seq: task.seq },
        });
        const comments = await loadRunComments(context);
        const taskInput = readObject(task.input_json);
        const agentSpec = readAgentSpec(task, taskInput);
        const assignedTools = readAssignedTools(task, agentSpec);
        const stageRaw = readObject(taskInput.stage);
        const stage = stageRaw.kind === "agent" || stageRaw.kind === "external_action"
            ? stageRaw
            : null;
        const auth = authFromContext(context);
        if (isDynamicPlanDefinition(context.definition) && stage?.kind === "external_action") {
            if (stage.toolRef !== "internal.resend_broadcast") {
                throw new Error(`Unsupported dynamic external action tool: ${stage.toolRef}`);
            }
            const artifacts = await loadRunArtifacts(context);
            const byId = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
            const stageArtifacts = stage.inputArtifactIds.map((artifactId) => byId.get(artifactId)).filter((artifact) => Boolean(artifact));
            const contactArtifact = stageArtifacts.find((artifact) => artifact.kind === "contact_list" || artifact.kind === "recipient_list")
                ?? artifacts.find((artifact) => artifact.kind === "contact_list" || artifact.kind === "recipient_list");
            const contentArtifact = stageArtifacts.find((artifact) => artifact.id !== contactArtifact?.id)
                ?? artifacts.find((artifact) => artifact.kind !== "contact_list" && artifact.kind !== "recipient_list" && Boolean(artifact.body?.trim()));
            const resultArtifact = context.definition.plan.artifacts.find((artifact) => artifact.kind === "delivery_result");
            const contactsRaw = readObject(contactArtifact?.data_json).contacts;
            const contacts = Array.isArray(contactsRaw)
                ? contactsRaw.map((row) => readObject(row)).map((row) => ({
                    email: typeof row.email === "string" ? row.email : "",
                    ...(typeof row.name === "string" ? { name: row.name } : {}),
                })).filter((row) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))
                : [];
            if (!contentArtifact?.body?.trim())
                throw new Error("Approved content artifact is required before broadcast");
            if (contacts.length === 0)
                throw new Error("Recipient artifact is required before broadcast");
            const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
                deliveryContentBody: contentArtifact.body,
                deliveryContentArtifactId: contentArtifact.artifact_id,
                deliveryResultArtifactId: resultArtifact?.id ?? null,
                deliveryRecipients: {
                    uploadedAt: new Date().toISOString(),
                    contacts,
                    recipientCount: contacts.length,
                },
                deliveryAction: {
                    kind: "send_broadcast",
                    status: "in_progress",
                    startedAt: new Date().toISOString(),
                    recipientCount: contacts.length,
                    successCount: 0,
                    failureCount: 0,
                },
            });
            await insertComment({
                context,
                taskId: task.id,
                author: task.agent_id,
                body: `Prepared ${contacts.length} recipients for ${stage.label}.`,
            });
            await pool.query(`UPDATE loop_run_tasks
         SET status = 'done',
             output_json = $4::jsonb,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3`, [
                task.id,
                context.tenantId,
                context.userId,
                JSON.stringify({ text: `Prepared broadcast for ${contacts.length} recipients.`, stage }),
            ]);
            await pool.query(`UPDATE workflow_runs
         SET status = 'executing_action',
             connector_action_status = 'distribution_started',
             metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
             updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3`, [
                context.runId,
                context.tenantId,
                context.userId,
                JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
            ]);
            await insertEvent({
                context,
                taskId: task.id,
                eventType: "external_action_started",
                payload: { stageId: stage.id, toolRef: stage.toolRef, recipientCount: contacts.length },
            });
            await scheduleHeartbeat({
                tenantId: context.tenantId,
                userId: context.userId,
                runId: context.runId,
                jobType: "distribution",
            });
            return { status: "executing_action", taskId: task.id };
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
        const result = await runLoopAgent({
            auth,
            goal: context.definition.goal,
            agent: agentSpec,
            assignedTools,
            draftPolicy: context.definition.draftPolicy,
            priorComments: comments.map((comment) => ({
                author: comment.author,
                body: comment.body,
                taskId: comment.task_id,
                createdAt: comment.created_at,
            })),
            runId: context.runId,
            workflowId: context.workflowId,
            workflowTitle: context.workflowTitle,
            definition: context.definition,
        });
        await insertComment({
            context,
            taskId: task.id,
            author: task.agent_id,
            body: result.text,
        });
        await pool.query(`UPDATE loop_run_tasks
       SET status = 'done',
           output_json = $4::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3`, [
            task.id,
            context.tenantId,
            context.userId,
            JSON.stringify({
                text: result.text,
                data: result.data,
                draft: result.draft ?? null,
                approvalRequest: result.approvalRequest ?? null,
                artifactBody: result.artifactBody ?? null,
            }),
        ]);
        await insertEvent({
            context,
            taskId: task.id,
            eventType: "agent_completed",
            payload: {
                agentId: task.agent_id,
                seq: task.seq,
                hasDraft: Boolean(result.draft),
                emailApprovalSent: Boolean(result.emailApprovalSent),
            },
        });
        if (isDynamicPlanDefinition(context.definition) && stage?.kind === "agent" && stage.outputArtifactId) {
            await insertOrUpdateArtifact({
                context,
                stage,
                artifactId: stage.outputArtifactId,
                body: result.text,
                data: {
                    result: result.data,
                    draft: result.draft ?? null,
                    toolRefs: assignedTools.map((tool) => tool.ref),
                },
            });
        }
        if (result.emailApprovalSent && result.approvalRequest && result.artifactBody) {
            await applyEmailApprovalResult({
                context,
                taskId: task.id,
                approvalRequest: result.approvalRequest,
                artifactBody: result.artifactBody,
            });
            return { status: "waiting_for_email_approval", taskId: task.id };
        }
        if (isDynamicPlanDefinition(context.definition)) {
            const advanced = await advanceDynamicRunAfterSeq(context, task.seq);
            return { status: advanced.status, taskId: task.id };
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
        }
        else {
            await scheduleHeartbeat({
                tenantId: context.tenantId,
                userId: context.userId,
                runId,
                jobType: "ceo_finalize",
            });
        }
        return { status: "done", taskId: task.id };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isRetryableLoopAgentError(error)) {
            await pool.query(`UPDATE loop_run_tasks
         SET status = 'todo',
             error_json = $4::jsonb,
             checkout_locked_at = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3`, [
                task.id,
                context.tenantId,
                context.userId,
                JSON.stringify({ message, retryable: true, retryReleasedAt: new Date().toISOString() }),
            ]);
            await insertEvent({
                context,
                taskId: task.id,
                eventType: "agent_retry_scheduled",
                payload: { agentId: task.agent_id, seq: task.seq, message },
            });
            throw error;
        }
        await pool.query(`UPDATE loop_run_tasks
       SET status = 'blocked',
           error_json = $4::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`, [task.id, context.tenantId, context.userId, JSON.stringify({ message })]);
        await markRunBlocked(runId, `Agent ${task.agent_name} blocked: ${message}`, task.id);
        return { status: "blocked", taskId: task.id };
    }
}

export async function runCeoFinalizeHeartbeat(runId) {
    const context = await loadRunContext(runId);
    const tasks = await pool.query(`SELECT *
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY seq ASC`, [context.runId, context.tenantId, context.userId]);
    const blocked = tasks.rows.find((task) => task.status === "blocked");
    if (blocked) {
        const message = `Agent ${blocked.agent_name} is blocked. Review the task comment thread before continuing.`;
        await markRunBlocked(runId, message, blocked.id);
        return { runId, status: "blocked", finalOutput: message };
    }
    const comments = await loadRunComments(context);
    const finalOutput = context.definition.presetId === "newsletter" || context.definition.presetId === "newsletter_v1"
        ? extractPrimaryContentFromComments(comments.map((comment) => ({ author: comment.author, body: comment.body })))
        : await synthesizeFinalOutput(context, comments);
    const drafts = tasks.rows
        .map((task) => readObject(task.output_json).draft)
        .filter((draft) => Boolean(draft && typeof draft === "object"));
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
    await pool.query(`UPDATE workflow_runs
     SET status = $4,
         waiting_for_strategy_approval = FALSE,
         draft_output = $5,
         connector_action_status = $6,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $7::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
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
    ]);
    await deliverStatusNotification({
        auth: authFromContext(context),
        title: draftRequired ? `${context.workflowTitle} draft is ready` : `${context.workflowTitle} completed`,
        body: draftRequired
            ? "A draft is ready for final approval."
            : "This loop completed successfully.",
        metadata: { workflowId: context.workflowId, runId: context.runId, status },
    }).catch(() => undefined);
    return { runId: context.runId, status, finalOutput };
}

export async function listLoopRunArtifacts(auth, runId) {
    await assertRunAccess(auth, runId);
    const context = await loadRunContext(runId);
    const artifacts = await loadRunArtifacts(context);
    return artifacts.map((artifact) => ({
        id: artifact.id,
        stageId: artifact.stage_id,
        artifactId: artifact.artifact_id,
        kind: artifact.kind,
        label: artifact.label,
        body: artifact.body,
        data: artifact.data_json,
        createdAt: artifact.created_at,
        updatedAt: artifact.updated_at,
    }));
}

export async function rerunLoopRunTask(input) {
    await assertRunAccess(input.auth, input.runId);
    const context = await loadRunContext(input.runId);
    const taskResult = await pool.query(`SELECT id, seq, agent_id, agent_name, status
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND id = $4
     LIMIT 1`, [context.runId, context.tenantId, context.userId, input.taskId]);
    const task = taskResult.rows[0];
    if (!task) {
        throw new Error("Task not found");
    }
    if (task.status === "in_progress") {
        throw new Error("Task is already running");
    }
    const rerunAt = new Date().toISOString();
    await pool.query(`UPDATE loop_run_tasks
     SET status = 'todo',
         checkout_locked_at = NULL,
         output_json = '{}'::jsonb,
         error_json = '{}'::jsonb,
         started_at = NULL,
         completed_at = NULL,
         updated_at = NOW()
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND seq >= $4`, [context.runId, context.tenantId, context.userId, task.seq]);
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
        resumedAt: rerunAt,
        rerunTaskId: task.id,
        rerunTaskSeq: task.seq,
    });
    await pool.query(`UPDATE workflow_runs
     SET status = 'running',
         waiting_for_strategy_approval = FALSE,
         draft_output = NULL,
         connector_action_status = NULL,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
        context.runId,
        context.tenantId,
        context.userId,
        JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]);
    await insertEvent({
        context,
        taskId: task.id,
        eventType: "task_rerun_started",
        payload: {
            taskId: task.id,
            seq: task.seq,
            agentId: task.agent_id,
            agentName: task.agent_name,
        },
    });
    const nextTask = await pool.query(`SELECT id
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND status = 'todo'
       AND seq >= $4
     ORDER BY seq ASC
     LIMIT 1`, [context.runId, context.tenantId, context.userId, task.seq]);
    const nextTaskId = nextTask.rows[0]?.id ?? task.id;
    await scheduleHeartbeat({
        tenantId: context.tenantId,
        userId: context.userId,
        runId: context.runId,
        jobType: "agent",
        taskId: nextTaskId,
        resetAttempts: true,
        idempotencySuffix: `rerun-${task.id}-${Date.now()}`,
    });
    return { runId: context.runId, status: "running", taskId: nextTaskId };
}

export async function getLoopRunRoster(auth, runId) {
    await assertRunAccess(auth, runId);
    const context = await loadRunContext(runId);
    const runMeta = readLoopExecutorMeta(context.metadataJson);
    const approvedRoster = runMeta.approvedRoster ?? null;
    const editable = context.runStatus === "waiting_for_strategy_approval";
    const preset = resolveLoopPreset(context.definition);
    const proposedRoster = editable && !approvedRoster && preset
        ? preset.buildRoster(context.definition.goal).agents
        : runMeta.proposedRoster ?? [];
    const activeRoster = approvedRoster ?? proposedRoster;
    const constraints = getEffectiveLoopConstraints(context.definition);
    const rosterValidation = activeRoster.length
        ? await validateAgentRoster({ agents: activeRoster, definition: constraints, auth, strictConnectors: false })
        : { ok: true as const, issues: [] as Array<{ ref?: string; code: string; message: string }> };
    const validationIssues = rosterValidation.ok ? [] : rosterValidation.issues;
    const toolCatalog = listAllowedLoopTools(context.definition);
    return {
        proposedRoster,
        approvedRoster,
        editable,
        toolCatalog,
        validationIssues,
    };
}

export async function updateLoopRunRoster(auth, input) {
    await assertRunAccess(auth, input.runId);
    const context = await loadRunContext(input.runId);
    if (context.runStatus !== "waiting_for_strategy_approval") {
        throw new Error(`Run is ${context.runStatus}, roster is not editable`);
    }
    const roster = normalizeRosterAgents(input.roster);
    const constraints = getEffectiveLoopConstraints(context.definition);
    const blockingValidation = await validateAgentRoster({
        agents: roster,
        definition: constraints,
        auth,
        strictConnectors: false,
    });
    if (!blockingValidation.ok) {
        return { roster, validationIssues: blockingValidation.issues };
    }
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
        approvedRoster: roster,
    });
    await pool.query(`UPDATE workflow_runs
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
        context.runId,
        context.tenantId,
        context.userId,
        JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]);
    return { roster, validationIssues: [] };
}

export async function listLoopRunTasks(auth, runId) {
    await assertRunAccess(auth, runId);
    const result = await pool.query(`SELECT t.id,
            t.seq,
            t.agent_id,
            t.agent_name,
            t.tool_key,
            t.agent_spec,
            t.assigned_tools,
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
     ORDER BY t.seq ASC`, [runId, auth.tenantId, auth.userId]);
    return result.rows.map((row) => {
        const taskRow = {
            id: row.id,
            tenant_id: auth.tenantId,
            user_id: auth.userId,
            workflow_run_id: runId,
            seq: row.seq,
            agent_id: row.agent_id,
            agent_name: row.agent_name,
            tool_key: row.tool_key,
            agent_spec: row.agent_spec,
            assigned_tools: row.assigned_tools,
            status: row.status,
            input_json: row.input_json,
            output_json: row.output_json,
        };
        const agentSpec = readAgentSpec(taskRow, readObject(row.input_json));
        const assignedTools = readAssignedTools(taskRow, agentSpec);
        return {
            id: row.id,
            seq: row.seq,
            agentId: row.agent_id,
            agentName: row.agent_name,
            toolKey: row.tool_key,
            assignedTools,
            agentSpec,
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
        };
    });
}

export async function getLoopRun(auth, runId) {
    const result = await pool.query(`SELECT id,
            workflow_id,
            status,
            run_mode,
            scheduled_for,
            strategy_output,
            waiting_for_strategy_approval,
            draft_output,
            connector_action_status,
            metadata_json,
            created_at,
            updated_at
     FROM workflow_runs
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`, [runId, auth.tenantId, auth.userId]);
    const row = result.rows[0];
    if (!row)
        throw new Error("Loop run not found");
    const meta = readLoopExecutorMeta(row.metadata_json);
    const approvalRequest = readObject(meta.approvalRequest ?? meta.publicistApproval);
    const approvalDecisionMeta = readObject(meta.approvalDecision);
    const contactList = readObject(meta.deliveryRecipients ?? meta.contactList);
    const distribution = readObject(meta.deliveryBatch ?? meta.distribution);
    const emailTemplateMeta = readObject(meta.emailTemplate);
    const deliveryEmailHtml = typeof meta.deliveryEmailHtml === "string" && meta.deliveryEmailHtml.trim()
        ? meta.deliveryEmailHtml
        : typeof emailTemplateMeta.html === "string" && emailTemplateMeta.html.trim()
            ? emailTemplateMeta.html
            : null;
    const deliveryEmailDesign = meta.deliveryEmailDesign ?? emailTemplateMeta.design ?? null;
    const deliveryEmailUpdatedAt = typeof meta.deliveryEmailUpdatedAt === "string"
        ? meta.deliveryEmailUpdatedAt
        : typeof emailTemplateMeta.updatedAt === "string"
            ? emailTemplateMeta.updatedAt
            : null;
    const pendingInputRaw = readObject(meta.pendingInput);
    const deliveryActionRaw = readObject(meta.deliveryAction);
    const recipientsRaw = Array.isArray(distribution.recipients) ? distribution.recipients : [];
    const dryRunDelivery = distribution.dryRun === true
        || (typeof distribution.broadcastId === "string" && distribution.broadcastId.startsWith("dry_broadcast_"))
        || (typeof deliveryActionRaw.broadcastId === "string" && deliveryActionRaw.broadcastId.startsWith("dry_broadcast_"));
    const requestedTo = typeof approvalRequest.to === "string" ? approvalRequest.to : null;
    const requestedAt = typeof approvalRequest.sentAt === "string" ? approvalRequest.sentAt : null;
    const approvedAt = typeof approvalDecisionMeta.approvedAt === "string"
        ? approvalDecisionMeta.approvedAt
        : typeof meta.emailApprovedAt === "string"
            ? meta.emailApprovedAt
            : typeof meta.uiApprovedAt === "string"
                ? meta.uiApprovedAt
                : null;
    const approvalChannel = typeof approvalDecisionMeta.channel === "string"
        ? approvalDecisionMeta.channel
        : typeof meta.approvalChannel === "string"
            ? meta.approvalChannel
            : null;
    const recipientCount = typeof contactList.recipientCount === "number"
        ? contactList.recipientCount
        : Array.isArray(contactList.contacts)
            ? contactList.contacts.length
            : 0;
    const pendingInput = typeof pendingInputRaw.id === "string" && typeof pendingInputRaw.kind === "string"
        ? {
            id: pendingInputRaw.id,
            kind: pendingInputRaw.kind,
            label: typeof pendingInputRaw.label === "string" ? pendingInputRaw.label : pendingInputRaw.id,
            status: pendingInputRaw.status === "submitted" ? "submitted" : "pending",
            requestedAt: typeof pendingInputRaw.requestedAt === "string" ? pendingInputRaw.requestedAt : null,
            submittedAt: typeof pendingInputRaw.submittedAt === "string" ? pendingInputRaw.submittedAt : null,
            instructions: typeof pendingInputRaw.instructions === "string" ? pendingInputRaw.instructions : null,
            schema: typeof pendingInputRaw.schema === "object" && pendingInputRaw.schema && !Array.isArray(pendingInputRaw.schema)
                ? pendingInputRaw.schema
                : null,
        }
        : null;
    const deliveryAction = typeof deliveryActionRaw.kind === "string"
        ? {
            kind: deliveryActionRaw.kind,
            status: dryRunDelivery
                ? "failed"
                : deliveryActionRaw.status === "completed" || deliveryActionRaw.status === "partial_failure" || deliveryActionRaw.status === "in_progress" || deliveryActionRaw.status === "failed" || deliveryActionRaw.status === "syncing_contacts"
                ? deliveryActionRaw.status
                : "pending",
            startedAt: typeof deliveryActionRaw.startedAt === "string" ? deliveryActionRaw.startedAt : null,
            completedAt: typeof deliveryActionRaw.completedAt === "string" ? deliveryActionRaw.completedAt : null,
            recipientCount: typeof deliveryActionRaw.recipientCount === "number" ? deliveryActionRaw.recipientCount : 0,
            successCount: dryRunDelivery ? 0 : typeof deliveryActionRaw.successCount === "number" ? deliveryActionRaw.successCount : 0,
            failureCount: dryRunDelivery
                ? (typeof deliveryActionRaw.recipientCount === "number" ? deliveryActionRaw.recipientCount : recipientCount)
                : typeof deliveryActionRaw.failureCount === "number" ? deliveryActionRaw.failureCount : 0,
            broadcastId: typeof deliveryActionRaw.broadcastId === "string" ? deliveryActionRaw.broadcastId : null,
        }
        : null;
    const normalizedRunStatus = dryRunDelivery && row.status === "completed" ? "blocked" : row.status;
    return {
        id: row.id,
        workflowId: row.workflow_id,
        status: normalizedRunStatus,
        runMode: row.run_mode,
        scheduledFor: row.scheduled_for,
        strategyOutput: row.strategy_output,
        waitingForStrategyApproval: row.waiting_for_strategy_approval,
        draftOutput: row.draft_output,
        connectorActionStatus: dryRunDelivery && row.connector_action_status === "completed" ? "partial_failure" : row.connector_action_status,
        pendingInput,
        deliveryAction,
        stats: {
            approval: requestedTo || requestedAt || approvedAt || approvalChannel
                ? { requestedTo, requestedAt, approvedAt, channel: approvalChannel }
                : null,
            contacts: contactList.uploadedAt || recipientCount > 0
                ? {
                    uploadedAt: typeof contactList.uploadedAt === "string" ? contactList.uploadedAt : null,
                    recipientCount,
                }
                : null,
            delivery: distribution.sentAt || typeof distribution.successCount === "number" || typeof distribution.failureCount === "number"
                ? {
                    sentAt: typeof distribution.sentAt === "string" ? distribution.sentAt : null,
                    successCount: dryRunDelivery ? 0 : typeof distribution.successCount === "number" ? distribution.successCount : 0,
                    failureCount: dryRunDelivery
                        ? (typeof distribution.recipientCount === "number" ? distribution.recipientCount : recipientCount)
                        : typeof distribution.failureCount === "number" ? distribution.failureCount : 0,
                    dryRun: dryRunDelivery,
                    error: typeof distribution.broadcastError === "string"
                        ? distribution.broadcastError
                        : dryRunDelivery
                            ? "Outbound email is disabled; Resend was not called."
                            : null,
                    openCount: typeof distribution.openCount === "number" ? distribution.openCount : 0,
                    clickCount: typeof distribution.clickCount === "number" ? distribution.clickCount : 0,
                    unsubscribeCount: typeof distribution.unsubscribeCount === "number" ? distribution.unsubscribeCount : 0,
                    openRate: typeof distribution.openRate === "number" ? distribution.openRate : 0,
                    clickRate: typeof distribution.clickRate === "number" ? distribution.clickRate : 0,
                    deliveredCount: typeof distribution.deliveredCount === "number" ? distribution.deliveredCount : 0,
                    totalClickCount: typeof distribution.totalClickCount === "number" ? distribution.totalClickCount : 0,
                    bounceCount: typeof distribution.bounceCount === "number" ? distribution.bounceCount : 0,
                    failedEventCount: typeof distribution.failedEventCount === "number" ? distribution.failedEventCount : 0,
                    complaintCount: typeof distribution.complaintCount === "number" ? distribution.complaintCount : 0,
                    metricsWebhook: readObject(distribution.metricsWebhook),
                    trackingDiagnostics: readObject(distribution.trackingDiagnostics),
                    recipients: recipientsRaw.map((recipient) => readObject(recipient)).map((recipient) => ({
                        email: typeof recipient.email === "string" ? recipient.email : "",
                        ok: recipient.ok === true,
                        status: typeof recipient.status === "number" ? recipient.status : null,
                        providerMessageId: typeof recipient.providerMessageId === "string" ? recipient.providerMessageId : null,
                        error: typeof recipient.error === "string" ? recipient.error : null,
                    })).filter((recipient) => recipient.email.length > 0),
                }
                : null,
        },
        emailTemplate: deliveryEmailHtml
            ? {
                html: deliveryEmailHtml,
                design: deliveryEmailDesign,
                updatedAt: deliveryEmailUpdatedAt,
            }
            : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export async function updateLoopRunNewsletterDraft(auth, input) {
    await assertRunAccess(auth, input.runId);
    const context = await loadRunContext(input.runId);
    if (context.runStatus === "executing_action") {
        throw new Error("Newsletter cannot be edited while delivery is executing");
    }
    const body = sanitizeSubscriberBody(String(input.body ?? ""));
    if (!body.trim()) {
        throw new Error("Newsletter body is required");
    }
    const emailHtml = typeof input.emailHtml === "string" && input.emailHtml.trim()
        ? input.emailHtml
        : undefined;
    const emailUpdatedAt = new Date().toISOString();
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
        deliveryContentBody: body,
        editorUpdatedAt: emailUpdatedAt,
        ...(emailHtml
            ? {
                deliveryEmailHtml: emailHtml,
                deliveryEmailDesign: input.emailDesign ?? null,
                deliveryEmailUpdatedAt: emailUpdatedAt,
                deliveryEmailSource: "builder",
                emailTemplate: {
                    html: emailHtml,
                    design: input.emailDesign ?? null,
                    updatedAt: emailUpdatedAt,
                },
            }
            : {}),
    });
    await pool.query(`UPDATE workflow_runs
     SET draft_output = $4,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
        context.runId,
        context.tenantId,
        context.userId,
        body,
        JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]);
    await insertEvent({
        context,
        eventType: "newsletter_draft_updated",
        payload: { source: "ui_editor" },
    });
    return { runId: context.runId, status: context.runStatus, draftOutput: body };
}

export async function listLoopRunComments(auth, runId) {
    await assertRunAccess(auth, runId);
    const result = await pool.query(`SELECT id, task_id, author, body, created_at
     FROM loop_run_comments
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY created_at ASC`, [runId, auth.tenantId, auth.userId]);
    return result.rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        author: row.author,
        body: row.body,
        createdAt: row.created_at,
    }));
}

export async function addLoopRunComment(auth, input) {
    await assertRunAccess(auth, input.runId);
    const body = input.body.trim();
    if (!body)
        throw new Error("Comment body is required");
    if (body.length > 8000)
        throw new Error("Comment body is too long");
    const context = await loadRunContext(input.runId);
    const commentId = randomUUID();
    await pool.query(`INSERT INTO loop_run_comments
     (id, tenant_id, user_id, workflow_run_id, task_id, author, body)
     VALUES ($1, $2, $3, $4, $5, 'user', $6)`, [
        commentId,
        auth.tenantId,
        auth.userId,
        input.runId,
        input.taskId ?? null,
        body,
    ]);
    await insertEvent({
        context,
        taskId: input.taskId ?? null,
        eventType: "user_comment",
        payload: { commentId },
    });
    const result = await pool.query(`SELECT created_at FROM loop_run_comments WHERE id = $1 LIMIT 1`, [commentId]);
    return {
        id: commentId,
        taskId: input.taskId ?? null,
        author: "user",
        body,
        createdAt: result.rows[0]?.created_at ?? new Date().toISOString(),
    };
}

export async function executeLoopWorkflow(input) {
    const workflow = await loadWorkflow(input.auth, input.workflowId);
    const definition = readLoopDefinition(workflow.metadata_json);
    const runId = randomUUID();
    await pool.query(`INSERT INTO workflow_runs
     (id, tenant_id, user_id, workflow_id, run_mode, status, scheduled_for, draft_output, connector_action_status, metadata_json)
     VALUES ($1, $2, $3, $4, $5, 'running', $6::timestamptz, NULL, 'not_required', $7::jsonb)`, [
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
    ]);
    await deliverStatusNotification({
        auth: input.auth,
        title: `${workflow.title} started`,
        body: input.runMode === "scheduled"
            ? "A scheduled loop run has started."
            : "A manual loop run has started.",
        metadata: { workflowId: workflow.id, runId, status: "running", runMode: input.runMode },
    }).catch(() => undefined);
    await scheduleHeartbeat({
        tenantId: input.auth.tenantId,
        userId: input.auth.userId,
        runId,
        jobType: "ceo_strategy",
    });
    return {
        runId,
        status: "running",
        draftRequired: false,
        finalOutput: "",
        strategyOutput: "",
    };
}
//# sourceMappingURL=executor.js.map
