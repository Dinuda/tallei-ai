const LOOP_RUN_PREFIX = "loop-run";
const LOOP_SCHEDULE_PREFIX = "loop-schedule";

export function loopRunWorkflowId(tenantId: string, workflowId: string, runId: string): string {
  return `${LOOP_RUN_PREFIX}:${tenantId}:${workflowId}:${runId}`;
}

export function loopScheduleId(tenantId: string, workflowId: string): string {
  return `${LOOP_SCHEDULE_PREFIX}:${tenantId}:${workflowId}`;
}

export function parseLoopRunWorkflowId(workflowId: string): {
  tenantId: string;
  workflowId: string;
  runId: string;
} | null {
  const parts = workflowId.split(":");
  if (parts.length !== 4 || parts[0] !== LOOP_RUN_PREFIX) return null;
  const [, tenantId, loopWorkflowId, runId] = parts;
  if (!tenantId || !loopWorkflowId || !runId) return null;
  return { tenantId, workflowId: loopWorkflowId, runId };
}

export function parseLoopScheduleId(scheduleId: string): {
  tenantId: string;
  workflowId: string;
} | null {
  const parts = scheduleId.split(":");
  if (parts.length !== 3 || parts[0] !== LOOP_SCHEDULE_PREFIX) return null;
  const [, tenantId, workflowId] = parts;
  if (!tenantId || !workflowId) return null;
  return { tenantId, workflowId };
}

export function tenantLoopRunSearchQuery(tenantId: string): string {
  return `${LOOP_RUN_PREFIX}:${tenantId}:`;
}

export function tenantLoopScheduleSearchQuery(tenantId: string): string {
  return `${LOOP_SCHEDULE_PREFIX}:${tenantId}:`;
}
