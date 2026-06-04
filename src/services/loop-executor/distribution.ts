/**
 * distribution.ts — Outbound delivery heartbeat (e.g. Resend broadcast).
 */

import { pool } from "../../infrastructure/db/index.js";
import { deliverStatusNotification } from "../channels.js";
import { isNewsletterLoopDefinition, resolveDeliveryFormatter } from "./delivery-format.js";
import { newsletterDeliveryFormatter } from "./presets/newsletter.js";
import { enqueueLoopHeartbeatJob } from "./heartbeat-jobs.js";
import { isDynamicPlanDefinition } from "./plan.js";
import { authFromContext, loadRunContext, mergeLoopExecutorMeta } from "./run-context.js";
import { scheduleDelayedHeartbeatDispatch } from "./run-heartbeat.js";
import { synthesizeFinalOutput } from "./run-llm.js";
import { insertComment, insertEvent, insertOrUpdateArtifact, loadRunComments, readObject } from "./run-store.js";
import type { LoopRunContext } from "./run-context.js";

const GMAIL_CLIPPING_WARNING_BYTES = 95_000;

function readDeliveryMeta(loopExecutor: Record<string, unknown>) {
  return readObject(loopExecutor.deliveryBatch ?? loopExecutor.distribution);
}

function readRecipients(loopExecutor: Record<string, unknown>) {
  return readObject(loopExecutor.deliveryRecipients ?? loopExecutor.contactList);
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

export async function runDistributionHeartbeat(runId: string) {
    const context = await loadRunContext(runId);
    if (context.runStatus !== "executing_action") {
        throw new Error(`Run is ${context.runStatus}, not executing delivery action`);
    }
    const auth = authFromContext(context);
    const root = readObject(context.metadataJson);
    const loopExecutor = readObject(root.loop_executor);
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
        const broadcastError = broadcast.error ?? "Failed to send Resend broadcast";
        const failedRecipients = contacts.map((contact) => ({
            email: contact.email,
            ok: false,
            error: broadcastError,
        }));
        const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
            distribution: {
                ...inProgressMeta,
                nextIndex: contacts.length,
                successCount: 0,
                failureCount: contacts.length,
                broadcastError,
                recipients: failedRecipients,
            },
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
async function finalizeDistributionRun(input: {
    context: LoopRunContext;
    loopExecutor: Record<string, unknown>;
    deliveryBody: string;
    contacts: Array<{ email: string; name?: string }>;
    distributionMeta: Record<string, unknown>;
    recipientResults: Array<{ email: string; ok: boolean; error?: string }>;
    finalStatus: "completed" | "blocked";
}) {
    const { context, loopExecutor, deliveryBody, contacts, distributionMeta, recipientResults, finalStatus } = input;
    const auth = authFromContext(context);
    const successCount = recipientResults.filter((recipient) => recipient.ok).length;
    const failureCount = recipientResults.filter((recipient) => !recipient.ok).length;
    const dryRun = distributionMeta.dryRun === true || isDryRunBroadcastId(typeof distributionMeta.broadcastId === "string" ? distributionMeta.broadcastId : null);
    const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, { deliveryBatch: distributionMeta });
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
            dryRun
                ? `Distribution needs review: outbound email is disabled, so no email was sent to ${contacts.length} contact(s).`
                : `Distribution ${finalStatus === "completed" ? "complete" : "needs review"}: Resend broadcast ${broadcastId ?? "pending"} submitted for ${successCount} contact(s), ${failureCount} failure(s).`,
            failedRecipients.length > 0 ? `Failed recipients: ${failedRecipients.join(", ")}` : null,
            dryRun ? null : "Broadcast sends use Resend marketing delivery (not transactional email). Delivery and bounces are tracked in Resend.",
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
                lastDeliveryRecipients: loopExecutor.deliveryRecipients ?? loopExecutor.contactList ?? null,
                lastDeliveryBatch: distributionMeta,
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
        body: dryRun
            ? `Outbound email is disabled, so no email was sent to ${contacts.length} recipients.`
            : `Submitted to ${successCount} recipients. ${failureCount > 0 ? `${failureCount} failed.` : "No delivery failures were reported."}`,
        metadata: { workflowId: context.workflowId, runId: context.runId, status: finalStatus },
    }).catch(() => undefined);
    await insertEvent({
        context,
        eventType: "broadcast_sent",
        payload: distributionMeta,
    });
    return { runId: context.runId, status: finalStatus };
}
