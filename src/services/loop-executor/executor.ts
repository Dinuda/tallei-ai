// @ts-nocheck
import { randomUUID } from "crypto";
import { z } from "zod";
import { pool } from "../../infrastructure/db/index.js";
import { deliverApprovalPrompt, deliverStatusNotification, getPrimaryNotificationChannel } from "../channels.js";
import { consumeWorkflowApprovalToken, createWorkflowApprovalRequest, resolveWorkflowApprovalToken, } from "../approval-tokens.js";
import { enqueueLoopHeartbeatJob, findLoopHeartbeatJob, completeLoopHeartbeatJob, failLoopHeartbeatJob } from "./heartbeat-jobs.js";
import { runLoopAgent } from "./integration-registry.js";
import { loopExecutorOpenAiChat } from "./openai-chat.js";
import {
  artifactDefinition,
  isDynamicPlanDefinition,
  normalizeRosterAgents,
  readLoopDefinition,
  stageSeq,
} from "./plan.js";
import { extractNewsletterBodyFromComments, formatNewsletterForBroadcast, formatNewsletterForEmail, parseContactListCsv, sanitizeSubscriberNewsletterBody, } from "./publicist-email.js";
import {
  assertRunAccess,
  authFromContext,
  loadRunContext,
  loadWorkflow,
  mergeLoopExecutorMeta,
  readLoopExecutorMeta,
} from "./run-context.js";
import {
  buildCeoStrategyOutput,
  materializeTasksFromPlan,
  materializeTasksFromRoster,
} from "./run-strategy.js";
import { getEffectiveLoopConstraints, listAllowedLoopTools, listToolValidationIssues, validateAgentRoster, } from "./tool-catalog.js";
import { loopRunAgentSchema, loopToolAssignmentSchema, } from "./types.js";

function readObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function scheduleDelayedHeartbeatDispatch(delaySeconds) {
    const timer = setTimeout(() => {
        void import("./heartbeat-dispatch.js")
            .then(({ dispatchLoopHeartbeatJobs }) => dispatchLoopHeartbeatJobs({ source: "immediate" }))
            .catch((error) => console.error("[loop-executor] delayed heartbeat dispatch failed:", error));
    }, Math.max(0, delaySeconds) * 1000 + 250);
    timer.unref?.();
}
function readAgentSpec(task, taskInput) {
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
async function insertOrUpdateArtifact(input) {
    if (!isDynamicPlanDefinition(input.context.definition))
        return;
    const definition = artifactDefinition(input.context.definition.plan, input.artifactId);
    await pool.query(`INSERT INTO loop_run_artifacts
     (id, tenant_id, user_id, workflow_run_id, stage_id, artifact_id, kind, label, body, data_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (tenant_id, user_id, workflow_run_id, artifact_id) DO UPDATE
       SET stage_id = EXCLUDED.stage_id,
           kind = EXCLUDED.kind,
           label = EXCLUDED.label,
           body = EXCLUDED.body,
           data_json = EXCLUDED.data_json,
           updated_at = NOW()`, [
        randomUUID(),
        input.context.tenantId,
        input.context.userId,
        input.context.runId,
        input.stage.id,
        input.artifactId,
        definition?.kind ?? "custom",
        definition?.label ?? input.artifactId,
        input.body,
        JSON.stringify(input.data),
    ]);
}
async function loadRunArtifacts(context) {
    const result = await pool.query(`SELECT id, stage_id, artifact_id, kind, label, body, data_json, created_at, updated_at
     FROM loop_run_artifacts
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY created_at ASC`, [context.runId, context.tenantId, context.userId]);
    return result.rows;
}
async function loadArtifact(context, artifactId) {
    const result = await pool.query(`SELECT id, stage_id, artifact_id, kind, label, body, data_json, created_at, updated_at
     FROM loop_run_artifacts
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND artifact_id = $4
     LIMIT 1`, [context.runId, context.tenantId, context.userId, artifactId]);
    return result.rows[0] ?? null;
}
async function scheduleNextDynamicExecutable(input) {
    const plan = isDynamicPlanDefinition(input.context.definition) ? input.context.definition.plan : null;
    if (!plan)
        return { status: input.context.runStatus, taskId: null };
    const nextTask = await pool.query(`SELECT id, seq
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND status = 'todo'
       AND seq > $4
     ORDER BY seq ASC
     LIMIT 1`, [input.context.runId, input.context.tenantId, input.context.userId, input.afterSeq]);
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
async function pauseForDynamicGate(input) {
    const payload = { seq: input.seq, stage: input.stage };
    const artifactId = input.stage.kind === "approval_gate" ? input.stage.artifactId : null;
    if (artifactId) {
        const artifact = await loadArtifact(input.context, artifactId);
        payload.artifact = artifact
            ? {
                id: artifact.artifact_id,
                kind: artifact.kind,
                label: artifact.label,
                body: artifact.body,
                data: artifact.data_json,
            }
            : null;
    }
    const gateId = randomUUID();
    const kind = input.stage.kind === "approval_gate" ? "approval" : "input";
    await pool.query(`INSERT INTO loop_run_gates
     (id, tenant_id, user_id, workflow_run_id, stage_id, kind, status, title, artifact_id, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9::jsonb)
     ON CONFLICT (tenant_id, user_id, workflow_run_id, stage_id) DO UPDATE
       SET status = CASE
             WHEN loop_run_gates.status IN ('approved', 'submitted') THEN loop_run_gates.status
             ELSE 'pending'
           END,
           title = EXCLUDED.title,
           artifact_id = EXCLUDED.artifact_id,
           payload_json = EXCLUDED.payload_json,
           updated_at = NOW()
     RETURNING id`, [
        gateId,
        input.context.tenantId,
        input.context.userId,
        input.context.runId,
        input.stage.id,
        kind,
        input.stage.label,
        artifactId,
        JSON.stringify(payload),
    ]);
    const existing = await pool.query(`SELECT id FROM loop_run_gates
     WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3 AND stage_id = $4
     LIMIT 1`, [input.context.runId, input.context.tenantId, input.context.userId, input.stage.id]);
    const resolvedGateId = existing.rows[0]?.id ?? gateId;
    const pendingInput = input.stage.kind === "input_gate"
        ? {
            id: input.stage.id,
            kind: typeof input.stage.inputSchema.kind === "string" ? input.stage.inputSchema.kind : "input",
            label: input.stage.label,
            status: "pending",
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
    await pool.query(`UPDATE workflow_runs
     SET status = 'waiting_for_gate',
         waiting_for_strategy_approval = FALSE,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
        input.context.runId,
        input.context.tenantId,
        input.context.userId,
        JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]);
    const notificationAuth = authFromContext(input.context);
    const gateMetadata = {
        workflowId: input.context.workflowId,
        runId: input.context.runId,
        gateId: resolvedGateId,
        stageId: input.stage.id,
        status: "waiting_for_gate",
        gateKind: kind,
    };
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
                draftOutput: payload.artifact?.body ?? null,
            });
        })().catch(() => undefined);
    }
    else {
        await deliverStatusNotification({
            auth: notificationAuth,
            title: `${input.context.workflowTitle} needs input`,
            body: `${input.stage.label}. Reply with the requested input or continue in Tallei.`,
            metadata: gateMetadata,
        }).catch(() => undefined);
    }
    await insertEvent({
        context: input.context,
        eventType: "gate_waiting",
        payload: { gateId: resolvedGateId, stageId: input.stage.id, kind },
    });
    return { status: "waiting_for_gate", gateId: resolvedGateId };
}
async function advanceDynamicRunAfterSeq(context, currentSeq) {
    if (!isDynamicPlanDefinition(context.definition))
        return { status: context.runStatus };
    for (let seq = currentSeq + 1; seq < context.definition.plan.stages.length; seq += 1) {
        const stage = context.definition.plan.stages[seq];
        if (stage.kind === "approval_gate" || stage.kind === "input_gate") {
            return pauseForDynamicGate({ context, stage, seq });
        }
        if (stage.kind === "agent" || stage.kind === "external_action") {
            const next = await scheduleNextDynamicExecutable({ context, afterSeq: seq - 1 });
            return { status: next.status, ...(next.taskId ? { taskId: next.taskId } : {}) };
        }
    }
    const next = await scheduleNextDynamicExecutable({ context, afterSeq: currentSeq });
    return { status: next.status, ...(next.taskId ? { taskId: next.taskId } : {}) };
}
async function insertEvent(input) {
    await pool.query(`INSERT INTO loop_run_events
     (id, tenant_id, user_id, workflow_run_id, task_id, event_type, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`, [
        randomUUID(),
        input.context.tenantId,
        input.context.userId,
        input.context.runId,
        input.taskId ?? null,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
    ]);
}
async function insertComment(input) {
    await pool.query(`INSERT INTO loop_run_comments
     (id, tenant_id, user_id, workflow_run_id, task_id, author, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        randomUUID(),
        input.context.tenantId,
        input.context.userId,
        input.context.runId,
        input.taskId ?? null,
        input.author,
        input.body,
    ]);
}
async function loadRunComments(context) {
    const result = await pool.query(`SELECT id, task_id, author, body, created_at
     FROM loop_run_comments
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY created_at ASC`, [context.runId, context.tenantId, context.userId]);
    return result.rows;
}
async function completeLoopText(input) {
    const response = await loopExecutorOpenAiChat({
        messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
        ],
        temperature: 0.2,
        maxTokens: input.maxTokens ?? 1200,
    });
    const text = response.text.trim();
    if (!text)
        throw new Error("Loop executor LLM returned an empty response");
    return text;
}
async function synthesizeFinalOutput(context, comments) {
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
export async function markRunBlocked(runId, message, taskId) {
    const context = await loadRunContext(runId);
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
        blockedAt: new Date().toISOString(),
        error: { message },
    });
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
    await pool.query(`UPDATE workflow_runs
     SET status = 'blocked',
         waiting_for_strategy_approval = FALSE,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
        runId,
        context.tenantId,
        context.userId,
        JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]);
    await deliverStatusNotification({
        auth: authFromContext(context),
        title: `${context.workflowTitle} is blocked`,
        body: message,
        metadata: { workflowId: context.workflowId, runId: context.runId, status: "blocked" },
    }).catch(() => undefined);
}
async function scheduleHeartbeat(input) {
    await enqueueLoopHeartbeatJob(input);
    const job = await findLoopHeartbeatJob({
        runId: input.runId,
        jobType: input.jobType,
        taskId: input.taskId,
        idempotencySuffix: input.idempotencySuffix,
    });
    if (!job)
        return;
    try {
        if (input.jobType === "agent") {
            if (!input.taskId)
                throw new Error("Agent heartbeat job requires taskId");
            await runAgentHeartbeat(input.runId, input.taskId);
        }
        else if (input.jobType === "distribution") {
            await runDistributionHeartbeat(input.runId);
        }
        else {
            await runCeoFinalizeHeartbeat(input.runId);
        }
        await completeLoopHeartbeatJob(job.id);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempt = job.attempts + 1;
        if (input.jobType === "agent" && isRetryableLoopAgentError(error)) {
            await failLoopHeartbeatJob(job.id, message, attempt, job.max_attempts);
            return;
        }
        await failLoopHeartbeatJob(job.id, message, attempt, job.max_attempts);
        if (attempt >= job.max_attempts) {
            await markRunBlocked(input.runId, `Heartbeat job failed: ${message}`, input.taskId ?? null).catch(() => undefined);
        }
    }
}
export async function runCeoStrategyHeartbeat(runId) {
    const context = await loadRunContext(runId);
    const auth = authFromContext(context);
    const ceoOutput = await buildCeoStrategyOutput(context);
    const rosterValidation = await validateAgentRoster({
        agents: ceoOutput.agents,
        definition: getEffectiveLoopConstraints(context.definition),
        auth,
        strictConnectors: false,
    });
    if (!rosterValidation.ok) {
        const message = rosterValidation.issues.map((issue) => issue.message).join("; ");
        throw new Error(`CEO proposed invalid roster: ${message}`);
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
                contactList: {
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
            const message = connectorValidation.issues.map((issue) => issue.message).join("; ");
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
                publicistApproval: result.publicistApproval ?? null,
                newsletterBody: result.newsletterBody ?? null,
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
        if (result.emailApprovalSent && (result.approvalRequest || result.publicistApproval)) {
            const approvalRequest = result.approvalRequest ?? result.publicistApproval;
            const artifactBody = result.artifactBody
                ?? result.newsletterBody
                ?? extractNewsletterBodyFromComments(comments.map((comment) => ({
                    author: comment.author,
                    body: comment.body,
                })));
            const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
                approvalRequest: {
                    ...approvalRequest,
                    channel: "email",
                    artifactKind: "draft",
                },
                artifactBody,
                publicistApproval: approvalRequest,
                newsletterBody: artifactBody,
            });
            await pool.query(`UPDATE workflow_runs
         SET status = 'waiting_for_email_approval',
             draft_output = $4,
             connector_action_status = 'pending_approval',
             metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb,
             updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3`, [
                context.runId,
                context.tenantId,
                context.userId,
                artifactBody,
                JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
            ]);
            await insertEvent({
                context,
                taskId: task.id,
                eventType: "run_approval_email_sent",
                payload: {
                    to: approvalRequest.to,
                    approvalUrl: approvalRequest.approvalUrl,
                },
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
    const finalOutput = await synthesizeFinalOutput(context, comments);
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
async function approveLoopRunForContactUpload(input) {
    const runResult = await pool.query(`SELECT id, workflow_id, status, metadata_json
     FROM workflow_runs
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`, [input.runId, input.tenantId, input.userId]);
    const run = runResult.rows[0];
    if (!run)
        throw new Error("Workflow run not found");
    const meta = readObject(run.metadata_json);
    const loopExecutor = readObject(meta.loop_executor);
    const approvalRequest = Object.keys(readObject(loopExecutor.approvalRequest)).length > 0
        ? readObject(loopExecutor.approvalRequest)
        : readObject(loopExecutor.publicistApproval);
    const hasApprovalContext = typeof approvalRequest.token === "string"
        || typeof approvalRequest.approvalUrl === "string"
        || typeof approvalRequest.sentAt === "string";
    if (!hasApprovalContext && input.approvedBy !== "email") {
        throw new Error("Run has no loop approval context to continue");
    }
    const canApproveFromStatus = run.status === "waiting_for_approval" || run.status === "waiting_for_email_approval" || run.status === "blocked";
    if (!canApproveFromStatus) {
        if (run.status === "waiting_for_contact_list" || run.status === "waiting_for_input" || run.status === "executing_action" || run.status === "distributing" || run.status === "completed") {
            return {
                runId: run.id,
                workflowId: run.workflow_id,
                status: run.status,
            };
        }
        throw new Error(`Run is ${run.status}, not waiting for approval`);
    }
    const approvedAt = new Date().toISOString();
    await pool.query(`UPDATE workflow_runs
     SET status = 'waiting_for_contact_list',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
        run.id,
        input.tenantId,
        input.userId,
        JSON.stringify({
            loop_executor: {
                ...loopExecutor,
                emailApprovedAt: approvedAt,
                approvalChannel: input.approvedBy,
                approvalDecision: {
                    approvedAt,
                    channel: input.approvedBy,
                },
                pendingInput: {
                    id: "recipient_list_csv",
                    kind: "csv",
                    label: "Recipient list CSV",
                    status: "pending",
                    requestedAt: approvedAt,
                    instructions: "Upload a CSV with `email` and optional `name` columns. The newsletter sends immediately when you upload - no further approval.",
                    schema: {
                        requiredColumns: ["email"],
                        optionalColumns: ["name"],
                        maxRows: 5000,
                    },
                },
                ...(input.approvedBy === "ui" ? { uiApprovedAt: approvedAt } : {}),
            },
        }),
    ]);
    return {
        runId: run.id,
        workflowId: run.workflow_id,
        status: "waiting_for_contact_list",
    };
}
/** Apply draft approval metadata when upload arrives before a separate approve click. */
export async function ensureDraftApprovedForContactUpload(input) {
    const runResult = await pool.query(`SELECT status
     FROM workflow_runs
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`, [input.runId, input.tenantId, input.userId]);
    const run = runResult.rows[0];
    if (!run)
        throw new Error("Workflow run not found");
    if (run.status !== "waiting_for_approval" && run.status !== "waiting_for_email_approval") {
        return false;
    }
    await approveLoopRunForContactUpload({
        tenantId: input.tenantId,
        userId: input.userId,
        runId: input.runId,
        approvedBy: "csv_upload",
    });
    return true;
}
export async function approveLoopRunFromUi(input) {
    const approved = await approveLoopRunForContactUpload({
        tenantId: input.auth.tenantId,
        userId: input.auth.userId,
        runId: input.runId,
        approvedBy: "ui",
    });
    return {
        runId: approved.runId,
        workflowId: approved.workflowId,
        status: approved.status,
    };
}
export async function approveLoopRunApprovalToken(token) {
    const resolved = await resolveWorkflowApprovalToken(token);
    if (!resolved)
        throw new Error("Approval token not found");
    if (resolved.expired)
        throw new Error("Approval token expired");
    if (resolved.consumedAt)
        throw new Error("Approval token already used");
    if (resolved.targetType !== "workflow_run")
        throw new Error("Invalid approval target");
    const approved = await approveLoopRunForContactUpload({
        tenantId: resolved.tenantId,
        userId: resolved.userId,
        runId: resolved.targetId,
        approvedBy: "email",
    });
    await consumeWorkflowApprovalToken(token);
    return {
        runId: approved.runId,
        workflowId: approved.workflowId,
        status: approved.status,
    };
}
export async function uploadLoopRunContacts(input) {
    await assertRunAccess(input.auth, input.runId);
    await ensureDraftApprovedForContactUpload({
        tenantId: input.auth.tenantId,
        userId: input.auth.userId,
        runId: input.runId,
    });
    const context = await loadRunContext(input.runId);
    const uploadableStatuses = new Set([
        "waiting_for_contact_list",
        "waiting_for_input",
    ]);
    if (!uploadableStatuses.has(context.runStatus)) {
        throw new Error(`Run is ${context.runStatus}, not waiting for contact list upload`);
    }
    const contacts = parseContactListCsv(input.csv);
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
        pendingInput: {
            id: "recipient_list_csv",
            kind: "csv",
            label: "Recipient list CSV",
            status: "submitted",
            requestedAt: new Date().toISOString(),
            submittedAt: new Date().toISOString(),
            instructions: "Upload a CSV with `email` and optional `name` columns. The newsletter sends immediately when you upload.",
            schema: {
                requiredColumns: ["email"],
                optionalColumns: ["name"],
                maxRows: 5000,
            },
        },
        contactList: {
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
    await pool.query(`UPDATE workflow_runs
     SET status = 'executing_action',
         connector_action_status = 'distribution_pending',
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
        eventType: "contact_list_uploaded",
        payload: { recipientCount: contacts.length, autoSend: true },
    });
    await scheduleHeartbeat({
        tenantId: context.tenantId,
        userId: context.userId,
        runId: context.runId,
        jobType: "distribution",
    });
    const after = await loadRunContext(input.runId);
    const loopExecutor = readObject(readObject(after.metadataJson).loop_executor);
    const distribution = readObject(loopExecutor.distribution);
    const broadcastId = typeof distribution.broadcastId === "string" ? distribution.broadcastId : undefined;
    return {
        runId: context.runId,
        status: after.runStatus,
        recipientCount: contacts.length,
        ...(broadcastId ? { broadcastId } : {}),
    };
}
export async function submitLoopRunInput(input) {
    const inputId = input.inputId.trim().toLowerCase();
    if (inputId !== "recipient_list_csv" && inputId !== "contacts" && inputId !== "contact_list") {
        throw new Error(`Unsupported input id: ${input.inputId}`);
    }
    return uploadLoopRunContacts({
        auth: input.auth,
        runId: input.runId,
        csv: input.value,
    });
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
export async function listLoopRunGates(auth, runId) {
    await assertRunAccess(auth, runId);
    const result = await pool.query(`SELECT id, stage_id, kind, status, title, artifact_id, payload_json, decision_json, created_at, completed_at, updated_at
     FROM loop_run_gates
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
     ORDER BY created_at ASC`, [runId, auth.tenantId, auth.userId]);
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
async function completeDynamicGate(input) {
    await assertRunAccess(input.auth, input.runId);
    const context = await loadRunContext(input.runId);
    if (!isDynamicPlanDefinition(context.definition)) {
        throw new Error("Run does not use dynamic gates");
    }
    const gateResult = await pool.query(`SELECT id, stage_id, kind, status, title, artifact_id, payload_json, decision_json, created_at, completed_at, updated_at
     FROM loop_run_gates
     WHERE id = $1
       AND workflow_run_id = $2
       AND tenant_id = $3
       AND user_id = $4
     LIMIT 1`, [input.gateId, input.runId, input.auth.tenantId, input.auth.userId]);
    const gate = gateResult.rows[0];
    if (!gate)
        throw new Error("Loop gate not found");
    if (gate.status !== "pending") {
        throw new Error(`Gate is ${gate.status}, not pending`);
    }
    const seq = stageSeq(context.definition.plan, gate.stage_id);
    if (seq < 0)
        throw new Error(`Gate stage ${gate.stage_id} not found in plan`);
    if (input.status === "rejected") {
        await pool.query(`UPDATE loop_run_gates
       SET status = 'rejected',
           decision_json = $5::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND workflow_run_id = $2 AND tenant_id = $3 AND user_id = $4`, [gate.id, input.runId, input.auth.tenantId, input.auth.userId, JSON.stringify(input.decision)]);
        await markRunBlocked(input.runId, `Gate rejected: ${gate.title}`, null);
        return { runId: input.runId, status: "blocked", gateId: gate.id };
    }
    await pool.query(`UPDATE loop_run_gates
     SET status = $5,
         decision_json = $6::jsonb,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND workflow_run_id = $2 AND tenant_id = $3 AND user_id = $4`, [gate.id, input.runId, input.auth.tenantId, input.auth.userId, input.status, JSON.stringify(input.decision)]);
    await pool.query(`UPDATE workflow_runs
     SET status = 'running',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`, [
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
    ]);
    await insertEvent({
        context,
        eventType: "gate_completed",
        payload: { gateId: gate.id, stageId: gate.stage_id, status: input.status },
    });
    const freshContext = await loadRunContext(input.runId);
    const next = await scheduleNextDynamicExecutable({ context: freshContext, afterSeq: seq });
    return { runId: input.runId, status: next.status, gateId: gate.id };
}
export async function approveLoopRunGate(input) {
    return completeDynamicGate({
        auth: input.auth,
        runId: input.runId,
        gateId: input.gateId,
        status: "approved",
        decision: { approvedAt: new Date().toISOString(), channel: "ui" },
    });
}
export async function approveLoopRunGateApprovalToken(token) {
    const resolved = await resolveWorkflowApprovalToken(token);
    if (!resolved)
        throw new Error("Approval token not found");
    if (resolved.expired)
        throw new Error("Approval token expired");
    if (resolved.consumedAt)
        throw new Error("Approval token already used");
    if (resolved.targetType !== "workflow_gate")
        throw new Error("Invalid gate approval target");
    const gateResult = await pool.query(`SELECT g.workflow_run_id, r.workflow_id
     FROM loop_run_gates g
     JOIN workflow_runs r ON r.id = g.workflow_run_id
     WHERE g.id = $1
       AND g.tenant_id = $2
       AND g.user_id = $3
     LIMIT 1`, [resolved.targetId, resolved.tenantId, resolved.userId]);
    const gate = gateResult.rows[0];
    if (!gate)
        throw new Error("Loop gate not found");
    const result = await completeDynamicGate({
        auth: {
            tenantId: resolved.tenantId,
            userId: resolved.userId,
            authMode: "internal",
            plan: "pro",
        },
        runId: gate.workflow_run_id,
        gateId: resolved.targetId,
        status: "approved",
        decision: { approvedAt: new Date().toISOString(), channel: resolved.channel || "email" },
    });
    await consumeWorkflowApprovalToken(token);
    return {
        runId: gate.workflow_run_id,
        workflowId: gate.workflow_id,
        status: result.status,
        gateId: resolved.targetId,
    };
}
export async function rejectLoopRunGate(input) {
    return completeDynamicGate({
        auth: input.auth,
        runId: input.runId,
        gateId: input.gateId,
        status: "rejected",
        decision: { rejectedAt: new Date().toISOString(), channel: "ui", reason: input.reason ?? null },
    });
}
export async function submitLoopRunGateInput(input) {
    await assertRunAccess(input.auth, input.runId);
    const context = await loadRunContext(input.runId);
    if (!isDynamicPlanDefinition(context.definition)) {
        throw new Error("Run does not use dynamic gates");
    }
    const gateResult = await pool.query(`SELECT id, stage_id, kind, status, title, artifact_id, payload_json, decision_json, created_at, completed_at, updated_at
     FROM loop_run_gates
     WHERE id = $1
       AND workflow_run_id = $2
       AND tenant_id = $3
       AND user_id = $4
     LIMIT 1`, [input.gateId, input.runId, input.auth.tenantId, input.auth.userId]);
    const gate = gateResult.rows[0];
    if (!gate)
        throw new Error("Loop gate not found");
    if (gate.kind !== "input")
        throw new Error("Gate is not an input gate");
    if (gate.status !== "pending")
        throw new Error(`Gate is ${gate.status}, not pending`);
    const seq = stageSeq(context.definition.plan, gate.stage_id);
    const stage = context.definition.plan.stages[seq];
    if (!stage || stage.kind !== "input_gate")
        throw new Error(`Input stage ${gate.stage_id} not found in plan`);
    const schemaKind = typeof stage.inputSchema.kind === "string" ? stage.inputSchema.kind : "text";
    let body = input.value;
    let data = { value: input.value };
    let recipientCount;
    if (schemaKind === "csv") {
        const contacts = parseContactListCsv(input.value);
        body = `Uploaded ${contacts.length} recipients.`;
        data = { contacts, recipientCount: contacts.length };
        recipientCount = contacts.length;
    }
    await insertOrUpdateArtifact({
        context,
        stage,
        artifactId: stage.outputArtifactId,
        body,
        data,
    });
    const result = await completeDynamicGate({
        auth: input.auth,
        runId: input.runId,
        gateId: input.gateId,
        status: "submitted",
        decision: { submittedAt: new Date().toISOString(), channel: "ui", artifactId: stage.outputArtifactId },
    });
    return {
        ...result,
        artifactId: stage.outputArtifactId,
        ...(typeof recipientCount === "number" ? { recipientCount } : {}),
    };
}
export async function runDistributionHeartbeat(runId) {
    const context = await loadRunContext(runId);
    if (context.runStatus !== "executing_action" && context.runStatus !== "distributing") {
        throw new Error(`Run is ${context.runStatus}, not executing delivery action`);
    }
    const auth = {
        tenantId: context.tenantId,
        userId: context.userId,
        authMode: "internal",
        plan: "pro",
    };
    const root = readObject(context.metadataJson);
    const loopExecutor = readObject(root.loop_executor);
    const contactListRaw = readObject(loopExecutor.contactList);
    const contactsRaw = Array.isArray(contactListRaw.contacts) ? contactListRaw.contacts : [];
    const contacts = contactsRaw
        .map((row) => readObject(row))
        .map((row) => ({
        email: typeof row.email === "string" ? row.email.trim().toLowerCase() : "",
        name: typeof row.name === "string" ? row.name.trim() : undefined,
    }))
        .filter((row) => row.email.length > 0);
    if (contacts.length === 0) {
        throw new Error("No contacts available for distribution");
    }
    const rawDeliveryBody = typeof loopExecutor.deliveryContentBody === "string" && loopExecutor.deliveryContentBody.trim()
        ? loopExecutor.deliveryContentBody.trim()
        : typeof loopExecutor.artifactBody === "string" && loopExecutor.artifactBody.trim()
            ? loopExecutor.artifactBody.trim()
            : typeof loopExecutor.newsletterBody === "string" && loopExecutor.newsletterBody.trim()
                ? loopExecutor.newsletterBody.trim()
                : context.draftOutput?.trim()
                    ?? extractNewsletterBodyFromComments((await loadRunComments(context)).map((comment) => ({
                        author: comment.author,
                        body: comment.body,
                    })));
    const deliveryBody = sanitizeSubscriberNewsletterBody(rawDeliveryBody);
    if (!deliveryBody) {
        throw new Error("Delivery content is missing for distribution");
    }
    const formattedNewsletter = formatNewsletterForEmail(deliveryBody);
    const broadcastContent = formatNewsletterForBroadcast(formattedNewsletter);
    const subject = formattedNewsletter.subject ?? context.workflowTitle;
    const existingDistribution = readObject(loopExecutor.distribution);
    const existingBroadcastId = typeof existingDistribution.broadcastId === "string"
        ? existingDistribution.broadcastId
        : null;
    if (existingBroadcastId) {
        const recipientResults = contacts.map((contact) => ({
            email: contact.email,
            ok: true,
            providerMessageId: existingBroadcastId,
        }));
        const distributionMeta = {
            ...existingDistribution,
            startedAt: typeof existingDistribution.startedAt === "string" ? existingDistribution.startedAt : new Date().toISOString(),
            sentAt: new Date().toISOString(),
            successCount: contacts.length,
            failureCount: 0,
            recipientCount: contacts.length,
            nextIndex: contacts.length,
            provider: "resend_broadcast",
            broadcastId: existingBroadcastId,
            recipients: recipientResults,
        };
        return finalizeDistributionRun({
            context,
            loopExecutor,
            deliveryBody,
            contacts,
            distributionMeta,
            recipientResults,
            finalStatus: "completed",
        });
    }
    const { createAndSendResendBroadcast, createResendSegment, resolveResendMarketingCredentials, upsertResendContactInSegment, } = await import("../notifications/resend-broadcast.js");
    const creds = await resolveResendMarketingCredentials(auth);
    if (!creds) {
        throw new Error("Resend is not configured for marketing broadcasts. Connect Resend in workflow connector settings or set signup Resend environment variables.");
    }
    let segmentId = typeof existingDistribution.segmentId === "string"
        ? existingDistribution.segmentId
        : null;
    if (!segmentId) {
        const segment = await createResendSegment({
            creds,
            name: `Tallei ${context.workflowTitle} ${context.runId.slice(0, 8)}`,
        });
        if (!segment.ok || !segment.segmentId) {
            throw new Error(segment.error ?? "Failed to create Resend segment for broadcast");
        }
        segmentId = segment.segmentId;
    }
    const existingRecipients = Array.isArray(existingDistribution.recipients)
        ? existingDistribution.recipients.map((row) => readObject(row)).map((row) => ({
            email: typeof row.email === "string" ? row.email.trim().toLowerCase() : "",
            ok: row.ok === true,
            ...(typeof row.status === "number" ? { status: row.status } : {}),
            ...(typeof row.contactId === "string" ? { contactId: row.contactId } : {}),
            ...(typeof row.error === "string" ? { error: row.error } : {}),
        })).filter((row) => row.email.length > 0)
        : [];
    const syncedEmails = new Set(existingRecipients.filter((row) => row.ok).map((row) => row.email));
    const nextIndex = typeof existingDistribution.nextIndex === "number"
        ? Math.max(0, Math.min(existingDistribution.nextIndex, contacts.length))
        : 0;
    const contactBatchSize = 15;
    const batchContacts = contacts.slice(nextIndex, nextIndex + contactBatchSize);
    const recipientResults = [...existingRecipients];
    for (const contact of batchContacts) {
        if (syncedEmails.has(contact.email))
            continue;
        const result = await upsertResendContactInSegment({ creds, segmentId, contact });
        recipientResults.push({
            email: result.email,
            ok: result.ok,
            ...(result.status ? { status: result.status } : {}),
            ...(result.contactId ? { contactId: result.contactId } : {}),
            ...(result.error ? { error: result.error } : {}),
        });
        if (result.ok)
            syncedEmails.add(result.email);
    }
    const processedCount = Math.min(contacts.length, nextIndex + batchContacts.length);
    const successCount = recipientResults.filter((recipient) => recipient.ok).length;
    const failureCount = recipientResults.filter((recipient) => !recipient.ok).length;
    const inProgressMeta = {
        startedAt: typeof existingDistribution.startedAt === "string" ? existingDistribution.startedAt : new Date().toISOString(),
        sentAt: new Date().toISOString(),
        successCount,
        failureCount,
        recipientCount: contacts.length,
        nextIndex: processedCount,
        contactBatchSize,
        segmentId,
        provider: "resend_broadcast",
        recipients: recipientResults,
    };
    if (processedCount < contacts.length) {
        const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
            distribution: inProgressMeta,
            deliveryAction: {
                kind: "send_broadcast",
                status: "syncing_contacts",
                startedAt: typeof existingDistribution.startedAt === "string" ? existingDistribution.startedAt : new Date().toISOString(),
                recipientCount: contacts.length,
                successCount,
                failureCount,
            },
        });
        await pool.query(`UPDATE workflow_runs
       SET status = 'executing_action',
           connector_action_status = 'distribution_pending',
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
            eventType: "broadcast_contacts_synced",
            payload: {
                processedCount,
                recipientCount: contacts.length,
                successCount,
                failureCount,
                segmentId,
            },
        });
        await enqueueLoopHeartbeatJob({
            tenantId: context.tenantId,
            userId: context.userId,
            runId: context.runId,
            jobType: "distribution",
            delaySeconds: 2,
            idempotencySuffix: `contacts-${processedCount}`,
        });
        scheduleDelayedHeartbeatDispatch(2);
        return { runId: context.runId, status: "executing_action" };
    }
    const segmentReadyCount = recipientResults.filter((recipient) => recipient.ok).length;
    if (segmentReadyCount === 0) {
        throw new Error("No contacts could be added to the Resend segment for broadcast");
    }
    const broadcast = await createAndSendResendBroadcast({
        creds,
        segmentId,
        subject,
        html: broadcastContent.html,
        text: broadcastContent.text,
        name: `${context.workflowTitle} — ${context.runId.slice(0, 8)}`,
    });
    if (!broadcast.ok || !broadcast.broadcastId) {
        const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
            distribution: {
                ...inProgressMeta,
                nextIndex: contacts.length,
                broadcastError: broadcast.error ?? "Failed to send Resend broadcast",
            },
            deliveryAction: {
                kind: "send_broadcast",
                status: "failed",
                startedAt: typeof existingDistribution.startedAt === "string" ? existingDistribution.startedAt : new Date().toISOString(),
                completedAt: new Date().toISOString(),
                recipientCount: contacts.length,
                successCount,
                failureCount,
            },
        });
        await pool.query(`UPDATE workflow_runs
       SET status = 'blocked',
           connector_action_status = 'distribution_failed',
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
        throw new Error(broadcast.error ?? "Failed to send Resend broadcast");
    }
    const broadcastRecipients = contacts.map((contact) => {
        const synced = recipientResults.find((recipient) => recipient.email === contact.email);
        return {
            email: contact.email,
            ok: synced?.ok ?? false,
            providerMessageId: broadcast.broadcastId,
            ...(synced?.error ? { error: synced.error } : {}),
        };
    });
    const broadcastSuccessCount = broadcastRecipients.filter((recipient) => recipient.ok).length;
    const broadcastFailureCount = broadcastRecipients.length - broadcastSuccessCount;
    const distributionMeta = {
        ...inProgressMeta,
        sentAt: new Date().toISOString(),
        successCount: broadcastSuccessCount,
        failureCount: broadcastFailureCount,
        nextIndex: contacts.length,
        segmentId,
        broadcastId: broadcast.broadcastId,
        recipients: broadcastRecipients,
    };
    const finalStatus = broadcastFailureCount > 0 ? "blocked" : "completed";
    return finalizeDistributionRun({
        context,
        loopExecutor,
        deliveryBody,
        contacts,
        distributionMeta,
        recipientResults: broadcastRecipients,
        finalStatus,
    });
}
async function finalizeDistributionRun(input) {
    const { context, loopExecutor, deliveryBody, contacts, distributionMeta, recipientResults, finalStatus } = input;
    const successCount = recipientResults.filter((recipient) => recipient.ok).length;
    const failureCount = recipientResults.filter((recipient) => !recipient.ok).length;
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, { distribution: distributionMeta });
    const loopExecutorPatchWithAction = mergeLoopExecutorMeta({ loop_executor: loopExecutorPatch.loop_executor }, {
        deliveryAction: {
            kind: "send_broadcast",
            status: finalStatus === "completed" ? "completed" : "partial_failure",
            startedAt: typeof distributionMeta.startedAt === "string" ? distributionMeta.startedAt : new Date().toISOString(),
            completedAt: new Date().toISOString(),
            successCount,
            failureCount,
            recipientCount: contacts.length,
            broadcastId: typeof distributionMeta.broadcastId === "string" ? distributionMeta.broadcastId : undefined,
        },
    });
    const comments = await loadRunComments(context);
    const finalOutput = await synthesizeFinalOutput(context, comments);
    const failedRecipients = recipientResults
        .filter((recipient) => !recipient.ok)
        .map((recipient) => `${recipient.email}${recipient.error ? ` (${recipient.error})` : ""}`);
    const broadcastId = typeof distributionMeta.broadcastId === "string" ? distributionMeta.broadcastId : null;
    await insertComment({
        context,
        author: "ceo",
        body: [
            finalOutput,
            "",
            `Distribution ${finalStatus === "completed" ? "complete" : "needs review"}: Resend broadcast ${broadcastId ?? "pending"} to ${successCount} contact(s) in segment, ${failureCount} contact sync failure(s).`,
            failedRecipients.length > 0 ? `Contact sync failed: ${failedRecipients.join(", ")}` : null,
            "Broadcast sends use Resend marketing delivery (not transactional email). Delivery and bounces are tracked in Resend.",
        ].filter(Boolean).join("\n"),
    });
    await insertEvent({
        context,
        eventType: "ceo_finalized",
        payload: { draftRequired: false, draftCount: 0, status: finalStatus, distribution: distributionMeta },
    });
    const deliveryResultArtifactId = typeof loopExecutor.deliveryResultArtifactId === "string"
        ? loopExecutor.deliveryResultArtifactId
        : null;
    if (deliveryResultArtifactId && isDynamicPlanDefinition(context.definition)) {
        await insertOrUpdateArtifact({
            context,
            stage: {
                kind: "external_action",
                id: "delivery_result",
                label: "Delivery result",
                toolRef: "internal.resend_broadcast",
                inputArtifactIds: [],
            },
            artifactId: deliveryResultArtifactId,
            body: `Delivery ${finalStatus === "completed" ? "completed" : "needs review"}: ${successCount} succeeded, ${failureCount} failed.`,
            data: {
                distribution: distributionMeta,
                recipients: recipientResults,
                successCount,
                failureCount,
            },
        });
    }
    await pool.query(`UPDATE workflows
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`, [
        context.workflowId,
        JSON.stringify({
            loop_executor: {
                lastContactList: loopExecutor.contactList ?? null,
                lastDistribution: distributionMeta,
                lastDeliveryAction: {
                    kind: "send_broadcast",
                    status: finalStatus === "completed" ? "completed" : "partial_failure",
                    completedAt: new Date().toISOString(),
                    successCount,
                    failureCount,
                    recipientCount: contacts.length,
                    broadcastId,
                },
            },
        }),
    ]);
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
        finalStatus,
        deliveryBody,
        finalStatus === "completed" ? "completed" : "partial_failure",
        JSON.stringify({ loop_executor: loopExecutorPatchWithAction.loop_executor }),
    ]);
    await deliverStatusNotification({
        auth,
        title: finalStatus === "completed" ? `${context.workflowTitle} broadcast completed` : `${context.workflowTitle} broadcast needs review`,
        body: `Delivered to ${successCount} recipients. ${failureCount > 0 ? `${failureCount} failed.` : "No delivery failures were reported."}`,
        metadata: { workflowId: context.workflowId, runId: context.runId, status: finalStatus },
    }).catch(() => undefined);
    await insertEvent({
        context,
        eventType: "broadcast_sent",
        payload: distributionMeta,
    });
    return { runId: context.runId, status: finalStatus };
}
export async function approveLoopStrategy(input) {
    await assertRunAccess(input.auth, input.runId);
    const context = await loadRunContext(input.runId);
    if (context.runStatus !== "waiting_for_strategy_approval") {
        throw new Error(`Run is ${context.runStatus}, not waiting_for_strategy_approval`);
    }
    const runMeta = readLoopExecutorMeta(context.metadataJson);
    const rosterSource = input.roster ?? runMeta.approvedRoster ?? runMeta.proposedRoster;
    if (!rosterSource?.length) {
        throw new Error("No agent roster is available to approve");
    }
    const roster = normalizeRosterAgents(rosterSource);
    const constraints = getEffectiveLoopConstraints(context.definition);
    const rosterValidation = await validateAgentRoster({
        agents: roster,
        definition: constraints,
        auth: input.auth,
    });
    if (!rosterValidation.ok) {
        const message = rosterValidation.issues.map((issue) => issue.message).join("; ");
        throw new Error(message);
    }
    const strategyOutput = (await pool.query(`SELECT strategy_output FROM workflow_runs WHERE id = $1 LIMIT 1`, [context.runId])).rows[0]?.strategy_output ?? "";
    if (isDynamicPlanDefinition(context.definition)) {
        await materializeTasksFromPlan({
            context,
            plan: context.definition.plan,
            strategyOutput,
        });
    }
    else {
        await materializeTasksFromRoster({
            context,
            roster,
            strategyOutput,
        });
    }
    const firstTask = await pool.query(`SELECT id
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND status = 'todo'
     ORDER BY seq ASC
     LIMIT 1`, [context.runId, context.tenantId, context.userId]);
    const firstTaskId = firstTask.rows[0]?.id ?? null;
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
        approvedRoster: roster,
        rosterApprovedAt: new Date().toISOString(),
    });
    await pool.query(`UPDATE workflow_runs
     SET status = 'strategy_approved',
         waiting_for_strategy_approval = FALSE,
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
    await insertComment({
        context,
        author: "user",
        body: "Strategy approved. Agents may begin execution.",
    });
    await insertEvent({
        context,
        eventType: "strategy_approved",
        payload: { firstTaskId, agentCount: roster.length },
    });
    if (firstTaskId) {
        await scheduleHeartbeat({
            tenantId: context.tenantId,
            userId: context.userId,
            runId: context.runId,
            jobType: "agent",
            taskId: firstTaskId,
        });
    }
    else {
        await scheduleHeartbeat({
            tenantId: context.tenantId,
            userId: context.userId,
            runId: context.runId,
            jobType: "ceo_finalize",
        });
    }
    return { runId: context.runId, status: "strategy_approved", firstTaskId };
}
export async function resumeLoopRunExecution(input) {
    await assertRunAccess(input.auth, input.runId);
    const context = await loadRunContext(input.runId);
    const resumableStatuses = new Set(["strategy_approved", "running", "blocked", "executing_action", "distributing"]);
    if (!resumableStatuses.has(context.runStatus)) {
        throw new Error(`Run is ${context.runStatus}, cannot resume agent execution`);
    }
    if (context.runStatus === "executing_action" || context.runStatus === "distributing") {
        const root = readObject(context.metadataJson);
        const loopExecutor = readObject(root.loop_executor);
        const contactList = readObject(loopExecutor.contactList);
        const contactsRaw = Array.isArray(contactList.contacts) ? contactList.contacts : [];
        if (contactsRaw.length === 0) {
            throw new Error("Run is executing delivery but has no uploaded contacts");
        }
        await scheduleHeartbeat({
            tenantId: context.tenantId,
            userId: context.userId,
            runId: context.runId,
            jobType: "distribution",
            resetAttempts: true,
            idempotencySuffix: `resume-${Date.now()}`,
        });
        return { runId: context.runId, status: context.runStatus, firstTaskId: null };
    }
    if (context.runStatus === "blocked") {
        await pool.query(`UPDATE loop_run_tasks
       SET status = 'todo',
           checkout_locked_at = NULL,
           completed_at = NULL,
           updated_at = NOW()
       WHERE workflow_run_id = $1
         AND tenant_id = $2
         AND user_id = $3
         AND error_json @> '{"retryable": true}'::jsonb
         AND status IN ('todo', 'blocked')`, [context.runId, context.tenantId, context.userId]);
    }
    const firstTask = await pool.query(`SELECT id
     FROM loop_run_tasks
     WHERE workflow_run_id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND status = 'todo'
     ORDER BY seq ASC
     LIMIT 1`, [context.runId, context.tenantId, context.userId]);
    const firstTaskId = firstTask.rows[0]?.id ?? null;
    if (context.runStatus === "blocked" && !firstTaskId) {
        const root = readObject(context.metadataJson);
        const loopExecutor = readObject(root.loop_executor);
        const contactList = readObject(loopExecutor.contactList);
        const contactsRaw = Array.isArray(contactList.contacts) ? contactList.contacts : [];
        const contacts = contactsRaw
            .map((row) => readObject(row))
            .map((row) => ({
            email: typeof row.email === "string" ? row.email.trim().toLowerCase() : "",
        }))
            .filter((row) => row.email.length > 0);
        const distribution = readObject(loopExecutor.distribution);
        const recipients = Array.isArray(distribution.recipients)
            ? distribution.recipients.map((row) => readObject(row)).map((row) => ({
                email: typeof row.email === "string" ? row.email.trim().toLowerCase() : "",
                ok: row.ok === true,
                ...(typeof row.status === "number" ? { status: row.status } : {}),
                ...(typeof row.providerMessageId === "string" ? { providerMessageId: row.providerMessageId } : {}),
                ...(typeof row.error === "string" ? { error: row.error } : {}),
            })).filter((row) => row.email.length > 0)
            : [];
        const failedEmails = new Set(recipients.filter((recipient) => !recipient.ok).map((recipient) => recipient.email));
        const broadcastFailed = typeof distribution.broadcastError === "string" && distribution.broadcastError.length > 0;
        const segmentId = typeof distribution.segmentId === "string" ? distribution.segmentId : null;
        if (broadcastFailed && segmentId) {
            const retryDistribution = {
                ...distribution,
                broadcastError: undefined,
                broadcastId: undefined,
                recipients: recipients.filter((recipient) => recipient.ok),
                successCount: recipients.filter((recipient) => recipient.ok).length,
                failureCount: 0,
                recipientCount: contacts.length,
                nextIndex: contacts.length,
                retryStartedAt: new Date().toISOString(),
            };
            const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
                distribution: retryDistribution,
                resumedAt: new Date().toISOString(),
            });
            await pool.query(`UPDATE workflow_runs
         SET status = 'executing_action',
             connector_action_status = 'distribution_retrying',
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
                eventType: "broadcast_retry_started",
                payload: { segmentId },
            });
            await scheduleHeartbeat({
                tenantId: context.tenantId,
                userId: context.userId,
                runId: context.runId,
                jobType: "distribution",
                resetAttempts: true,
                idempotencySuffix: `broadcast-retry-${Date.now()}`,
            });
            return { runId: context.runId, status: "executing_action", firstTaskId: null };
        }
        const firstFailedIndex = contacts.findIndex((contact) => failedEmails.has(contact.email));
        if (firstFailedIndex >= 0) {
            const keptRecipients = recipients.filter((recipient) => {
                if (!recipient.ok)
                    return false;
                const contactIndex = contacts.findIndex((contact) => contact.email === recipient.email);
                return contactIndex >= 0 && contactIndex < firstFailedIndex;
            });
            const retryDistribution = {
                ...distribution,
                recipients: keptRecipients,
                successCount: keptRecipients.length,
                failureCount: 0,
                recipientCount: contacts.length,
                nextIndex: firstFailedIndex,
                contactBatchSize: 15,
                retryStartedAt: new Date().toISOString(),
            };
            const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
                distribution: retryDistribution,
                resumedAt: new Date().toISOString(),
            });
            await pool.query(`UPDATE workflow_runs
         SET status = 'executing_action',
             connector_action_status = 'distribution_retrying',
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
                eventType: "distribution_retry_started",
                payload: { firstFailedIndex, failedCount: failedEmails.size },
            });
            await scheduleHeartbeat({
                tenantId: context.tenantId,
                userId: context.userId,
                runId: context.runId,
                jobType: "distribution",
                resetAttempts: true,
                idempotencySuffix: `retry-${firstFailedIndex}-${Date.now()}`,
            });
            return { runId: context.runId, status: "executing_action", firstTaskId: null };
        }
        throw new Error("Run is blocked and has no queued task to resume");
    }
    if (firstTaskId || context.runStatus === "blocked") {
        await pool.query(`UPDATE workflow_runs
       SET status = 'running',
           waiting_for_strategy_approval = FALSE,
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`, [
            context.runId,
            context.tenantId,
            context.userId,
            JSON.stringify({ loop_executor: { resumedAt: new Date().toISOString() } }),
        ]);
        await insertEvent({
            context,
            taskId: firstTaskId,
            eventType: "run_resumed",
            payload: { fromStatus: context.runStatus, firstTaskId },
        });
    }
    if (firstTaskId) {
        await scheduleHeartbeat({
            tenantId: context.tenantId,
            userId: context.userId,
            runId: context.runId,
            jobType: "agent",
            taskId: firstTaskId,
            resetAttempts: context.runStatus === "blocked",
        });
    }
    else {
        await scheduleHeartbeat({
            tenantId: context.tenantId,
            userId: context.userId,
            runId: context.runId,
            jobType: "ceo_finalize",
            resetAttempts: context.runStatus === "blocked",
        });
    }
    return { runId: context.runId, status: firstTaskId || context.runStatus === "blocked" ? "running" : context.runStatus, firstTaskId };
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
    const proposedRoster = runMeta.proposedRoster ?? [];
    const approvedRoster = runMeta.approvedRoster ?? null;
    const editable = context.runStatus === "waiting_for_strategy_approval";
    const activeRoster = approvedRoster ?? proposedRoster;
    const constraints = getEffectiveLoopConstraints(context.definition);
    const validationIssues = activeRoster.length
        ? await listToolValidationIssues({ agents: activeRoster, definition: constraints, auth })
        : [];
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
    const validationIssues = await listToolValidationIssues({
        agents: roster,
        definition: constraints,
        auth,
    });
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
    return { roster, validationIssues };
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
    const approvalDecision = readObject(meta.approvalDecision);
    const contactList = readObject(meta.contactList);
    const distribution = readObject(meta.distribution);
    const pendingInputRaw = readObject(meta.pendingInput);
    const deliveryActionRaw = readObject(meta.deliveryAction);
    const recipientsRaw = Array.isArray(distribution.recipients) ? distribution.recipients : [];
    const requestedTo = typeof approvalRequest.to === "string" ? approvalRequest.to : null;
    const requestedAt = typeof approvalRequest.sentAt === "string" ? approvalRequest.sentAt : null;
    const approvedAt = typeof approvalDecision.approvedAt === "string"
        ? approvalDecision.approvedAt
        : typeof meta.emailApprovedAt === "string"
            ? meta.emailApprovedAt
            : typeof meta.uiApprovedAt === "string"
                ? meta.uiApprovedAt
                : null;
    const approvalChannel = typeof approvalDecision.channel === "string"
        ? approvalDecision.channel
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
            status: deliveryActionRaw.status === "completed" || deliveryActionRaw.status === "partial_failure" || deliveryActionRaw.status === "in_progress"
                ? deliveryActionRaw.status
                : "pending",
            startedAt: typeof deliveryActionRaw.startedAt === "string" ? deliveryActionRaw.startedAt : null,
            completedAt: typeof deliveryActionRaw.completedAt === "string" ? deliveryActionRaw.completedAt : null,
            recipientCount: typeof deliveryActionRaw.recipientCount === "number" ? deliveryActionRaw.recipientCount : 0,
            successCount: typeof deliveryActionRaw.successCount === "number" ? deliveryActionRaw.successCount : 0,
            failureCount: typeof deliveryActionRaw.failureCount === "number" ? deliveryActionRaw.failureCount : 0,
        }
        : null;
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
                    successCount: typeof distribution.successCount === "number" ? distribution.successCount : 0,
                    failureCount: typeof distribution.failureCount === "number" ? distribution.failureCount : 0,
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
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
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
    try {
        const strategy = await runCeoStrategyHeartbeat(runId);
        return {
            runId,
            status: strategy.status,
            draftRequired: false,
            finalOutput: strategy.strategyOutput,
            strategyOutput: strategy.strategyOutput,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await pool.query(`UPDATE workflow_runs
       SET status = 'failed',
           waiting_for_strategy_approval = FALSE,
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`, [
            runId,
            input.auth.tenantId,
            input.auth.userId,
            JSON.stringify({ loop_executor: { failedAt: new Date().toISOString(), error: { message } } }),
        ]);
        throw error;
    }
}
//# sourceMappingURL=executor.js.map
