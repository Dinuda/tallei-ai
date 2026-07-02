import { condition, patched, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";

import type { AgentRunState, ApprovalDecision, LoopRunResult, LoopRunWorkflowInput } from "../types.js";
import { approvalDecisionSignal } from "./loop-run-approval.js";

const activities = proxyActivities<typeof import("../activities/index.js")>({
  startToCloseTimeout: "60 minutes",
  retry: { maximumAttempts: 3 },
});

export { approvalDecisionSignal } from "./loop-run-approval.js";

export async function loopRunWorkflow(input: LoopRunWorkflowInput): Promise<LoopRunResult> {
  const approvalDecisions: Record<string, ApprovalDecision> = {};
  setHandler(approvalDecisionSignal, (decision) => {
    approvalDecisions[decision.approvalId] = decision;
  });
  try {
    return await runLoopWorkflow(input, approvalDecisions);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
    const message = cause ?? (error instanceof Error ? error.message : String(error));
    await activities.failRunActivity({ runId: input.runId, error: message });
    return { status: "failed", error: message };
  }
}

async function runLoopWorkflow(
  input: LoopRunWorkflowInput,
  signaledApprovals: Record<string, ApprovalDecision>,
): Promise<LoopRunResult> {
  const plan = await activities.loadCompiledPlanActivity(input.compiledPlanId);
  await activities.createRunRecordActivity({
    ...input,
    temporalWorkflowId: workflowInfo().workflowId,
  });

  if (plan.profile !== "agentic") {
    await activities.executeLoopRunHeadless(input);
    return { status: "completed" };
  }

  // Existing open workflows retain their original single-activity history;
  // newly started workflows use durable step-level orchestration.
  if (!patched("durable-agentic-v2")) {
    return activities.runAgenticLoopActivity({
      ...input,
      temporalWorkflowId: workflowInfo().workflowId,
    });
  }

  const state: AgentRunState = {
    stepIndex: 0,
    messages: [],
    toolResults: [],
    failuresByToolId: {},
    totalCostUsd: 0,
    status: "running",
    artifacts: {},
    approvalDecisions: [],
  };
  const maxSteps = plan.agent?.maxSteps ?? 12;
  const auth = {
    userId: input.userId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    authMode: "internal" as const,
    plan: "free" as const,
  };

  if (plan.executionStrategy && plan.executionStrategy.mode !== "agentic") {
    for (const strategyStep of plan.executionStrategy.steps) {
      if (strategyStep.kind === "transform") {
        const artifact = await activities.executeTransformStepActivity({
          auth,
          runId: input.runId,
          stepIndex: state.stepIndex,
          step: strategyStep,
          state,
          ...(input.eventPayload !== undefined ? { eventPayload: input.eventPayload } : {}),
        });
        const artifactName = strategyStep.outputArtifact ?? strategyStep.id;
        state.artifacts![artifactName] = artifact;
        state.toolResults.push({
          toolId: strategyStep.id,
          result: { successful: true, data: { artifact, artifactName } },
        });
        state.stepIndex += 1;
        await activities.persistRunContextActivity({
          runId: input.runId, state,
          ...(input.eventPayload !== undefined ? { eventPayload: input.eventPayload } : {}),
        });
        continue;
      }

      const prepared = await activities.prepareStrategyToolActivity({
        workflowInput: input,
        state,
        step: strategyStep,
      });
      if (prepared.kind === "continue") {
        state.toolResults.push({ toolId: prepared.toolId, args: prepared.args, result: prepared.result });
        state.stepIndex += 1;
        await activities.persistRunContextActivity({
          runId: input.runId, state,
          ...(input.eventPayload !== undefined ? { eventPayload: input.eventPayload } : {}),
        });
        continue;
      }
      let args = prepared.args;
      if (prepared.needsApproval) {
        const timeoutMs = plan.approval.defaultTimeoutHours * 3_600_000;
        const approvalId = await activities.createApprovalRequestActivity({
          runId: input.runId,
          loopId: input.loopId,
          workspaceId: input.workspaceId,
          stepIndex: state.stepIndex,
          toolId: prepared.tool.id,
          proposedAction: { toolId: prepared.tool.id, args },
          temporalWorkflowId: workflowInfo().workflowId,
          expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
          idempotencyKey: `approval:${strategyStep.id}`,
        });
        state.status = "waiting_approval";
        await activities.persistRunContextActivity({ runId: input.runId, state });
        const received = await condition(() => Boolean(signaledApprovals[approvalId]), timeoutMs);
        const decision = received ? signaledApprovals[approvalId] : undefined;
        if (!decision) {
          await activities.resolveApprovalExpiredActivity(approvalId);
          await activities.failRunActivity({ runId: input.runId, error: "approval_timeout" });
          return { status: "failed", error: "approval_timeout" };
        }
        state.approvalDecisions!.push(decision);
        if (decision.decision === "reject") {
          await activities.failRunActivity({ runId: input.runId, error: "approval_rejected" });
          return { status: "cancelled", error: "approval_rejected" };
        }
        if (decision.decision === "edit" && decision.editedArgs) args = decision.editedArgs;
        state.status = "running";
      }
      const result = await activities.executeToolActivity({
        auth,
        runId: input.runId,
        stepIndex: state.stepIndex,
        tool: prepared.tool,
        args,
        idempotencyKey: `strategy:${strategyStep.id}`,
      });
      state.toolResults.push({ toolId: prepared.tool.id, args, result });
      if (result && typeof result === "object"
        && ((result as Record<string, unknown>).successful === false || (result as Record<string, unknown>).error)) {
        await activities.failRunActivity({ runId: input.runId, error: `strategy_step_failed:${strategyStep.id}` });
        return { status: "failed", error: `strategy_step_failed:${strategyStep.id}` };
      }
      state.stepIndex += 1;
      await activities.persistRunContextActivity({
        runId: input.runId, state,
        ...(input.eventPayload !== undefined ? { eventPayload: input.eventPayload } : {}),
      });
    }
    const summary = plan.intent.outcome;
    state.status = "completed";
    await activities.deliverOutputActivity({ auth, plan, runId: input.runId, loopId: input.loopId, state, summary });
    return { status: "completed", summary };
  }

  while (state.stepIndex < maxSteps) {
    const prepared = await activities.prepareAgenticStepActivity({ workflowInput: input, state });
    if (prepared.kind === "finish") {
      state.status = "completed";
      await activities.deliverOutputActivity({
        auth, plan, runId: input.runId, loopId: input.loopId, state, summary: prepared.summary,
      });
      return { status: "completed", summary: prepared.summary };
    }
    if (prepared.kind === "continue") {
      state.toolResults.push({ toolId: prepared.toolId, args: prepared.args, result: prepared.result });
      state.stepIndex += 1;
      await activities.persistRunContextActivity({
        runId: input.runId, state,
        ...(input.eventPayload !== undefined ? { eventPayload: input.eventPayload } : {}),
      });
      continue;
    }

    let args = prepared.args;
    if (prepared.needsApproval) {
      const timeoutMs = plan.approval.defaultTimeoutHours * 3_600_000;
      const approvalId = await activities.createApprovalRequestActivity({
        runId: input.runId,
        loopId: input.loopId,
        workspaceId: input.workspaceId,
        stepIndex: state.stepIndex,
        toolId: prepared.tool.id,
        proposedAction: { toolId: prepared.tool.id, args },
        temporalWorkflowId: workflowInfo().workflowId,
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
        idempotencyKey: `approval:${state.stepIndex}:${prepared.tool.id}`,
      });
      state.status = "waiting_approval";
      await activities.persistRunContextActivity({
        runId: input.runId, state,
        ...(input.eventPayload !== undefined ? { eventPayload: input.eventPayload } : {}),
      });
      const received = await condition(() => Boolean(signaledApprovals[approvalId]), timeoutMs);
      const decision = received ? signaledApprovals[approvalId] : undefined;
      if (!decision) {
        await activities.resolveApprovalExpiredActivity(approvalId);
        await activities.failRunActivity({ runId: input.runId, error: "approval_timeout" });
        return { status: "failed", error: "approval_timeout" };
      }
      state.approvalDecisions!.push(decision);
      if (decision.decision === "reject") {
        await activities.failRunActivity({ runId: input.runId, error: "approval_rejected" });
        return { status: "cancelled", error: "approval_rejected" };
      }
      if (decision.decision === "edit" && decision.editedArgs) args = decision.editedArgs;
      state.status = "running";
    }

    const result = await activities.executeToolActivity({
      auth,
      runId: input.runId,
      stepIndex: state.stepIndex,
      tool: prepared.tool,
      args,
      idempotencyKey: `tool:${state.stepIndex}:${prepared.tool.id}`,
    });
    state.toolResults.push({ toolId: prepared.tool.id, args, result });
    if (result && typeof result === "object"
      && ((result as Record<string, unknown>).successful === false || (result as Record<string, unknown>).error)) {
      state.failuresByToolId[prepared.tool.id] = (state.failuresByToolId[prepared.tool.id] ?? 0) + 1;
    }
    state.stepIndex += 1;
    await activities.persistRunContextActivity({
      runId: input.runId, state,
      ...(input.eventPayload !== undefined ? { eventPayload: input.eventPayload } : {}),
    });
    if (prepared.finishOnSuccess && !(result && typeof result === "object"
      && ((result as Record<string, unknown>).successful === false || (result as Record<string, unknown>).error))) {
      const summary = prepared.completionSummary ?? `Completed: ${prepared.tool.actionSlug}`;
      state.status = "completed";
      await activities.deliverOutputActivity({ auth, plan, runId: input.runId, loopId: input.loopId, state, summary });
      return { status: "completed", summary };
    }
  }

  await activities.failRunActivity({ runId: input.runId, error: "max_steps_exceeded" });
  return { status: "failed", error: "max_steps_exceeded" };
}
