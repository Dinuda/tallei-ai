import type { AuthContext } from "../../domain/auth/index.js";
import { pollApprovalDecision, runAgenticLoop } from "../../loops/agentic-run.js";
import { buildMonitorAlertMessage, evaluateMonitorRule } from "../../loops/monitor.js";
import { getCompiledPlan, createLoopRun, getLoopRunById, updateLoopRun } from "../../loops/store.js";
import { compiledPlanSchema } from "../../loops/spec.js";
import type { LoopRunResult, LoopRunWorkflowInput } from "../types.js";
import { plannerActivity } from "./planner.js";
import { executeToolActivity } from "./execute-tool.js";
import {
  createApprovalRequestActivity,
  resolveApprovalExpiredActivity,
} from "./approval.js";
import { deliverOutputActivity, failRunActivity } from "./deliver-output.js";

function toAuth(input: { userId: string; tenantId: string; workspaceId: string }): AuthContext {
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    authMode: "internal",
    plan: "free",
  };
}

export async function loadCompiledPlanActivity(compiledPlanId: string) {
  const plan = await getCompiledPlan(compiledPlanId);
  if (!plan) throw new Error(`Compiled plan not found: ${compiledPlanId}`);
  return compiledPlanSchema.parse(plan);
}

export async function createRunRecordActivity(input: LoopRunWorkflowInput & { temporalWorkflowId: string }) {
  const existing = await getLoopRunById(input.runId);
  if (existing) {
    await updateLoopRun(input.runId, { temporalWorkflowId: input.temporalWorkflowId });
    return;
  }
  await createLoopRun({
    id: input.runId,
    loopId: input.loopId,
    workspaceId: input.workspaceId,
    compiledPlanId: input.compiledPlanId,
    triggerKind: input.triggerKind,
    temporalWorkflowId: input.temporalWorkflowId,
  });
}

function buildAgenticRunDeps(auth: AuthContext) {
  return {
    planner: plannerActivity,
    executeTool: (toolInput: Parameters<typeof executeToolActivity>[0]) => executeToolActivity(toolInput),
    deliverOutput: (outputInput: Parameters<typeof deliverOutputActivity>[0]) => deliverOutputActivity(outputInput),
    failRun: failRunActivity,
    createApproval: createApprovalRequestActivity,
    resolveApprovalExpired: resolveApprovalExpiredActivity,
    waitForApproval: pollApprovalDecision,
  };
}

export async function runAgenticLoopActivity(
  input: LoopRunWorkflowInput & { temporalWorkflowId?: string },
): Promise<LoopRunResult> {
  const plan = await loadCompiledPlanActivity(input.compiledPlanId);
  const auth = toAuth(input);
  return runAgenticLoop(input, plan, auth, buildAgenticRunDeps(auth), {
    temporalWorkflowId: input.temporalWorkflowId,
  });
}

export async function executeLoopRunHeadless(input: LoopRunWorkflowInput): Promise<void> {
  const plan = await loadCompiledPlanActivity(input.compiledPlanId);
  const auth = toAuth(input);

  if (plan.profile === "monitor") {
    await runMonitorProfile(auth, plan, input.runId);
    return;
  }
  if (plan.profile === "sync") {
    await runSyncProfile(auth, plan, input.runId);
    return;
  }

  await runAgenticLoop(input, plan, auth, buildAgenticRunDeps(auth));
}

async function fetchMonitorSample(
  auth: AuthContext,
  plan: Awaited<ReturnType<typeof loadCompiledPlanActivity>>,
  runId: string,
): Promise<Record<string, unknown>> {
  const source = plan.monitor?.source ?? "";
  const tool = plan.toolCatalog.find((t) => t.id === source || t.capability === source);
  if (tool) {
    const result = await executeToolActivity({
      auth,
      runId,
      stepIndex: 0,
      tool,
      args: {},
    });
    if (result && typeof result === "object") {
      return result as Record<string, unknown>;
    }
  }
  const field = plan.monitor?.rule.field ?? "value";
  return { [field]: 0, source: "stub", note: "Connect a metric tool binding matching monitor.source for live samples" };
}

async function runMonitorProfile(
  auth: AuthContext,
  plan: Awaited<ReturnType<typeof loadCompiledPlanActivity>>,
  runId: string,
): Promise<void> {
  const monitor = plan.monitor;
  if (!monitor?.rule) {
    await failRunActivity({ runId, error: "monitor_rule_missing" });
    return;
  }

  const sample = await fetchMonitorSample(auth, plan, runId);
  const breached = evaluateMonitorRule(sample, monitor.rule);
  const summary = buildMonitorAlertMessage(monitor, sample, breached);

  if (breached && plan.output.kind !== "none" && plan.toolCatalog.length > 0) {
    const notifyTool = plan.toolCatalog.find((t) => t.capability === "chat.send") ?? plan.toolCatalog[0];
    if (notifyTool) {
      await executeToolActivity({
        auth,
        runId,
        stepIndex: 1,
        tool: notifyTool,
        args: {
          message: summary,
          text: summary,
          ...(plan.output.target ? { channel: plan.output.target, to: plan.output.target } : {}),
        },
      });
    }
  }

  await deliverOutputActivity({
    auth,
    plan,
    runId,
    loopId: plan.loopId,
    state: {
      stepIndex: breached ? 2 : 1,
      messages: [],
      toolResults: [{ toolId: "monitor", result: { sample, breached, rule: monitor.rule } }],
      totalCostUsd: 0,
      status: "completed",
    },
    summary,
  });
}

async function runSyncProfile(
  auth: AuthContext,
  plan: Awaited<ReturnType<typeof loadCompiledPlanActivity>>,
  runId: string,
): Promise<void> {
  const sync = plan.sync;
  if (!sync?.left?.connector || !sync.right?.connector || Object.keys(sync.mapping).length === 0) {
    await failRunActivity({ runId, error: "sync_config_incomplete" });
    return;
  }

  const readTools = plan.toolCatalog.filter((t) => t.capability.includes("read") || t.capability.includes("contact"));
  if (readTools.length < 2) {
    await failRunActivity({
      runId,
      error: "sync_profile_v2_required: bidirectional sync needs read tools on both sides; full sync engine ships in v2",
    });
    return;
  }

  const leftSample = await executeToolActivity({
    auth,
    runId,
    stepIndex: 0,
    tool: readTools[0]!,
    args: { limit: 10 },
  });
  const rightSample = await executeToolActivity({
    auth,
    runId,
    stepIndex: 1,
    tool: readTools[1]!,
    args: { limit: 10 },
  });

  await deliverOutputActivity({
    auth,
    plan,
    runId,
    loopId: plan.loopId,
    state: {
      stepIndex: 2,
      messages: [],
      toolResults: [
        { toolId: readTools[0]!.id, result: leftSample },
        { toolId: readTools[1]!.id, result: rightSample },
      ],
      totalCostUsd: 0,
      status: "completed",
    },
    summary: `Sync preview: compared ${sync.left.connector} and ${sync.right.connector} (${Object.keys(sync.mapping).length} mapped fields). Full apply sync is v2.`,
  });
}

export {
  plannerActivity,
  executeToolActivity,
  createApprovalRequestActivity,
  resolveApprovalExpiredActivity,
  deliverOutputActivity,
  failRunActivity,
};
