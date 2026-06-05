/**
 * distribution.ts — Outbound delivery heartbeat (e.g. Resend broadcast).
 */

import { pool } from "../../infrastructure/db/index.js";
import { deliverStatusNotification } from "../channels.js";
import { isNewsletterLoopDefinition, resolveDeliveryFormatter } from "./delivery-format.js";
import { newsletterDeliveryFormatter } from "./presets/newsletter.js";
import { enqueueLoopHeartbeatJob } from "./heartbeat-jobs.js";
import { isDynamicPlanDefinition } from "./plan.js";
import { authFromContext, loadRunContext, mergeLoopExecutorMeta, readLoopExecutorMeta } from "./run-context.js";
import { scheduleDelayedHeartbeatDispatch } from "./run-heartbeat.js";
import { synthesizeFinalOutput } from "./run-llm.js";
import { insertComment, insertEvent, insertOrUpdateArtifact, loadRunComments, readObject } from "./run-store.js";
import { findDeliveryAgentTaskId } from "./run-strategy.js";
import type { LoopRunContext } from "./run-context.js";

const GMAIL_CLIPPING_WARNING_BYTES = 95_000;

function readDeliveryMeta(loopExecutor: Record<string, unknown>) {
  return readObject(loopExecutor.deliveryBatch ?? loopExecutor.distribution);
}

function readRecipients(loopExecutor: Record<string, unknown>) {
  return readObject(loopExecutor.deliveryRecipients ?? loopExecutor.contactList);
}

export function readDeliveryCompletionState(metadataJson: unknown) {
  const loopExecutor = readLoopExecutorMeta(metadataJson);
  const deliveryAction = readObject(loopExecutor.deliveryAction);
  const distribution = readDeliveryMeta(loopExecutor as unknown as Record<string, unknown>);
  const actionStatus = typeof deliveryAction.status === "string" ? deliveryAction.status : "";
  const broadcastId = typeof distribution.broadcastId === "string" && distribution.broadcastId.trim()
    ? distribution.broadcastId.trim()
    : typeof deliveryAction.broadcastId === "string" && deliveryAction.broadcastId.trim()
      ? deliveryAction.broadcastId.trim()
      : null;
  const finished = ["completed", "partial_failure", "failed"].includes(actionStatus) || Boolean(broadcastId);
  const inFlight = ["in_progress", "syncing_contacts"].includes(actionStatus) && !finished;
  return {
    finished,
    inFlight,
    broadcastId,
    actionStatus,
    deliveryAgentTaskId: typeof loopExecutor.deliveryAgentTaskId === "string" ? loopExecutor.deliveryAgentTaskId : null,
  };
}

async function resolveDeliveryAgentTaskId(context: LoopRunContext, taskId?: string | null): Promise<string | null> {
  if (taskId) return taskId;
  const fromMeta = readDeliveryCompletionState(context.metadataJson).deliveryAgentTaskId;
  if (fromMeta) return fromMeta;
  return findDeliveryAgentTaskId(context);
}

