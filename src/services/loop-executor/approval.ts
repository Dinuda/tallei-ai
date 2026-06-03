/**
 * approval.ts — Human approval flows for loop runs (strategy, draft, recipients).
 */

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { consumeWorkflowApprovalToken, resolveWorkflowApprovalToken } from "../approval-tokens.js";
import { normalizeRosterAgents, isDynamicPlanDefinition } from "./plan.js";
import {
  assertRunAccess,
  loadRunContext,
  mergeLoopExecutorMeta,
  readLoopExecutorMeta,
} from "./run-context.js";
import { scheduleHeartbeat } from "./run-heartbeat.js";
import { insertComment, insertEvent, readObject } from "./run-store.js";
import { materializeTasksFromPlan, materializeTasksFromRoster } from "./run-strategy.js";
import { getEffectiveLoopConstraints, validateAgentRoster } from "./tool-catalog.js";
import { isNewsletterLoopDefinition } from "./delivery-format.js";
import { normalizeNewsletterTemplateId, parseContactListCsv } from "./presets/newsletter.js";

const DELIVERY_RECIPIENTS_INPUT_ID = "delivery_recipients";

async function transitionRunToDelivery(input: {
  tenantId: string;
  userId: string;
  runId: string;
  approvedBy: string;
}) {
  const runResult = await pool.query<{ id: string; workflow_id: string; status: string; metadata_json: unknown }>(
    `SELECT id, workflow_id, status, metadata_json FROM workflow_runs
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1`,
    [input.runId, input.tenantId, input.userId]
  );
  const run = runResult.rows[0];
  if (!run) throw new Error("Workflow run not found");

  const meta = readObject(run.metadata_json);
  const loopExecutor = readObject(meta.loop_executor);
  const approvalRequest = readObject(loopExecutor.approvalRequest);
  const hasApprovalContext = typeof approvalRequest.token === "string"
    || typeof approvalRequest.approvalUrl === "string"
    || typeof approvalRequest.sentAt === "string";
  if (!hasApprovalContext && input.approvedBy !== "email") {
    throw new Error("Run has no approval context to continue");
  }

  const canApproveFromStatus = run.status === "waiting_for_approval" || run.status === "waiting_for_email_approval" || run.status === "blocked";
  if (!canApproveFromStatus) {
    if (["waiting_for_contact_list", "executing_action", "completed"].includes(run.status)) {
      return { runId: run.id, workflowId: run.workflow_id, status: run.status };
    }
    throw new Error(`Run is ${run.status}, not waiting for approval`);
  }

  const approvedAt = new Date().toISOString();
  await pool.query(
    `UPDATE workflow_runs SET status = 'waiting_for_contact_list',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      run.id,
      input.tenantId,
      input.userId,
      JSON.stringify({
        loop_executor: {
          ...loopExecutor,
          approvalDecision: { approvedAt, channel: input.approvedBy },
          pendingInput: {
            id: DELIVERY_RECIPIENTS_INPUT_ID,
            kind: "csv",
            label: "Delivery recipients",
            status: "pending",
            requestedAt: approvedAt,
            instructions: "Upload a CSV with `email` and optional `name` columns to continue delivery.",
            schema: { requiredColumns: ["email"], optionalColumns: ["name"], maxRows: 5000 },
          },
        },
      }),
    ]
  );
  return { runId: run.id, workflowId: run.workflow_id, status: "waiting_for_contact_list" };
}

export async function ensureRunApproved(input: { tenantId: string; userId: string; runId: string }): Promise<boolean> {
  const runResult = await pool.query<{ status: string }>(
    `SELECT status FROM workflow_runs WHERE id = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1`,
    [input.runId, input.tenantId, input.userId]
  );
  const run = runResult.rows[0];
  if (!run) throw new Error("Workflow run not found");
  if (run.status !== "waiting_for_approval" && run.status !== "waiting_for_email_approval") return false;
  await transitionRunToDelivery({ ...input, approvedBy: "csv_upload" });
  return true;
}

export async function approveLoopRunFromUi(input: { auth: AuthContext; runId: string }) {
  const approved = await transitionRunToDelivery({
    tenantId: input.auth.tenantId,
    userId: input.auth.userId,
    runId: input.runId,
    approvedBy: "ui",
  });
  return { runId: approved.runId, workflowId: approved.workflowId, status: approved.status };
}

export async function approveLoopRunApprovalToken(token: string) {
  const resolved = await resolveWorkflowApprovalToken(token);
  if (!resolved) throw new Error("Approval token not found");
  if (resolved.expired) throw new Error("Approval token expired");
  if (resolved.consumedAt) throw new Error("Approval token already used");
  if (resolved.targetType !== "workflow_run") throw new Error("Invalid approval target");

  const approved = await transitionRunToDelivery({
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    runId: resolved.targetId,
    approvedBy: "email",
  });
  await consumeWorkflowApprovalToken(token);
  return { runId: approved.runId, workflowId: approved.workflowId, status: approved.status };
}

/** Upload recipient CSV and start distribution heartbeat. */
export async function uploadDeliveryRecipients(input: { auth: AuthContext; runId: string; csv: string; templateId?: string | null }) {
  await assertRunAccess(input.auth, input.runId);
  await ensureRunApproved({ tenantId: input.auth.tenantId, userId: input.auth.userId, runId: input.runId });

  const context = await loadRunContext(input.runId);
  const uploadableStatuses = new Set(["waiting_for_contact_list", "waiting_for_input"]);
  if (!uploadableStatuses.has(context.runStatus)) {
    throw new Error(`Run is ${context.runStatus}, not waiting for recipient upload`);
  }

  const contacts = parseContactListCsv(input.csv);
  const integrations = new Set(context.definition.allowedIntegrations.map((integration) => integration.trim().toLowerCase()));
  const toolRefs = new Set((context.definition.allowedToolRefs ?? []).map((ref) => ref.trim()));
  const reactEmailEnabled = isNewsletterLoopDefinition(context.definition)
    || integrations.has("react_email")
    || toolRefs.has("internal.react_email_template");
  const templateRequested = typeof input.templateId === "string" && input.templateId.trim().length > 0;
  const deliveryTemplateId = reactEmailEnabled || templateRequested ? normalizeNewsletterTemplateId(input.templateId) : undefined;
  const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
    pendingInput: {
      id: DELIVERY_RECIPIENTS_INPUT_ID,
      kind: "csv",
      label: "Delivery recipients",
      status: "submitted",
      requestedAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
      instructions: "Recipient list submitted.",
      schema: { requiredColumns: ["email"], optionalColumns: ["name"], maxRows: 5000 },
    },
    deliveryRecipients: {
      uploadedAt: new Date().toISOString(),
      contacts,
      recipientCount: contacts.length,
    },
    ...(deliveryTemplateId ? { deliveryTemplateId } : {}),
    deliveryAction: {
      kind: "send_broadcast",
      status: "in_progress",
      startedAt: new Date().toISOString(),
      recipientCount: contacts.length,
      successCount: 0,
      failureCount: 0,
    },
  });

  await pool.query(
    `UPDATE workflow_runs SET status = 'executing_action', connector_action_status = 'distribution_pending',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      context.runId,
      context.tenantId,
      context.userId,
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]
  );
  await insertEvent({
    context,
    eventType: "delivery_recipients_uploaded",
    payload: { recipientCount: contacts.length, ...(deliveryTemplateId ? { templateId: deliveryTemplateId } : {}) },
  });
  await scheduleHeartbeat({
    tenantId: context.tenantId,
    userId: context.userId,
    runId: context.runId,
    jobType: "distribution",
  });

  const after = await loadRunContext(input.runId);
  const loopExecutor = readObject(readObject(after.metadataJson).loop_executor);
  const deliveryBatch = readObject(loopExecutor.deliveryBatch);
  const broadcastId = typeof deliveryBatch.broadcastId === "string" ? deliveryBatch.broadcastId : undefined;
  return {
    runId: context.runId,
    status: after.runStatus,
    recipientCount: contacts.length,
    ...(deliveryTemplateId ? { templateId: deliveryTemplateId } : {}),
    ...(broadcastId ? { broadcastId } : {}),
  };
}

