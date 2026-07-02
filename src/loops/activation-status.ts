export type ActivationGap =
  | "composio_trigger_verification_failed"
  | "composio_trigger_not_registered"
  | "needs_activate"
  | null;

export function resolveActivationGap(input: {
  triggerKind: string;
  loopStatus: string;
  hasCompiledPlan: boolean;
  eventTrigger: { subscribed: boolean; verificationError: string | null } | null;
}): ActivationGap {
  if (input.triggerKind !== "event") return null;
  if (input.eventTrigger?.verificationError) return "composio_trigger_verification_failed";
  if (input.loopStatus === "active" && input.eventTrigger && !input.eventTrigger.subscribed) {
    return "composio_trigger_not_registered";
  }
  if (input.loopStatus !== "active" && input.hasCompiledPlan) return "needs_activate";
  return null;
}
