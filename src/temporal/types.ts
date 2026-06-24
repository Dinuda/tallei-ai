export type LoopRunWorkflowInput = {
  loopId: string;
  workspaceId: string;
  tenantId: string;
  userId: string;
  compiledPlanId: string;
  runId: string;
  triggerKind: "schedule" | "manual" | "event";
  eventPayload?: unknown;
};

export type ApprovalDecision = {
  approvalId: string;
  decision: "approve" | "reject" | "edit";
  editedArgs?: Record<string, unknown>;
  comment?: string;
};

export type AgentRunState = {
  stepIndex: number;
  messages: Array<{ role: string; content: string }>;
  toolResults: Array<{ toolId: string; result: unknown }>;
  totalCostUsd: number;
  status: "running" | "waiting_approval" | "completed" | "failed";
};

export type LoopRunResult = {
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  error?: string;
};
