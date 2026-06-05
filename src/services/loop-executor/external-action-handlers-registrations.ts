/**
 * external-action-handlers-registrations.ts — Built-in external action handler registrations.
 *
 * Each handler is registered at module load via registerExternalActionHandler().
 * Handlers are dispatched by toolRef when the plan reaches an external_action stage.
 */

import { pool } from "../../infrastructure/db/index.js";
import { mergeLoopExecutorMeta } from "./run-context.js";
import { scheduleHeartbeat } from "./run-heartbeat.js";
import { insertComment, insertEvent, loadRunArtifacts, readObject } from "./run-store.js";
import { registerExternalActionHandler } from "./external-action-handlers.js";

registerExternalActionHandler("internal.resend_broadcast", async (context, task, stage) => {
  const artifacts: Array<Record<string, unknown>> = await loadRunArtifacts(context);
  const byId = new Map(artifacts.map((a) => [a.artifact_id as string, a]));
  const stageArtifacts = stage.inputArtifactIds
    .map((artifactId) => byId.get(artifactId))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  const contactArtifact = stageArtifacts.find(
    (a) => a.kind === "contact_list" || a.kind === "recipient_list",
  )
    ?? artifacts.find((a) => a.kind === "contact_list" || a.kind === "recipient_list");
  const contentArtifact = stageArtifacts.find((a) => a.id !== contactArtifact?.id)
    ?? artifacts.find(
      (a) => a.kind !== "contact_list" && a.kind !== "recipient_list" && Boolean(String(a.body ?? "").trim()),
    );
  const resultArtifact = context.definition.plan!.artifacts.find((artifact) => artifact.kind === "delivery_result");
  const contactsRaw = readObject(contactArtifact?.data_json).contacts;
  const contacts = Array.isArray(contactsRaw)
    ? contactsRaw
        .map((row) => readObject(row as Record<string, unknown>))
        .map((row) => ({
          email: typeof row.email === "string" ? row.email : "",
          ...(typeof row.name === "string" ? { name: row.name } : {}),
        }))
        .filter((row) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))
    : [];
  if (!String(contentArtifact?.body ?? "").trim())
    throw new Error("Approved content artifact is required before broadcast");
  if (contacts.length === 0)
    throw new Error("Recipient artifact is required before broadcast");

  const loopExecutorPatch = mergeLoopExecutorMeta(context.metadataJson, {
    deliveryContentBody: String(contentArtifact!.body ?? ""),
    deliveryContentArtifactId: (contentArtifact!.artifact_id as string) ?? null,
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
    taskId: task.id as string,
    author: task.agent_id as string,
    body: `Prepared ${contacts.length} recipients for ${stage.label}.`,
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
      JSON.stringify({ text: `Prepared broadcast for ${contacts.length} recipients.`, stage }),
    ],
  );

  await pool.query(
    `UPDATE workflow_runs
     SET status = 'executing_action',
         connector_action_status = 'distribution_started',
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [
      context.runId,
      context.tenantId,
      context.userId,
      JSON.stringify({ loop_executor: loopExecutorPatch.loop_executor }),
    ],
  );

  await insertEvent({
    context,
    taskId: task.id as string,
    eventType: "external_action_started",
    payload: { stageId: stage.id, toolRef: stage.toolRef, recipientCount: contacts.length },
  });

  await scheduleHeartbeat({
    tenantId: context.tenantId,
    userId: context.userId,
    runId: context.runId,
    jobType: "distribution",
  });

  return { status: "executing_action" };
});