/** @deprecated Use uploadDeliveryRecipients */
export const uploadLoopRunContacts = uploadDeliveryRecipients;

export async function submitLoopRunInput(input: { auth: AuthContext; runId: string; inputId: string; value: string }) {
  const inputId = input.inputId.trim().toLowerCase();
  if (![DELIVERY_RECIPIENTS_INPUT_ID, "contacts", "contact_list", "recipient_list_csv"].includes(inputId)) {
    throw new Error(`Unsupported input id: ${input.inputId}`);
  }
  return uploadDeliveryRecipients({ auth: input.auth, runId: input.runId, csv: input.value });
}

/** Operator approves CEO strategy and materializes agent tasks. */
export async function approveLoopStrategy(input: {
  auth: AuthContext;
  runId: string;
  roster?: import("./types.js").LoopRunAgent[];
}) {
  await assertRunAccess(input.auth, input.runId);
  const context = await loadRunContext(input.runId);
  if (context.runStatus !== "waiting_for_strategy_approval") {
    throw new Error(`Run is ${context.runStatus}, not waiting_for_strategy_approval`);
  }

  const runMeta = readLoopExecutorMeta(context.metadataJson);
  const rosterSource = input.roster ?? runMeta.approvedRoster ?? runMeta.proposedRoster;
  if (!rosterSource?.length) throw new Error("No agent roster is available to approve");

  const roster = normalizeRosterAgents(rosterSource);
  const constraints = getEffectiveLoopConstraints(context.definition);
  const rosterValidation = await validateAgentRoster({ agents: roster, definition: constraints, auth: input.auth });
  if (!rosterValidation.ok) {
    throw new Error((rosterValidation.issues ?? []).map((issue) => issue.message).join("; "));
  }

  const strategyOutput = (await pool.query<{ strategy_output: string | null }>(
    `SELECT strategy_output FROM workflow_runs WHERE id = $1 LIMIT 1`,
    [context.runId]
  )).rows[0]?.strategy_output ?? "";

  if (isDynamicPlanDefinition(context.definition)) {
    await materializeTasksFromPlan({ context, plan: context.definition.plan!, strategyOutput });
  } else {
    await materializeTasksFromRoster({ context, roster, strategyOutput });
  }

  const firstTask = await pool.query<{ id: string }>(
    `SELECT id FROM loop_run_tasks WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3
       AND status = 'todo' ORDER BY seq ASC LIMIT 1`,
    [context.runId, context.tenantId, context.userId]
  );
  const firstTaskId = firstTask.rows[0]?.id ?? null;

  const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
    approvedRoster: roster,
    rosterApprovedAt: new Date().toISOString(),
  });
  await pool.query(
    `UPDATE workflow_runs SET status = 'strategy_approved', waiting_for_strategy_approval = FALSE,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      context.runId,
      context.tenantId,
      context.userId,
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]
  );
  await insertComment({ context, author: "user", body: "Strategy approved. Agents may begin execution." });
  await insertEvent({ context, eventType: "strategy_approved", payload: { firstTaskId, agentCount: roster.length } });

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
  return { runId: context.runId, status: "strategy_approved", firstTaskId };
}

export async function resumeLoopRunExecution(input: { auth: AuthContext; runId: string }) {
  await assertRunAccess(input.auth, input.runId);
  const context = await loadRunContext(input.runId);
  const resumableStatuses = new Set(["strategy_approved", "running", "blocked", "executing_action"]);
  if (!resumableStatuses.has(context.runStatus)) {
    throw new Error(`Run is ${context.runStatus}, cannot resume agent execution`);
  }

  if (context.runStatus === "executing_action") {
    const loopExecutor = readObject(readObject(context.metadataJson).loop_executor);
    const recipients = readObject(loopExecutor.deliveryRecipients);
    const contactsRaw = Array.isArray(recipients.contacts) ? recipients.contacts : [];
    if (contactsRaw.length === 0) throw new Error("Run is executing delivery but has no uploaded recipients");
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
    await pool.query(
      `UPDATE loop_run_tasks SET status = 'todo', checkout_locked_at = NULL, completed_at = NULL, updated_at = NOW()
       WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3
         AND error_json @> '{"retryable": true}'::jsonb AND status IN ('todo', 'blocked')`,
      [context.runId, context.tenantId, context.userId]
    );
  }

  const firstTask = await pool.query<{ id: string }>(
    `SELECT id FROM loop_run_tasks WHERE workflow_run_id = $1 AND tenant_id = $2 AND user_id = $3
       AND status = 'todo' ORDER BY seq ASC LIMIT 1`,
    [context.runId, context.tenantId, context.userId]
  );
  const firstTaskId = firstTask.rows[0]?.id ?? null;

  if (firstTaskId || context.runStatus === "blocked") {
    await pool.query(
      `UPDATE workflow_runs SET status = 'running', waiting_for_strategy_approval = FALSE,
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [
        context.runId,
        context.tenantId,
        context.userId,
        JSON.stringify({ loop_executor: { resumedAt: new Date().toISOString() } }),
      ]
    );
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
  } else {
    await scheduleHeartbeat({
      tenantId: context.tenantId,
      userId: context.userId,
      runId: context.runId,
      jobType: "ceo_finalize",
      resetAttempts: context.runStatus === "blocked",
    });
  }
  return {
    runId: context.runId,
    status: firstTaskId || context.runStatus === "blocked" ? "running" : context.runStatus,
    firstTaskId,
  };
}

/** Apply agent email-approval tool result to run state. */
export async function applyEmailApprovalResult(input: {
  context: import("./run-context.js").LoopRunContext;
  taskId: string;
  approvalRequest: { to: string; approvalUrl: string; token: string; sentAt: string; channel?: string };
  artifactBody: string;
}) {
  const loopExecutorPatch = mergeLoopExecutorMeta(input.context.metadataJson, {
    approvalRequest: { ...input.approvalRequest, channel: "email", artifactKind: "draft" },
    artifactBody: input.artifactBody,
  });
  await pool.query(
    `UPDATE workflow_runs SET status = 'waiting_for_email_approval', draft_output = $4,
         connector_action_status = 'pending_approval',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      input.context.runId,
      input.context.tenantId,
      input.context.userId,
      input.artifactBody,
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ]
  );
  await insertEvent({
    context: input.context,
    taskId: input.taskId,
    eventType: "run_approval_email_sent",
    payload: { to: input.approvalRequest.to, approvalUrl: input.approvalRequest.approvalUrl },
  });
}
