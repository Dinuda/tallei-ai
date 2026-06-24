import { randomUUID } from "crypto";

import { config } from "../../config/index.js";
import { buildAuthContextFromEntity } from "./entity.js";
import { resolveTriggerFromComposioSlug } from "../../loops/trigger-catalog.js";
import { createLoopRun, findActiveLoopsByComposioTriggerSlug, findActiveLoopsByEventTrigger, updateLoopRun } from "../../loops/store.js";

export async function dispatchComposioTriggerToLoops(input: {
  entityId: string;
  triggerSlug: string;
  externalEventId: string;
  payload: unknown;
}): Promise<{ started: string[]; workspaceId?: string }> {
  const auth = buildAuthContextFromEntity(input.entityId);
  if (!auth?.workspaceId) {
    throw new Error("Webhook entityId missing workspace scope");
  }

  const mapped = resolveTriggerFromComposioSlug(input.triggerSlug);
  const matches = await findActiveLoopsByComposioTriggerSlug(
    auth.workspaceId,
    input.triggerSlug.toUpperCase(),
  );
  const fallbackMatches = mapped
    ? await findActiveLoopsByEventTrigger(auth.workspaceId, mapped.source, mapped.eventType)
    : [];
  const merged = new Map<string, { loopId: string; activePlanId: string; workspaceId: string }>();
  for (const row of [...matches, ...fallbackMatches]) {
    merged.set(row.loopId, row);
  }

  const started: string[] = [];
  for (const match of merged.values()) {
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
      continue;
    }

    const run = await createLoopRun({
      loopId: match.loopId,
      workspaceId: match.workspaceId,
      compiledPlanId: match.activePlanId,
      triggerKind: "event",
      resultJson: { externalEventId: input.externalEventId, triggerSlug: input.triggerSlug },
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
  }

  return { started, workspaceId: auth.workspaceId };
}
