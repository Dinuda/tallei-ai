import { condition, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";

import type { ApprovalDecision, AgentRunState, LoopRunResult, LoopRunWorkflowInput } from "../types.js";

const activities = proxyActivities<typeof import("../activities/index.js")>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 3 },
});

export const approvalDecisionSignal = defineSignal<[ApprovalDecision]>("approvalDecision");

export async function loopRunWorkflow(input: LoopRunWorkflowInput): Promise<LoopRunResult> {
  try {
    return await runLoopWorkflow(input);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
    const message = cause ?? (error instanceof Error ? error.message : String(error));
    await activities.failRunActivity({ runId: input.runId, error: message });
    return { status: "failed", error: message };
  }
}

async function runLoopWorkflow(input: LoopRunWorkflowInput): Promise<LoopRunResult> {
  const plan = await activities.loadCompiledPlanActivity(input.compiledPlanId);
  await activities.createRunRecordActivity({
    ...input,
    temporalWorkflowId: workflowInfo().workflowId,
  });

  if (plan.profile !== "agentic") {
    await activities.executeLoopRunHeadless(input);
    return { status: "completed" };
  }

  const state: AgentRunState = {
    stepIndex: 0,
    messages: [],
    toolResults: [],
    totalCostUsd: 0,
    status: "running",
  };

  let pendingApproval: ApprovalDecision | null = null;
  setHandler(approvalDecisionSignal, (decision: ApprovalDecision) => {
    pendingApproval = decision;
  });

  const maxSteps = plan.agent?.maxSteps ?? 12;
  const auth = {
    userId: input.userId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
  };

  while (state.stepIndex < maxSteps) {
    const decision = await activities.plannerActivity({
      auth: { ...auth, authMode: "internal", plan: "free" } as never,
      plan,
      runId: input.runId,
      state,
    });

    if (decision.kind === "finish") {
      await activities.deliverOutputActivity({
        auth: { ...auth, authMode: "internal", plan: "free" } as never,
        plan,
        runId: input.runId,
        loopId: input.loopId,
        state,
        summary: decision.summary,
      });
      return { status: "completed", summary: decision.summary };
    }

    const tool = plan.toolCatalog.find((t) => t.id === decision.toolId);
    if (!tool) {
      await activities.failRunActivity({ runId: input.runId, error: `Unknown tool: ${decision.toolId}` });
      return { status: "failed", error: `Unknown tool: ${decision.toolId}` };
    }

    let finalArgs = decision.args;
    const needsApproval = tool.sensitive || plan.approval.mode === "ask";

    if (needsApproval) {
      const timeoutMs = (plan.approval.defaultTimeoutHours ?? 24) * 3600 * 1000;
      const approvalId = await activities.createApprovalRequestActivity({
        runId: input.runId,
        loopId: input.loopId,
        workspaceId: input.workspaceId,
        stepIndex: state.stepIndex,
        toolId: tool.id,
        proposedAction: { toolId: tool.id, args: decision.args },
        temporalWorkflowId: workflowInfo().workflowId,
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      });

      state.status = "waiting_approval";
      pendingApproval = null;
      const received = await condition(() => pendingApproval !== null, timeoutMs);
      if (!received || !pendingApproval) {
        await activities.resolveApprovalExpiredActivity(approvalId);
        if (plan.approval.onTimeout === "reject") {
          await activities.failRunActivity({ runId: input.runId, error: "approval_timeout" });
          return { status: "failed", error: "approval_timeout" };
        }
        continue;
      }
      const approvalDecision: ApprovalDecision = pendingApproval;
      if (approvalDecision.decision === "reject") {
        await activities.failRunActivity({ runId: input.runId, error: "approval_rejected" });
        return { status: "cancelled", error: "approval_rejected" };
      }
      if (approvalDecision.decision === "edit" && approvalDecision.editedArgs) {
        finalArgs = approvalDecision.editedArgs;
      }
      state.status = "running";
    }

    const result = await activities.executeToolActivity({
      auth: { ...auth, authMode: "internal", plan: "free" } as never,
      runId: input.runId,
      stepIndex: state.stepIndex,
      tool,
      args: finalArgs,
    });

    state.toolResults.push({ toolId: tool.id, result });
    state.stepIndex += 1;
  }

  await activities.failRunActivity({ runId: input.runId, error: "max_steps_exceeded" });
  return { status: "failed", error: "max_steps_exceeded" };
}
