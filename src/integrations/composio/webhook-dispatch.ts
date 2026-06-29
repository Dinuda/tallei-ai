import { randomUUID } from "crypto";

import { config } from "../../config/index.js";
import { buildAuthContextFromEntity } from "./entity.js";
import { claimWebhookEventDelivery, attachWebhookEventDeliveryRun } from "./trigger-channels.js";
import {
  createLoopRun,
  countRunningEventRuns,
  findActiveLoopsByComposioTriggerSlug,
  updateLoopRun,
} from "../../loops/store.js";

export function extractConnectedAccountId(payload: unknown): string | null {
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

async function resolveLoopMatches(input: {
  entityId: string;
  triggerSlug: string;
  payload: unknown;
}) {
  const connectedAccountId = extractConnectedAccountId(input.payload);
  const entityAuth = buildAuthContextFromEntity(input.entityId);
  const slug = input.triggerSlug.toUpperCase();

  if (connectedAccountId) {
    const byAccount = await findActiveLoopsByComposioTriggerSlug(slug, { connectedAccountId });
    if (byAccount.length > 0) {
      return { matches: byAccount, connectedAccountId, entityAuth, matchStrategy: "connected_account" as const };
    }
  }

  if (entityAuth?.workspaceId) {
    const byWorkspace = await findActiveLoopsByComposioTriggerSlug(slug, {
      workspaceId: entityAuth.workspaceId,
      ...(connectedAccountId ? { connectedAccountId } : {}),
    });
    if (byWorkspace.length > 0) {
      return { matches: byWorkspace, connectedAccountId, entityAuth, matchStrategy: "workspace" as const };
    }
  }

  return { matches: [], connectedAccountId, entityAuth, matchStrategy: "none" as const };
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
  matchStrategy?: string;
}> {
  const { matches, connectedAccountId, entityAuth, matchStrategy } = await resolveLoopMatches(input);

  if (matches.length === 0) {
    const reason = !entityAuth && !connectedAccountId
      ? "invalid_entity_id"
      : "no_active_loop_subscriptions_for_trigger";
    console.info("[webhook/composio] no runs started", {
      reason,
      entityId: input.entityId,
      triggerSlug: input.triggerSlug,
      externalEventId: input.externalEventId,
      connectedAccountId,
      entityWorkspaceId: entityAuth?.workspaceId ?? null,
      matchStrategy,
    });
    return {
      started: [],
      matchedLoops: 0,
      reason,
      matchStrategy,
    };
  }

  const cap = config.loopMaxConcurrentEventRuns;
  const started: string[] = [];
  let skippedDueToCap = 0;

  for (const match of matches) {
    let runningCount = cap > 0 ? await countRunningEventRuns(match.workspaceId) : 0;
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
    const tenantId = match.tenantId;
    const userId = match.userId;

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
        tenantId,
        userId,
      });
      await updateLoopRun(runId, { temporalWorkflowId: temporal.workflowId });
      started.push(runId);
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
      tenantId,
      userId,
    });
    started.push(run.id);
  }

  const result = {
    started,
    workspaceId: matches[0]?.workspaceId,
    matchedLoops: matches.length,
    matchStrategy,
    ...(cap > 0 ? { skippedDueToCap, runningEventRuns: started.length } : {}),
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
      workspaceId: matches[0]?.workspaceId,
      triggerSlug: input.triggerSlug,
      externalEventId: input.externalEventId,
      matchedLoops: matches.length,
      skippedDueToCap,
      cap,
      matchStrategy,
      reason: result.reason,
    });
  } else {
    console.info("[webhook/composio] started event runs", {
      workspaceId: matches[0]?.workspaceId,
      triggerSlug: input.triggerSlug,
      externalEventId: input.externalEventId,
      started: started.length,
      loopIds: matches.map((row) => row.loopId),
      matchStrategy,
    });
  }

  return result;
}
