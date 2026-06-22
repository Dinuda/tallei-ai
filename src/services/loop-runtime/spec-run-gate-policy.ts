import type { ReviewPolicyMode } from "../loop-engine/build-contract.js";

/** Operator must approve steps in the dashboard (not headless/automatic). */
export function operatorReviewRequired(reviewPolicy: ReviewPolicyMode | null): boolean {
  return reviewPolicy === "approve_each_action" || reviewPolicy === "approve_batch";
}

/** Whether a configured agent gate from the spec should pause the run. */
export function configuredAgentGateRequired(gateType: string): boolean {
  const type = gateType.trim().toLowerCase();
  if (type === "missing_input") return true;
  return type === "draft_review"
    || type === "preview_review"
    || type === "pre_send"
    || type === "source_confirmation"
    || type === "memory_confirmation";
}
