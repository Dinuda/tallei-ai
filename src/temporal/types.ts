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
  toolResults: Array<{ toolId: string; result: unknown; args?: Record<string, unknown> }>;
  failuresByToolId: Record<string, number>;
  totalCostUsd: number;
  status: "running" | "waiting_approval" | "completed" | "failed";
  artifacts?: Record<string, unknown>;
  approvalDecisions?: ApprovalDecision[];
};

export type PreparedAgenticStep =
  | { kind: "finish"; summary: string }
  | { kind: "continue"; result: unknown; toolId: string; args: Record<string, unknown> }
  | {
      kind: "tool";
      tool: import("../loops/spec.js").ResolvedTool;
      args: Record<string, unknown>;
      needsApproval: boolean;
      finishOnSuccess?: boolean;
      completionSummary?: string;
    };

export type LoopRunResult = {
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  error?: string;
};