async function hasActiveDistributionHeartbeat(runId: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `SELECT id
     FROM loop_heartbeat_jobs
     WHERE workflow_run_id = $1
       AND job_type = 'distribution'
       AND status IN ('pending', 'processing')
     LIMIT 1`,
    [runId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** True when a distribution heartbeat should be (re)scheduled — never after send or while one is running. */
export async function shouldScheduleDistributionResume(context: LoopRunContext): Promise<boolean> {
  const state = readDeliveryCompletionState(context.metadataJson);
  if (state.finished) return false;
  if (await hasActiveDistributionHeartbeat(context.runId)) return false;
  const deliveryTaskId = await resolveDeliveryAgentTaskId(context, state.deliveryAgentTaskId);
  if (deliveryTaskId) {
    const taskResult = await pool.query<{ status: string }>(
      `SELECT status
       FROM loop_run_tasks
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3
       LIMIT 1`,
      [deliveryTaskId, context.tenantId, context.userId],
    );
    const taskStatus = taskResult.rows[0]?.status;
    if (taskStatus === "done" || taskStatus === "completed") return false;
  }
  return true;
}

async function persistBroadcastClaim(input: {
  context: LoopRunContext;
  broadcastId: string;
  distributionMeta: Record<string, unknown>;
  deliveryAgentTaskId: string | null;
}): Promise<boolean> {
  const loopExecutorPatch = mergeLoopExecutorMeta(input.context.metadataJson, {
    deliveryBatch: {
      ...input.distributionMeta,
      broadcastId: input.broadcastId,
      sentAt: new Date().toISOString(),
    },
    ...(input.deliveryAgentTaskId ? { deliveryAgentTaskId: input.deliveryAgentTaskId } : {}),
    deliveryAction: {
      kind: "send_broadcast",
      status: "in_progress",
      broadcastId: input.broadcastId,
      startedAt: typeof input.distributionMeta.startedAt === "string" ? input.distributionMeta.startedAt : new Date().toISOString(),
      recipientCount: typeof input.distributionMeta.recipientCount === "number" ? input.distributionMeta.recipientCount : 0,
    },
  });
  const result = await pool.query(
    `UPDATE workflow_runs
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND COALESCE(metadata_json #>> '{loop_executor,deliveryBatch,broadcastId}', '') = ''
       AND COALESCE(metadata_json #>> '{loop_executor,distribution,broadcastId}', '') = ''
     RETURNING id`,
    [
      input.context.runId,
      input.context.tenantId,
      input.context.userId,
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

function readCustomEmailHtml(loopExecutor: Record<string, unknown>): string | null {
    if (typeof loopExecutor.deliveryEmailHtml === "string" && loopExecutor.deliveryEmailHtml.trim()) {
        return loopExecutor.deliveryEmailHtml;
    }
    const emailTemplate = readObject(loopExecutor.emailTemplate);
    if (typeof emailTemplate.html === "string" && emailTemplate.html.trim()) {
        return emailTemplate.html;
    }
    return null;
}

function isDryRunBroadcastId(value: string | null | undefined): boolean {
    return typeof value === "string" && value.startsWith("dry_broadcast_");
}

function buildTrackingDiagnostics(input: {
    html: string;
    text: string;
    webhook?: Record<string, unknown> | null;
}) {
    const htmlBytes = Buffer.byteLength(input.html ?? "", "utf8");
    const textBytes = Buffer.byteLength(input.text ?? "", "utf8");
    return {
        htmlBytes,
        textBytes,
        gmailClippingRisk: htmlBytes >= GMAIL_CLIPPING_WARNING_BYTES,
        gmailClippingWarningBytes: GMAIL_CLIPPING_WARNING_BYTES,
        openTracking: "best_effort_pixel",
        note: "Resend email.opened depends on the recipient loading the HTML tracking pixel. Image blocking, privacy proxies, security scanners, and Gmail clipping can hide or distort opens; clicks are more reliable engagement events.",
        webhookEndpoint: typeof input.webhook?.endpoint === "string" ? input.webhook.endpoint : null,
    };
}

async function markDeliveryTaskStarted(context: LoopRunContext, taskId: string | null): Promise<void> {
    if (!taskId) return;
    await pool.query(
        `UPDATE loop_run_tasks
         SET status = 'in_progress',
             started_at = COALESCE(started_at, NOW()),
             checkout_locked_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3
           AND status IN ('todo', 'in_progress')`,
        [taskId, context.tenantId, context.userId],
    );
    await insertEvent({
        context,
        taskId,
        eventType: "broadcast_delivery_started",
        payload: { provider: "resend_broadcast" },
    });
}

async function markDeliveryTaskFinished(input: {
    context: LoopRunContext;
    taskId: string | null;
    finalStatus: "completed" | "blocked";
    distributionMeta: Record<string, unknown>;
    successCount: number;
    failureCount: number;
}): Promise<string | null> {
    const taskId = await resolveDeliveryAgentTaskId(input.context, input.taskId);
    if (!taskId) return null;
    await pool.query(
        `UPDATE loop_run_tasks
         SET status = $4,
             output_json = $5::jsonb,
             completed_at = NOW(),
             checkout_locked_at = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3`,
        [
            taskId,
            input.context.tenantId,
            input.context.userId,
            input.finalStatus === "completed" ? "done" : "blocked",
            JSON.stringify({
                text: input.finalStatus === "completed"
                    ? `Broadcast delivery complete: ${input.successCount} submitted, ${input.failureCount} failed.`
                    : `Broadcast delivery needs review: ${input.successCount} submitted, ${input.failureCount} failed.`,
                distribution: input.distributionMeta,
                successCount: input.successCount,
                failureCount: input.failureCount,
            }),
        ],
    );
    return taskId;
}

function readDeliveryBody(context: LoopRunContext, loopExecutor: Record<string, unknown>): string {
    const rawDeliveryBody = typeof loopExecutor.deliveryContentBody === "string" && loopExecutor.deliveryContentBody.trim()
        ? loopExecutor.deliveryContentBody.trim()
        : typeof loopExecutor.artifactBody === "string" && loopExecutor.artifactBody.trim()
            ? loopExecutor.artifactBody.trim()
            : context.draftOutput?.trim() ?? "";
    const formatter = resolveDeliveryFormatter(context.definition, rawDeliveryBody);
    return formatter.sanitizeBody(rawDeliveryBody) || rawDeliveryBody.trim();
}

async function commitDeliveryRunCompletion(input: {
    context: LoopRunContext;
    loopExecutor: Record<string, unknown>;
    deliveryBody: string;
    contacts: Array<{ email: string; name?: string }>;
    distributionMeta: Record<string, unknown>;
    recipientResults: Array<{ email: string; ok: boolean; error?: string }>;
    finalStatus: "completed" | "blocked";
    deliveryAgentTaskId?: string | null;
}): Promise<{ runId: string; status: string; deliveryAgentTaskId: string | null }> {
    const { context, loopExecutor, deliveryBody, contacts, distributionMeta, recipientResults, finalStatus } = input;
    const successCount = recipientResults.filter((recipient) => recipient.ok).length;
    const failureCount = recipientResults.filter((recipient) => !recipient.ok).length;
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
        deliveryBatch: distributionMeta,
    });
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
    const deliveryAgentTaskId = await markDeliveryTaskFinished({
        context,
        taskId: input.deliveryAgentTaskId ?? null,
        finalStatus,
        distributionMeta,
        successCount,
        failureCount,
    });
    const mergedLoopExecutor = deliveryAgentTaskId
        ? mergeLoopExecutorMeta({ loop_executor: loopExecutorPatchWithAction.loop_executor }, {
            deliveryAgentTaskId,
        }).loop_executor
        : loopExecutorPatchWithAction.loop_executor;
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
        JSON.stringify({ loop_executor: mergedLoopExecutor }),
    ]);
    await pool.query(`UPDATE workflows
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`, [
        context.workflowId,
        JSON.stringify({
            loop_executor: {
                lastDeliveryRecipients: loopExecutor.deliveryRecipients ?? loopExecutor.contactList ?? null,
                lastDeliveryBatch: distributionMeta,
                lastDeliveryAction: {
                    kind: "send_broadcast",
                    status: finalStatus === "completed" ? "completed" : "partial_failure",
                    completedAt: new Date().toISOString(),
                    successCount,
                    failureCount,
                    recipientCount: contacts.length,
                    broadcastId: typeof distributionMeta.broadcastId === "string" ? distributionMeta.broadcastId : undefined,
                },
            },
        }),
    ]);
    return { runId: context.runId, status: finalStatus, deliveryAgentTaskId };
}

/** Finish a run whose broadcast already sent but run/task status was not committed. */
export async function ensureDeliveryRunFinished(runId: string, taskId?: string | null) {
    const context = await loadRunContext(runId);
    const root = readObject(context.metadataJson);
    const loopExecutor = readObject(root.loop_executor);
    const state = readDeliveryCompletionState(context.metadataJson);
    if (!state.broadcastId) return null;

    const deliveryAgentTaskId = await resolveDeliveryAgentTaskId(context, taskId ?? state.deliveryAgentTaskId);
    let taskStatus: string | null = null;
    if (deliveryAgentTaskId) {
        const taskResult = await pool.query<{ status: string }>(
            `SELECT status FROM loop_run_tasks
             WHERE id = $1 AND tenant_id = $2 AND user_id = $3
             LIMIT 1`,
            [deliveryAgentTaskId, context.tenantId, context.userId],
        );
        taskStatus = taskResult.rows[0]?.status ?? null;
    }
    const runNeedsUpdate = context.runStatus === "executing_action" || context.runStatus === "distributing";
    const taskNeedsUpdate = taskStatus === "in_progress" || taskStatus === "todo";
    if (!runNeedsUpdate && !taskNeedsUpdate) {
        return { runId: context.runId, status: context.runStatus };
    }

    const contactListRaw = readRecipients(loopExecutor);
    const contactsRaw = Array.isArray(contactListRaw.contacts) ? contactListRaw.contacts : [];
    const contacts = contactsRaw
        .map((row) => readObject(row))
        .map((row) => ({
            email: typeof row.email === "string" ? row.email.trim().toLowerCase() : "",
            name: typeof row.name === "string" ? row.name.trim() : undefined,
        }))
        .filter((row) => row.email.length > 0);
    const distribution = readDeliveryMeta(loopExecutor);
    const dryRun = isDryRunBroadcastId(state.broadcastId) || distribution.dryRun === true;
    const storedRecipients = Array.isArray(distribution.recipients)
        ? distribution.recipients.map((row) => readObject(row)).map((row) => ({
            email: typeof row.email === "string" ? row.email.trim().toLowerCase() : "",
            ok: row.ok === true,
            ...(typeof row.error === "string" ? { error: row.error } : {}),
        })).filter((row) => row.email.length > 0)
        : [];
    const recipientResults = storedRecipients.length > 0
        ? storedRecipients
        : contacts.map((contact) => ({
            email: contact.email,
            ok: !dryRun,
            ...(dryRun ? { error: "Outbound email dry-run; no email was sent" } : {}),
        }));
    const successCount = typeof distribution.successCount === "number"
        ? distribution.successCount
        : recipientResults.filter((recipient) => recipient.ok).length;
    const failureCount = typeof distribution.failureCount === "number"
        ? distribution.failureCount
        : recipientResults.length - successCount;
    const distributionMeta = {
        ...distribution,
        broadcastId: state.broadcastId,
        sentAt: typeof distribution.sentAt === "string" ? distribution.sentAt : new Date().toISOString(),
        successCount,
        failureCount,
        recipientCount: contacts.length || recipientResults.length,
        recipients: recipientResults,
    };
    const finalStatus: "completed" | "blocked" = dryRun || failureCount > 0 ? "blocked" : "completed";
    return finalizeDistributionRun({
        context,
        loopExecutor,
        deliveryBody: readDeliveryBody(context, loopExecutor),
        contacts: contacts.length > 0 ? contacts : recipientResults.map((row) => ({ email: row.email })),
        distributionMeta,
        recipientResults,
        finalStatus,
        deliveryAgentTaskId,
    });
}

export async function runDistributionHeartbeat(runId: string, taskId?: string | null) {
    const context = await loadRunContext(runId);
    const completion = readDeliveryCompletionState(context.metadataJson);
    if (context.runStatus !== "executing_action") {
        if (completion.broadcastId) {
            return ensureDeliveryRunFinished(runId, taskId);
        }
        throw new Error(`Run is ${context.runStatus}, not executing delivery action`);
    }
    const auth = authFromContext(context);
    const root = readObject(context.metadataJson);
    const loopExecutor = readObject(root.loop_executor);
    const deliveryAgentTaskId = await resolveDeliveryAgentTaskId(context, taskId ?? null);
    await markDeliveryTaskStarted(context, deliveryAgentTaskId);
    const contactListRaw = readRecipients(loopExecutor);
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
            : context.draftOutput?.trim() ?? "";
    const formatter = resolveDeliveryFormatter(context.definition, rawDeliveryBody);
    const deliveryBody = formatter.sanitizeBody(rawDeliveryBody);
    if (!deliveryBody) {
        throw new Error("Delivery content is missing for distribution");
    }
    const formattedNewsletter = formatter.formatForDelivery(deliveryBody);
    const templateId = typeof loopExecutor.deliveryTemplateId === "string" ? loopExecutor.deliveryTemplateId : null;
    const integrations = new Set(context.definition.allowedIntegrations.map((integration) => integration.trim().toLowerCase()));
    const toolRefs = new Set((context.definition.allowedToolRefs ?? []).map((ref) => ref.trim()));
    const useReactEmail = formatter === newsletterDeliveryFormatter
        || isNewsletterLoopDefinition(context.definition)
        || Boolean(templateId)
        || integrations.has("react_email")
        || toolRefs.has("internal.react_email_template");
    const generatedContent = await formatter.formatForBroadcast(formattedNewsletter, { templateId, useReactEmail });
    const customEmailHtml = readCustomEmailHtml(loopExecutor);
    const broadcastContent = customEmailHtml
        ? { ...generatedContent, html: customEmailHtml }
        : generatedContent;
    const subject = formattedNewsletter.subject ?? context.workflowTitle;
    const existingDistribution = readDeliveryMeta(loopExecutor);
    const existingBroadcastId = typeof existingDistribution.broadcastId === "string"
        ? existingDistribution.broadcastId
        : null;
    if (existingBroadcastId) {
        const dryRun = isDryRunBroadcastId(existingBroadcastId) || existingDistribution.dryRun === true;
        const recipientResults = contacts.map((contact) => ({
            email: contact.email,
            ok: !dryRun,
            providerMessageId: existingBroadcastId,
            ...(dryRun ? { error: "Outbound email dry-run; no email was sent" } : {}),
        }));
        const distributionMeta = {
            ...existingDistribution,
            startedAt: typeof existingDistribution.startedAt === "string" ? existingDistribution.startedAt : new Date().toISOString(),
            sentAt: new Date().toISOString(),
            successCount: dryRun ? 0 : contacts.length,
            failureCount: dryRun ? contacts.length : 0,
            openCount: typeof existingDistribution.openCount === "number" ? existingDistribution.openCount : 0,
            clickCount: typeof existingDistribution.clickCount === "number" ? existingDistribution.clickCount : 0,
            unsubscribeCount: typeof existingDistribution.unsubscribeCount === "number" ? existingDistribution.unsubscribeCount : 0,
            openRate: typeof existingDistribution.openRate === "number" ? existingDistribution.openRate : 0,
            clickRate: typeof existingDistribution.clickRate === "number" ? existingDistribution.clickRate : 0,
            recipientCount: contacts.length,
            nextIndex: contacts.length,
            provider: "resend_broadcast",
            emailSource: customEmailHtml ? "builder" : "react_email",
            broadcastId: existingBroadcastId,
            ...(dryRun ? { dryRun: true, broadcastError: "Outbound email is disabled; Resend was not called." } : {}),
            recipients: recipientResults,
        };
        return finalizeDistributionRun({
            context,
            loopExecutor,
            deliveryBody,
            contacts,
            distributionMeta,
            recipientResults,
            finalStatus: dryRun ? "blocked" : "completed",
            deliveryAgentTaskId,
        });
    }
    const { createAndSendResendBroadcast, createResendSegment, ensureResendMetricsWebhook, resolveResendMarketingCredentials, upsertResendContactInSegment, } = await import("../notifications/resend-broadcast.js");
    const creds = await resolveResendMarketingCredentials(auth);
    if (!creds) {
        throw new Error("Resend is not configured for marketing broadcasts. Connect Resend in workflow connector settings or set signup Resend environment variables.");
    }
    const webhook = await ensureResendMetricsWebhook({ auth, creds });
    if (!webhook.ok) {
        throw new Error(webhook.error ?? "Failed to configure Resend metrics webhook before sending broadcast");
    }
    const metricsWebhook = {
        id: typeof webhook.webhookId === "string" ? webhook.webhookId : null,
        endpoint: typeof webhook.endpoint === "string" ? webhook.endpoint : null,
        created: webhook.created === true,
        updated: webhook.updated === true,
        events: Array.isArray(webhook.events) ? webhook.events : [],
    };
    const trackingDiagnostics = buildTrackingDiagnostics({
        html: broadcastContent.html,
        text: broadcastContent.text,
        webhook: metricsWebhook,
    });
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
        openCount: typeof existingDistribution.openCount === "number" ? existingDistribution.openCount : 0,
        clickCount: typeof existingDistribution.clickCount === "number" ? existingDistribution.clickCount : 0,
        unsubscribeCount: typeof existingDistribution.unsubscribeCount === "number" ? existingDistribution.unsubscribeCount : 0,
        openRate: typeof existingDistribution.openRate === "number" ? existingDistribution.openRate : 0,
        clickRate: typeof existingDistribution.clickRate === "number" ? existingDistribution.clickRate : 0,
        recipientCount: contacts.length,
        nextIndex: processedCount,
        contactBatchSize,
        segmentId,
        provider: "resend_broadcast",
        emailSource: customEmailHtml ? "builder" : "react_email",
        metricsWebhook,
        trackingDiagnostics,
        recipients: recipientResults,
    };
    if (processedCount < contacts.length) {
        const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
            distribution: inProgressMeta,
            ...(deliveryAgentTaskId ? { deliveryAgentTaskId } : {}),
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
            taskId: deliveryAgentTaskId ?? undefined,
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
        const broadcastError = broadcast.error ?? "Failed to send Resend broadcast";
        const failedRecipients = contacts.map((contact) => ({
            email: contact.email,
            ok: false,
            error: broadcastError,
        }));
        const failedDistributionMeta = {
            ...inProgressMeta,
            nextIndex: contacts.length,
            successCount: 0,
            failureCount: contacts.length,
            broadcastError,
            recipients: failedRecipients,
        };
        const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
            distribution: failedDistributionMeta,
            deliveryAction: {
                kind: "send_broadcast",
                status: "failed",
                startedAt: typeof existingDistribution.startedAt === "string" ? existingDistribution.startedAt : new Date().toISOString(),
                completedAt: new Date().toISOString(),
                recipientCount: contacts.length,
                successCount: 0,
                failureCount: contacts.length,
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
        await markDeliveryTaskFinished({
            context,
            taskId: deliveryAgentTaskId,
            finalStatus: "blocked",
            distributionMeta: failedDistributionMeta,
            successCount: 0,
            failureCount: contacts.length,
        });
        throw new Error(broadcastError);
    }
    const dryRun = broadcast.dryRun === true || isDryRunBroadcastId(broadcast.broadcastId);
    const broadcastRecipients = contacts.map((contact) => {
        const synced = recipientResults.find((recipient) => recipient.email === contact.email);
        return {
            email: contact.email,
            ok: dryRun ? false : synced?.ok ?? false,
            providerMessageId: broadcast.broadcastId,
            ...(synced?.error ? { error: synced.error } : {}),
            ...(dryRun ? { error: "Outbound email dry-run; no email was sent" } : {}),
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
        metricsWebhook,
        trackingDiagnostics: {
            ...trackingDiagnostics,
            htmlBytes: typeof broadcast.htmlBytes === "number" ? broadcast.htmlBytes : trackingDiagnostics.htmlBytes,
            textBytes: typeof broadcast.textBytes === "number" ? broadcast.textBytes : trackingDiagnostics.textBytes,
            gmailClippingRisk: broadcast.gmailClippingRisk === true || trackingDiagnostics.gmailClippingRisk,
        },
        ...(dryRun ? { dryRun: true, broadcastError: "Outbound email is disabled; Resend was not called." } : {}),
        recipients: broadcastRecipients,
    };
    const claimed = await persistBroadcastClaim({
        context,
        broadcastId: broadcast.broadcastId,
        distributionMeta,
        deliveryAgentTaskId,
    });
    if (!claimed) {
        const freshContext = await loadRunContext(runId);
        const freshRoot = readObject(freshContext.metadataJson);
        const freshLoopExecutor = readObject(freshRoot.loop_executor);
        const existingBroadcastId = typeof readDeliveryMeta(freshLoopExecutor).broadcastId === "string"
            ? readDeliveryMeta(freshLoopExecutor).broadcastId as string
            : null;
        if (existingBroadcastId) {
            return runDistributionHeartbeat(runId, deliveryAgentTaskId);
        }
    }
    const finalStatus = broadcastFailureCount > 0 ? "blocked" : "completed";
    return finalizeDistributionRun({
        context,
        loopExecutor,
        deliveryBody,
        contacts,
        distributionMeta,
        recipientResults: broadcastRecipients,
        finalStatus,
        deliveryAgentTaskId,
    });
}
async function finalizeDistributionRun(input: {
    context: LoopRunContext;
    loopExecutor: Record<string, unknown>;
    deliveryBody: string;
    contacts: Array<{ email: string; name?: string }>;
    distributionMeta: Record<string, unknown>;
    recipientResults: Array<{ email: string; ok: boolean; error?: string }>;
    finalStatus: "completed" | "blocked";
    deliveryAgentTaskId?: string | null;
}) {
    const { context, loopExecutor, deliveryBody, contacts, distributionMeta, recipientResults, finalStatus, deliveryAgentTaskId = null } = input;
    const auth = authFromContext(context);
    const successCount = recipientResults.filter((recipient) => recipient.ok).length;
    const failureCount = recipientResults.filter((recipient) => !recipient.ok).length;
    const dryRun = distributionMeta.dryRun === true || isDryRunBroadcastId(typeof distributionMeta.broadcastId === "string" ? distributionMeta.broadcastId : null);
    const broadcastId = typeof distributionMeta.broadcastId === "string" ? distributionMeta.broadcastId : null;

    const committed = await commitDeliveryRunCompletion({
        context,
        loopExecutor,
        deliveryBody,
        contacts,
        distributionMeta,
        recipientResults,
        finalStatus,
        deliveryAgentTaskId,
    });
    const resolvedTaskId = committed.deliveryAgentTaskId;

    try {
        const comments = await loadRunComments(context);
        const finalOutput = await synthesizeFinalOutput(context, comments);
        const failedRecipients = recipientResults
            .filter((recipient) => !recipient.ok)
            .map((recipient) => `${recipient.email}${recipient.error ? ` (${recipient.error})` : ""}`);
        await insertComment({
            context,
            taskId: resolvedTaskId,
            author: "ceo",
            body: [
                finalOutput,
                "",
                dryRun
                    ? `Distribution needs review: outbound email is disabled, so no email was sent to ${contacts.length} contact(s).`
                    : `Distribution ${finalStatus === "completed" ? "complete" : "needs review"}: Resend broadcast ${broadcastId ?? "pending"} submitted for ${successCount} contact(s), ${failureCount} failure(s).`,
                failedRecipients.length > 0 ? `Failed recipients: ${failedRecipients.join(", ")}` : null,
                dryRun ? null : "Broadcast sends use Resend marketing delivery (not transactional email). Delivery and bounces are tracked in Resend.",
            ].filter(Boolean).join("\n"),
        });
    } catch (error) {
        console.error("[loop-executor] delivery finalize comment failed:", error);
        await insertComment({
            context,
            taskId: resolvedTaskId,
            author: "ceo",
            body: dryRun
                ? `Distribution needs review: outbound email is disabled, so no email was sent to ${contacts.length} contact(s).`
                : `Distribution ${finalStatus === "completed" ? "complete" : "needs review"}: Resend broadcast ${broadcastId ?? "pending"} submitted for ${successCount} contact(s), ${failureCount} failure(s).`,
        }).catch(() => undefined);
    }

    await insertEvent({
        context,
        taskId: resolvedTaskId,
        eventType: "ceo_finalized",
        payload: { draftRequired: false, draftCount: 0, status: finalStatus, distribution: distributionMeta },
    }).catch(() => undefined);
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
                approvalPolicy: {
                    required: true,
                    mode: "before",
                    channels: ["primary"],
                    onReject: "block",
                },
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
        }).catch(() => undefined);
    }
    await deliverStatusNotification({
        auth,
        title: finalStatus === "completed" ? `${context.workflowTitle} broadcast completed` : `${context.workflowTitle} broadcast needs review`,
        body: dryRun
            ? `Outbound email is disabled, so no email was sent to ${contacts.length} recipients.`
            : `Submitted to ${successCount} recipients. ${failureCount > 0 ? `${failureCount} failed.` : "No delivery failures were reported."}`,
        metadata: { workflowId: context.workflowId, runId: context.runId, status: finalStatus },
    }).catch(() => undefined);
    await insertEvent({
        context,
        taskId: resolvedTaskId,
        eventType: "broadcast_sent",
        payload: distributionMeta,
    }).catch(() => undefined);
    return { runId: context.runId, status: finalStatus };
}
