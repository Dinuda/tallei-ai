import { randomUUID } from "crypto";

import { createApprovalRequest, updateLoopRun } from "../../loops/store.js";

export async function createApprovalRequestActivity(input: {
  runId: string;
  loopId: string;
  workspaceId: string;
  stepIndex: number;
  toolId: string;
  proposedAction: Record<string, unknown>;
  temporalWorkflowId: string;
  expiresAt: string;
}): Promise<string> {
  const row = await createApprovalRequest(input);
  await updateLoopRun(input.runId, { status: "waiting_approval" });
  return row.id;
}

export async function resolveApprovalExpiredActivity(approvalId: string): Promise<void> {
  const { resolveApprovalRequest } = await import("../../loops/store.js");
  await resolveApprovalRequest(approvalId, "expired", { reason: "timeout" });
}

export function buildApprovalId(): string {
  return randomUUID();
}
