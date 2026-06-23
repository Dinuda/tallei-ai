/** Whether a configured agent gate from the spec should pause the run. */
export function configuredAgentGateRequired(gateType: string): boolean {
  const type = gateType.trim().toLowerCase();
  return type === "input" || type === "approval";
}
