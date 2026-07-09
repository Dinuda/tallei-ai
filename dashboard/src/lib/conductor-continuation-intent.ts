export type ConductorContinuationTrigger =
  | "ui_tool_answered"
  | "phase_handoff"
  | "budget_exhausted"
  | null;

export type ConductorContinuationIntent = {
  action: "wait" | "auto_continue" | "wait_for_user";
  reason: string;
  handoffId?: string;
  trigger: ConductorContinuationTrigger;
};

export const IDLE_CONTINUATION_INTENT: ConductorContinuationIntent = {
  action: "wait",
  reason: "idle",
  trigger: null,
};

export function parseContinuationIntent(value: unknown): ConductorContinuationIntent {
  if (!value || typeof value !== "object") return IDLE_CONTINUATION_INTENT;
  const row = value as Record<string, unknown>;
  const action = row.action;
  if (action !== "wait" && action !== "auto_continue" && action !== "wait_for_user") {
    return IDLE_CONTINUATION_INTENT;
  }
  const trigger = row.trigger;
  const parsedTrigger = trigger === "ui_tool_answered"
    || trigger === "phase_handoff"
    || trigger === "budget_exhausted"
    || trigger === null
    ? trigger
    : null;
  return {
    action,
    reason: typeof row.reason === "string" ? row.reason : "idle",
    ...(typeof row.handoffId === "string" ? { handoffId: row.handoffId } : {}),
    trigger: parsedTrigger,
  };
}
