import { randomUUID } from "crypto";

import { config } from "../../config/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { buildAuthContextFromEntity } from "./entity.js";
import { claimWebhookEventDelivery, attachWebhookEventDeliveryRun } from "./trigger-channels.js";
import { createLoopRun, countRunningEventRuns, findActiveLoopsByComposioTriggerSlug, updateLoopRun } from "../../loops/store.js";

function extractConnectedAccountId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  const metadata = row.metadata && typeof row.metadata === "object"
    ? row.metadata as Record<string, unknown>
    : {};
  const nested = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : {};
  for (const candidate of [
    row.connected_account_id,
    row.connectedAccountId,
    metadata.connected_account_id,
    metadata.connectedAccountId,
    nested.connected_account_id,
    nested.connectedAccountId,
  ]) {
    const value = String(candidate ?? "").trim();
    if (value) return value;
  }
  return null;
}

async function resolveWorkspaceIdForWebhook(input: {
  entityId: string;
  triggerSlug: string;
  payload: unknown;
}): Promise<string | null> {
  const auth = buildAuthContextFromEntity(input.entityId);
  if (auth?.workspaceId) return auth.workspaceId;

  const connectedAccountId = extractConnectedAccountId(input.payload);
  if (!connectedAccountId) return null;

  const result = await pool.query<{ workspace_id: string }>(
    `SELECT workspace_id
     FROM workspace_trigger_channels
     WHERE connected_account_id = $1
       AND composio_trigger_slug = $2
       AND status = 'active'
     LIMIT 1`,
    [connectedAccountId, input.triggerSlug.toUpperCase()],
  );
  return result.rows[0]?.workspace_id ?? null;
}

export async function dispatchComposioTriggerToLoops(input: {
  entityId: string;
  triggerSlug: string;
  externalEventId: string;
  payload: unknown;
}): Promise<{
  started: string[];
  workspaceId?: string;
  matchedLoops: number;
  skippedDueToCap?: number;
  runningEventRuns?: number;
  reason?: string;
}> {
  const auth = buildAuthContextFromEntity(input.entityId);
  if (!auth) {
    return {
      started: [],
      matchedLoops: 0,
      reason: "invalid_entity_id",
    };
  }

  const workspaceId = await resolveWorkspaceIdForWebhook(input);
  if (!workspaceId) {
    return {
      started: [],
      matchedLoops: 0,
      reason: "workspace_not_resolved",
    };
  }

  const matches = await findActiveLoopsByComposioTriggerSlug(
    workspaceId,
    input.triggerSlug,
  );

  const cap = config.loopMaxConcurrentEventRuns;
  let runningCount = cap > 0 ? await countRunningEventRuns(workspaceId) : 0;
  let skippedDueToCap = 0;

  const started: string[] = [];
  for (const match of matches) {
    if (cap > 0 && runningCount >= cap) {
      skippedDueToCap++;
      continue;
    }

    const claimed = await claimWebhookEventDelivery({
      externalEventId: input.externalEventId,
      loopId: match.loopId,
    });
    if (!claimed) continue;

    const runId = randomUUID();

    if (config.temporalEnabled) {
      await createLoopRun({
        id: runId,
        loopId: match.loopId,
        workspaceId: match.workspaceId,
        compiledPlanId: match.activePlanId,
        triggerKind: "event",
        resultJson: { externalEventId: input.externalEventId, triggerSlug: input.triggerSlug },
      });
      await attachWebhookEventDeliveryRun({
        externalEventId: input.externalEventId,
        loopId: match.loopId,
        runId,
      });
      const { startLoopRun } = await import("../../temporal/start-loop-run.js");
      const temporal = await startLoopRun({
        loopId: match.loopId,
        workspaceId: match.workspaceId,
        compiledPlanId: match.activePlanId,
        runId,
        triggerKind: "event",
        eventPayload: input.payload,
        tenantId: auth.tenantId,
        userId: auth.userId,
      });
      await updateLoopRun(runId, { temporalWorkflowId: temporal.workflowId });
      started.push(runId);
      runningCount++;
      continue;
    }

    const run = await createLoopRun({
      id: runId,
      loopId: match.loopId,
      workspaceId: match.workspaceId,
      compiledPlanId: match.activePlanId,
      triggerKind: "event",
      resultJson: { externalEventId: input.externalEventId, triggerSlug: input.triggerSlug },
    });
    await attachWebhookEventDeliveryRun({
      externalEventId: input.externalEventId,
      loopId: match.loopId,
      runId: run.id,
    });
    const { executeLoopRunHeadless } = await import("../../temporal/activities/loop-run.activity.js");
    void executeLoopRunHeadless({
      loopId: match.loopId,
      workspaceId: match.workspaceId,
      compiledPlanId: match.activePlanId,
      runId: run.id,
      triggerKind: "event",
      eventPayload: input.payload,
      tenantId: auth.tenantId,
      userId: auth.userId,
    });
    started.push(run.id);
    runningCount++;
  }

  const result = {
    started,
    workspaceId,
    matchedLoops: matches.length,
    ...(cap > 0 ? { skippedDueToCap, runningEventRuns: runningCount } : {}),
    ...(started.length === 0
      ? {
          reason: skippedDueToCap > 0 && matches.length > 0
            ? "concurrency_cap_reached"
            : matches.length === 0
              ? "no_active_loop_subscriptions_for_trigger"
              : "duplicate_webhook_delivery",
        }
      : {}),
  };

  if (started.length === 0) {
    console.info("[webhook/composio] no runs started", {
      workspaceId,
      triggerSlug: input.triggerSlug,
      externalEventId: input.externalEventId,
      matchedLoops: matches.length,
      skippedDueToCap,
      runningEventRuns: runningCount,
      cap,
      reason: result.reason,
    });
  } else if (skippedDueToCap > 0) {
    console.info("[webhook/composio] partial fan-out due to concurrency cap", {
      workspaceId,
      triggerSlug: input.triggerSlug,
      externalEventId: input.externalEventId,
      started: started.length,
      skippedDueToCap,
      runningEventRuns: runningCount,
      cap,
    });
  }

  return result;
}
