import { randomUUID } from "crypto";

import type { TriggerConfig } from "../loops/spec.js";
import { getTemporalClient } from "./client.js";
import { loopScheduleId } from "./ids.js";
import { config } from "../config/index.js";

function cronToCalendarSpec(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) throw new Error(`Invalid cron: ${cron}`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const toRange = (value: string) => (value === "*" ? undefined : value.split(",").map((v) => Number(v)));
  return {
    minute: toRange(minute),
    hour: toRange(hour),
    dayOfMonth: toRange(dayOfMonth),
    month: toRange(month),
    dayOfWeek: toRange(dayOfWeek),
  };
}

function buildScheduleSpec(trigger: Extract<TriggerConfig, { kind: "schedule" }>) {
  return {
    calendars: [cronToCalendarSpec(trigger.cron)],
    timezone: trigger.timezone,
  };
}

export async function upsertLoopSchedule(input: {
  loopId: string;
  workspaceId: string;
  compiledPlanId: string;
  trigger: TriggerConfig;
  tenantId?: string;
  userId?: string;
}): Promise<{ scheduleId: string }> {
  if (input.trigger.kind !== "schedule") {
    return { scheduleId: loopScheduleId(input.loopId) };
  }

  const client = await getTemporalClient();
  const scheduleId = loopScheduleId(input.loopId);
  const runId = randomUUID();

  const action = {
    type: "startWorkflow" as const,
    workflowType: "loopRunWorkflow",
    taskQueue: config.temporalTaskQueue,
    args: [{
      loopId: input.loopId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId ?? "unknown",
      userId: input.userId ?? "unknown",
      compiledPlanId: input.compiledPlanId,
      runId,
      triggerKind: "schedule" as const,
    }],
  };

  const spec = buildScheduleSpec(input.trigger) as import("@temporalio/client").ScheduleSpec;

  try {
    await client.schedule.create({
      scheduleId,
      spec,
      action,
    });
  } catch {
    const handle = client.schedule.getHandle(scheduleId);
    await handle.update((prev) => ({
      ...prev,
      spec,
      action,
    }));
  }

  return { scheduleId };
}

export async function pauseLoopSchedule(loopId: string): Promise<void> {
  const client = await getTemporalClient();
  await client.schedule.getHandle(loopScheduleId(loopId)).pause();
}

export async function resumeLoopSchedule(loopId: string): Promise<void> {
  const client = await getTemporalClient();
  await client.schedule.getHandle(loopScheduleId(loopId)).unpause();
}

export async function deleteLoopSchedule(loopId: string): Promise<void> {
  const client = await getTemporalClient();
  await client.schedule.getHandle(loopScheduleId(loopId)).delete();
}
