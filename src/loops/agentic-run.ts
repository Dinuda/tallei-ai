import type { AuthContext } from "../domain/auth/index.js";
import { getApprovalRequest } from "./store.js";
import { assertAgenticCompiledPlan } from "./plan-validators.js";
import type { CompiledPlan, PlannerDecision } from "./spec.js";
import type { AgentRunState, ApprovalDecision, LoopRunResult, LoopRunWorkflowInput } from "../temporal/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseApprovalDecision(row: NonNullable<Awaited<ReturnType<typeof getApprovalRequest>>>): ApprovalDecision | null {
  if (row.status !== "approved" && row.status !== "rejected") return null;
  const decisionJson = row.decision_json;
  const payload = decisionJson && typeof decisionJson === "object" && !Array.isArray(decisionJson)
    ? decisionJson as Record<string, unknown>
    : {};
  const decision = payload.decision;
  if (decision !== "approve" && decision !== "reject" && decision !== "edit") {
    return {
      approvalId: row.id,
      decision: row.status === "approved" ? "approve" : "reject",
    };
  }
  return {
    approvalId: row.id,
    decision,
    ...(payload.editedArgs && typeof payload.editedArgs === "object" && !Array.isArray(payload.editedArgs)
      ? { editedArgs: payload.editedArgs as Record<string, unknown> }
      : {}),
    ...(typeof payload.comment === "string" ? { comment: payload.comment } : {}),
  };
}

export async function pollApprovalDecision(
  approvalId: string,
  timeoutMs: number,
  pollIntervalMs = 2_000,
): Promise<ApprovalDecision | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await getApprovalRequest(approvalId);
    if (!row) return null;
    if (row.status === "expired") return null;
    if (row.status !== "pending") {
      return parseApprovalDecision(row);
    }
    await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
  }
  return null;
}

export type AgenticRunDeps = {
  planner: (input: {
    auth: AuthContext;
    plan: CompiledPlan;
    runId: string;
    state: AgentRunState;
    eventPayload?: unknown;
    triggerSlug?: string;
  }) => Promise<PlannerDecision>;
  executeTool: (input: {
    auth: AuthContext;
    runId: string;
    stepIndex: number;
    tool: CompiledPlan["toolCatalog"][number];
    args: Record<string, unknown>;
  }) => Promise<unknown>;
  deliverOutput: (input: {
    auth: AuthContext;
    plan: CompiledPlan;
    runId: string;
    loopId: string;
    state: AgentRunState;
    summary: string;
  }) => Promise<void>;
  failRun: (input: { runId: string; error: string }) => Promise<void>;
  createApproval: (input: {
    runId: string;
    loopId: string;
    workspaceId: string;
    stepIndex: number;
    toolId: string;
    proposedAction: Record<string, unknown>;
    temporalWorkflowId: string;
    expiresAt: string;
  }) => Promise<string>;
  resolveApprovalExpired: (approvalId: string) => Promise<void>;
  waitForApproval: (approvalId: string, timeoutMs: number) => Promise<ApprovalDecision | null>;
};

export async function runAgenticLoop(
  input: LoopRunWorkflowInput,
  plan: CompiledPlan,
  auth: AuthContext,
  deps: AgenticRunDeps,
  options?: { temporalWorkflowId?: string },
): Promise<LoopRunResult> {
  assertAgenticCompiledPlan(plan);

  const maxSteps = plan.agent?.maxSteps ?? 12;
  const state: AgentRunState = {
    stepIndex: 0,
    messages: [],
    toolResults: [],
    totalCostUsd: 0,
    status: "running",
  };

  const workflowId = options?.temporalWorkflowId ?? "";

  while (state.stepIndex < maxSteps) {
    const decision = await deps.planner({
      auth,
      plan,
      runId: input.runId,
      state,
      ...(input.eventPayload !== undefined ? { eventPayload: input.eventPayload } : {}),
      ...(input.triggerKind === "event" && plan.trigger.kind === "event"
        ? { triggerSlug: plan.trigger.composioSlug }
        : {}),
    });

    if (decision.kind === "finish") {
      await deps.deliverOutput({
        auth,
        plan,
        runId: input.runId,
        loopId: input.loopId,
        state,
        summary: decision.summary,
      });
      return { status: "completed", summary: decision.summary };
    }

    const tool = plan.toolCatalog.find((row) => row.id === decision.toolId);
    if (!tool) {
      const error = `Unknown tool: ${decision.toolId}`;
      await deps.failRun({ runId: input.runId, error });
      return { status: "failed", error };
    }

    let finalArgs = decision.args;
    const needsApproval = tool.sensitive || plan.approval.mode === "ask";

    if (needsApproval) {
      const timeoutMs = (plan.approval.defaultTimeoutHours ?? 24) * 3600 * 1000;
      const approvalId = await deps.createApproval({
        runId: input.runId,
        loopId: input.loopId,
        workspaceId: input.workspaceId,
        stepIndex: state.stepIndex,
        toolId: tool.id,
        proposedAction: { toolId: tool.id, args: decision.args },
        temporalWorkflowId: workflowId,
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      });

      state.status = "waiting_approval";
      const approvalDecision = await deps.waitForApproval(approvalId, timeoutMs);
      if (!approvalDecision) {
        await deps.resolveApprovalExpired(approvalId);
        if (plan.approval.onTimeout === "reject") {
          await deps.failRun({ runId: input.runId, error: "approval_timeout" });
          return { status: "failed", error: "approval_timeout" };
        }
        continue;
      }
      if (approvalDecision.decision === "reject") {
        await deps.failRun({ runId: input.runId, error: "approval_rejected" });
        return { status: "cancelled", error: "approval_rejected" };
      }
      if (approvalDecision.decision === "edit" && approvalDecision.editedArgs) {
        finalArgs = approvalDecision.editedArgs;
      }
      state.status = "running";
    }

    const result = await deps.executeTool({
      auth,
      runId: input.runId,
      stepIndex: state.stepIndex,
      tool,
      args: finalArgs,
    });

    state.toolResults.push({ toolId: tool.id, result });
    state.stepIndex += 1;
  }

  await deps.failRun({ runId: input.runId, error: "max_steps_exceeded" });
  return { status: "failed", error: "max_steps_exceeded" };
}
