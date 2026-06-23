import { config } from "../config/index.js";
import { getTemporalClient, isTemporalEnabled } from "./client.js";
import { loopScheduleId } from "./ids.js";
import type { SpecRunTrigger } from "../services/conductor/runtime/spec-runner.js";

function normalizeCronExpression(cron: string): string {
  return cron.replace(/^CRON:/i, "").trim();
}

export async function upsertLoopSchedule(input: {
  tenantId: string;
  userId: string;
  workflowId: string;
  cron: string;
  timezone: string;
  label: string;
}): Promise<void> {
  if (!isTemporalEnabled()) return;

  const client = await getTemporalClient();
  const scheduleId = loopScheduleId(input.tenantId, input.workflowId);
  const cronExpression = normalizeCronExpression(input.cron);
  const trigger: SpecRunTrigger = { source: "schedule", label: input.label };
  const workflowInput = {
    tenantId: input.tenantId,
    userId: input.userId,
    workflowId: input.workflowId,
    trigger,
  };

  const spec = {
    cronExpressions: [cronExpression],
    timezone: input.timezone || "UTC",
  };

  const action = {
    type: "startWorkflow" as const,
    workflowType: "loopRunWorkflow",
    taskQueue: config.temporalTaskQueue,
    args: [workflowInput],
  };

  try {
    const handle = client.schedule.getHandle(scheduleId);
    await handle.update((previous) => ({
      ...previous,
      spec,
      action,
      state: {
        ...previous.state,
        paused: false,
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not found/i.test(message)) throw error;
    await client.schedule.create({
      scheduleId,
      spec,
      action,
      policies: {
        overlap: "SKIP",
      },
    });
  }
}

export async function deleteLoopSchedule(tenantId: string, workflowId: string): Promise<void> {
  if (!isTemporalEnabled()) return;
  const client = await getTemporalClient();
  const scheduleId = loopScheduleId(tenantId, workflowId);
  try {
    const handle = client.schedule.getHandle(scheduleId);
    await handle.delete();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not found/i.test(message)) throw error;
  }
}

export async function pauseLoopSchedule(tenantId: string, workflowId: string): Promise<void> {
  if (!isTemporalEnabled()) return;
  const client = await getTemporalClient();
  await client.schedule.getHandle(loopScheduleId(tenantId, workflowId)).pause();
}

export async function unpauseLoopSchedule(tenantId: string, workflowId: string): Promise<void> {
  if (!isTemporalEnabled()) return;
  const client = await getTemporalClient();
  await client.schedule.getHandle(loopScheduleId(tenantId, workflowId)).unpause();
}
