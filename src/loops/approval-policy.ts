import type { IntentApproval } from "./intent-discovery.js";
import type { ApprovalPolicy, OutcomeRole } from "./spec.js";

type ApprovalPolicyCore = Pick<ApprovalPolicy, "mode" | "sensitiveRoles" | "sensitiveCapabilities">;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(
    values
      .map((value) => value.trim())
      .filter(Boolean),
  )];
}

function uniqueRoles(values: OutcomeRole[]): OutcomeRole[] {
  return [...new Set(values)];
}

export function normalizeApprovalPolicyCore(
  approval: IntentApproval | ApprovalPolicyCore,
): ApprovalPolicyCore {
  return {
    mode: approval.mode,
    sensitiveRoles: uniqueRoles([...(approval.sensitiveRoles ?? [])]),
    sensitiveCapabilities: uniqueStrings([...(approval.sensitiveCapabilities ?? [])]),
  };
}

export function approvalTargetsRole(
  approval: Pick<ApprovalPolicy, "sensitiveRoles">,
  role: OutcomeRole | undefined,
): boolean {
  return role ? approval.sensitiveRoles.includes(role) : false;
}

export function approvalNeedsReviewForRole(
  approval: Pick<ApprovalPolicy, "mode" | "sensitiveRoles">,
  role: OutcomeRole,
): boolean {
  return approval.mode === "ask" || approvalTargetsRole(approval, role);
}

export function describeApprovalPolicy(
  approval: Pick<ApprovalPolicy, "mode" | "sensitiveRoles" | "sensitiveCapabilities">,
): string {
  if (approval.mode === "auto") {
    return "Runs automatically without an extra approval step.";
  }

  if (approval.mode === "ask") {
    return "Requires approval before every step.";
  }

  const roles = uniqueRoles([...(approval.sensitiveRoles ?? [])]);
  const capabilities = uniqueStrings([...(approval.sensitiveCapabilities ?? [])]);
  if (roles.length === 0 && capabilities.length === 0) {
    return "Requires approval before sensitive actions.";
  }

  const roleSummary = roles.length > 0 ? `${roles.join(", ")} actions` : "";
  const capabilitySummary = capabilities.length > 0 ? `specific actions (${capabilities.join(", ")})` : "";
  const parts = [roleSummary, capabilitySummary].filter(Boolean);
  return `Requires approval before ${parts.join(" and ")}.`;
}
