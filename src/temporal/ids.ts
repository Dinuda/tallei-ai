export function loopRunWorkflowId(loopId: string, runId: string): string {
  return `loop-run-${loopId}-${runId}`;
}

export function loopScheduleId(loopId: string): string {
  return `loop-schedule-${loopId}`;
}
