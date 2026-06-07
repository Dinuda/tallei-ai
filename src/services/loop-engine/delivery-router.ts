/**
 * delivery-router.ts — Provider-aware delivery dispatch for the agentic loop engine.
 */

import { pool } from "../../infrastructure/db/index.js";
import { listConnectorAccounts, selectComposioConnectorAdapter } from "../connectors/composio.js";
import { deliverStatusNotification } from "../channels.js";
import { runDistributionHeartbeat } from "../loop-executor/distribution.js";
import { authFromContext, loadRunContext, mergeLoopExecutorMeta, readLoopExecutorMeta } from "../loop-executor/run-context.js";
import { insertEvent, loadRunComments } from "../loop-executor/run-store.js";
import { markRunBlocked } from "../loop-executor/run-status.js";
import { resolveDeliveryFormatter } from "../loop-executor/delivery-format.js";
import type { LoopRunContext } from "../loop-executor/run-context.js";
import { assertDeliveryRouting, isEngineV3Definition } from "./contracts.js";

export function resolveDeliveryProvider(context: LoopRunContext): string | null {
  if (context.definition.delivery?.provider) {
    return context.definition.delivery.provider.trim().toLowerCase();
  }
  const children = context.definition.agentGraph?.children ?? [];
  const deliveryAgent = children.find((child) =>
    child.tools.some((tool) =>
      tool.ref === "internal.resend_broadcast" || tool.ref === "composio.gmail.send_email",
    ),
  );
  return deliveryAgent?.tools[0]?.ref?.trim().toLowerCase() ?? null;
}

export function assertEngineDeliveryRouting(context: LoopRunContext): void {
  if (!isEngineV3Definition(context.definition)) return;
  const delivery = context.definition.delivery;
  if (!delivery) return;
  assertDeliveryRouting(delivery);
  const provider = resolveDeliveryProvider(context);
  if (provider && provider !== delivery.provider.trim().toLowerCase()) {
    throw new Error(
      `Delivery routing mismatch: definition declares ${delivery.provider} but roster resolves to ${provider}`,
    );
  }
}

async function extractApprovedEmailBody(context: LoopRunContext): Promise<{ subject: string; text: string; html: string }> {
  const comments = await loadRunComments(context);
  const writer = [...comments].reverse().find((c) => /writer|draft|email/i.test(c.author));
  const body = writer?.body?.trim() ?? comments[comments.length - 1]?.body?.trim() ?? "";
  if (!body) throw new Error("No approved content found for delivery");
  const formatter = resolveDeliveryFormatter(context.definition, body);
  const formatted = formatter.formatForDelivery(body);
  return {
    subject: formatted.subject ?? `${context.workflowTitle}`,
    text: formatted.text,
    html: formatted.html,
  };
}

async function runGmailDelivery(context: LoopRunContext, taskId?: string | null) {
  const auth = authFromContext(context);
  const loopExecutor = readLoopExecutorMeta(context.metadataJson);
  const recipients = loopExecutor.deliveryRecipients?.contacts ?? [];
  const recipientEmails = recipients.map((r) => r.email).filter(Boolean);

  if (recipientEmails.length === 0) {
    throw new Error("Team email delivery requires at least one recipient in deliveryRecipients");
  }

  const content = await extractApprovedEmailBody(context);
  const accounts = await listConnectorAccounts(auth);
  const gmailAccount = accounts.find((account) =>
    account.provider?.toLowerCase().includes("gmail")
    || account.appKey?.toLowerCase() === "gmail",
  );

  if (!gmailAccount?.externalAccountId) {
    throw new Error("Gmail connector is not connected. Connect Gmail before team email delivery.");
  }

  const adapter = selectComposioConnectorAdapter();
  const results: Array<{ email: string; ok: boolean; messageId?: string; error?: string }> = [];

  for (const email of recipientEmails) {
    try {
      const response = await adapter.executeAction({
        auth,
        providerKey: "gmail",
        accountId: gmailAccount.externalAccountId,
        actionName: "GMAIL_SEND_EMAIL",
        payload: {
          recipient_email: email,
          subject: content.subject,
          body: content.html || content.text,
        },
        idempotencyKey: `${context.runId}:${email}:${taskId ?? "delivery"}`,
      });
      results.push({
        email,
        ok: response.ok,
        messageId: typeof response.output.message_id === "string" ? response.output.message_id : undefined,
        error: response.ok ? undefined : JSON.stringify(response.output),
      });
    } catch (error) {
      results.push({
        email,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const failureCount = results.length - successCount;
  const completedAt = new Date().toISOString();

  const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
    deliveryAction: {
      kind: "gmail_send",
      status: failureCount === 0 ? "completed" : successCount > 0 ? "partial_failure" : "failed",
      startedAt: completedAt,
      completedAt,
      recipientCount: results.length,
      successCount,
      failureCount,
    },
    deliveryBatch: {
      provider: "composio.gmail.send_email",
      sentAt: completedAt,
      successCount,
      failureCount,
      recipientCount: results.length,
      recipients: results,
    },
  });

  await pool.query(
    `UPDATE workflow_runs
     SET status = $4,
         connector_action_status = $5,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $6::jsonb,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      context.runId,
      context.tenantId,
      context.userId,
      failureCount === results.length ? "blocked" : "completed",
      failureCount === 0 ? "delivered" : "delivery_partial",
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ],
  );

  if (taskId) {
    await pool.query(
      `UPDATE loop_run_tasks SET status = 'done', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [taskId],
    );
  }

  await insertEvent({
    context,
    taskId: taskId ?? null,
    eventType: "gmail_delivery_completed",
    payload: { successCount, failureCount, provider: "composio.gmail.send_email" },
  });

  if (failureCount === results.length) {
    await markRunBlocked(context.runId, "Gmail delivery failed for all recipients", taskId ?? null);
    return { runId: context.runId, status: "blocked" };
  }

  await deliverStatusNotification({
    auth,
    title: `${context.workflowTitle} delivered`,
    body: `Sent to ${successCount} of ${results.length} recipients via Gmail.`,
    metadata: { workflowId: context.workflowId, runId: context.runId, status: "completed" },
  }).catch(() => undefined);

  return { runId: context.runId, status: "completed" };
}

export async function runEngineDeliveryHeartbeat(runId: string, taskId?: string | null) {
  const context = await loadRunContext(runId);
  if (!isEngineV3Definition(context.definition)) {
    return runDistributionHeartbeat(runId, taskId ?? undefined);
  }

  assertEngineDeliveryRouting(context);
  const provider = resolveDeliveryProvider(context);

  if (provider === "composio.gmail.send_email") {
    return runGmailDelivery(context, taskId);
  }

  if (provider === "internal.resend_broadcast") {
    return runDistributionHeartbeat(runId, taskId ?? undefined);
  }

  if (context.definition.delivery?.target === "none" || !provider) {
    await pool.query(
      `UPDATE workflow_runs SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [runId],
    );
    return { runId, status: "completed" };
  }

  throw new Error(`Unsupported delivery provider: ${provider}`);
}
