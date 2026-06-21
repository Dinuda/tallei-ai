import type { ReviewPolicyMode } from "../loop-engine/build-contract.js";

/** Operator must approve steps in the dashboard (not headless/automatic). */
export function operatorReviewRequired(reviewPolicy: ReviewPolicyMode | null): boolean {
  return reviewPolicy === "approve_each_action" || reviewPolicy === "approve_batch";
}

/** Whether a configured agent gate from the spec should pause the run. */
export function configuredAgentGateRequired(
  gateType: string,
  reviewPolicy: ReviewPolicyMode | null,
): boolean {
  // Runtime honors agent.gate from the compiled spec directly (see createConfiguredGateIfNeeded).
  // This helper is used when compiling specs from build contracts.
  const type = gateType.trim().toLowerCase();
  if (type === "missing_input") return true;
  if (!operatorReviewRequired(reviewPolicy)) return false;
  if (type === "draft_review" || type === "preview_review") return true;
  if (type === "pre_send") return reviewPolicy === "approve_each_action";
  return true;
}
