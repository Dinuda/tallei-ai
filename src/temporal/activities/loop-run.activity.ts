import type { AuthContext } from "../../domain/auth/index.js";
import { generateText } from "ai";
import {
  hasSufficientPriorOutput,
  missingInputSourceResult,
  outputAlreadyAvailableResult,
  pollApprovalDecision,
  runAgenticLoop,
} from "../../loops/agentic-run.js";
import { resolveComposioActionArgs } from "../../loops/composio-action-instructions.js";
import { buildMonitorAlertMessage, evaluateMonitorRule } from "../../loops/monitor.js";
import { getCompiledPlan, createLoopRun, getLoopRunById, insertRunStep, updateLoopRun } from "../../loops/store.js";
import { compiledPlanSchema } from "../../loops/spec.js";
import type { AgentRunState, LoopRunResult, LoopRunWorkflowInput, PreparedAgenticStep } from "../types.js";
import { plannerActivity } from "./planner.js";
import { executeToolActivity } from "./execute-tool.js";
import {
  createApprovalRequestActivity,
  resolveApprovalExpiredActivity,
} from "./approval.js";
import { deliverOutputActivity, failRunActivity } from "./deliver-output.js";
import { getStreamingLanguageModel } from "../../providers/ai/streaming/language-model.js";
import type { ExecutionStep } from "../../loops/spec.js";

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

export async function prepareAgenticStepActivity(input: {
  workflowInput: LoopRunWorkflowInput;
  state: AgentRunState;
}): Promise<PreparedAgenticStep> {
  const plan = await loadCompiledPlanActivity(input.workflowInput.compiledPlanId);
  const auth = toAuth(input.workflowInput);
  const exhaustedToolIds = Object.entries(input.state.failuresByToolId)
    .filter(([, failures]) => failures >= Math.max(1, plan.guardrails.maxRetriesPerStep))
    .map(([toolId]) => toolId);
  const decision = await plannerActivity({
    auth,
    plan,
    runId: input.workflowInput.runId,
    state: input.state,
    exhaustedToolIds,
    ...(input.workflowInput.eventPayload !== undefined
      ? { eventPayload: input.workflowInput.eventPayload }
      : {}),
    ...(input.workflowInput.triggerKind === "event" && plan.trigger.kind === "event"
      ? { triggerSlug: plan.trigger.composioSlug }
      : {}),
  });
  if (decision.kind === "finish") return decision;
  const tool = plan.toolCatalog.find((candidate) => candidate.id === decision.toolId);
  if (!tool) throw new Error(`Unknown tool: ${decision.toolId}`);
  const resolved = resolveComposioActionArgs({
    plan,
    tool,
    args: decision.args,
    ...(input.workflowInput.eventPayload !== undefined
      ? { eventPayload: input.workflowInput.eventPayload }
      : {}),
    toolResults: input.state.toolResults,
  });
  if (resolved.missing.length > 0) {
    return {
      kind: "continue",
      toolId: tool.id,
      args: resolved.args,
      result: missingInputSourceResult(tool, resolved.missing),
    };
  }
  if (hasSufficientPriorOutput(tool, resolved.args, input.state.toolResults)) {
    return {
      kind: "continue",
      toolId: tool.id,
      args: resolved.args,
      result: outputAlreadyAvailableResult(tool),
    };
  }
  return {
    kind: "tool",
    tool,
    args: resolved.args,
    needsApproval: tool.sensitive || plan.approval.mode === "ask",
    ...(decision.finishOnSuccess !== undefined ? { finishOnSuccess: decision.finishOnSuccess } : {}),
    ...(decision.completionSummary ? { completionSummary: decision.completionSummary } : {}),
  };
}

export async function prepareStrategyToolActivity(input: {
  workflowInput: LoopRunWorkflowInput;
  state: AgentRunState;
  step: ExecutionStep;
}): Promise<Extract<PreparedAgenticStep, { kind: "tool" | "continue" }>> {
  const plan = await loadCompiledPlanActivity(input.workflowInput.compiledPlanId);
  const tool = plan.toolCatalog.find((candidate) => candidate.id === input.step.toolId);
  if (!tool) throw new Error(`Compiled strategy tool not found: ${input.step.toolId ?? "missing"}`);
  const auth = toAuth(input.workflowInput);
  const scopedPlan = { ...plan, toolCatalog: [tool] };
  const decision = await plannerActivity({
    auth,
    plan: scopedPlan,
    runId: input.workflowInput.runId,
    state: input.state,
    ...(input.workflowInput.eventPayload !== undefined
      ? { eventPayload: input.workflowInput.eventPayload }
      : {}),
    ...(input.workflowInput.triggerKind === "event" && plan.trigger.kind === "event"
      ? { triggerSlug: plan.trigger.composioSlug }
      : {}),
  });
  const suggestedArgs = decision.kind === "tool_call" && decision.toolId === tool.id
    ? decision.args
    : {};
  const resolved = resolveComposioActionArgs({
    plan,
    tool,
    args: suggestedArgs,
    ...(input.workflowInput.eventPayload !== undefined
      ? { eventPayload: input.workflowInput.eventPayload }
      : {}),
    toolResults: input.state.toolResults,
  });
  if (resolved.missing.length > 0) {
    return { kind: "continue", toolId: tool.id, args: resolved.args, result: missingInputSourceResult(tool, resolved.missing) };
  }
  return {
    kind: "tool",
    tool,
    args: resolved.args,
    needsApproval: input.step.requiresApproval,
  };
}

export async function executeTransformStepActivity(input: {
  auth: AuthContext;
  runId: string;
  stepIndex: number;
  step: ExecutionStep;
  eventPayload?: unknown;
  state: AgentRunState;
}): Promise<unknown> {
  const prompt = [
    `Transform objective: ${input.step.description}`,
    input.eventPayload !== undefined ? `Trigger input: ${JSON.stringify(input.eventPayload)}` : "",
    `Prior artifacts: ${JSON.stringify(input.state.artifacts ?? {})}`,
    `Prior step results: ${JSON.stringify(input.state.toolResults)}`,
    "Return only the transformed artifact content.",
  ].filter(Boolean).join("\n\n");
  const { text } = await generateText({
    model: getStreamingLanguageModel("planner", { userId: input.auth.userId }),
    system: "You perform one bounded workflow transform. Do not choose or call tools.",
    prompt,
  });
  await insertRunStep({
    runId: input.runId,
    stepIndex: input.stepIndex,
    kind: "transform",
    toolId: input.step.id,
    inputJson: { eventPayload: input.eventPayload, artifacts: input.state.artifacts ?? {} },
    outputJson: { artifact: text },
    status: "completed",
    idempotencyKey: `transform:${input.step.id}`,
  });
  return text;
}

export async function persistRunContextActivity(input: {
  runId: string;
  state: AgentRunState;
  eventPayload?: unknown;
}): Promise<void> {
  await updateLoopRun(input.runId, {
    status: input.state.status,
    resultJson: {
      runContext: {
        version: 1,
        trigger: input.eventPayload,
        artifacts: input.state.artifacts ?? {},
        toolResults: input.state.toolResults,
        failuresByToolId: input.state.failuresByToolId,
        approvalDecisions: input.state.approvalDecisions ?? [],
        stepIndex: input.state.stepIndex,
        status: input.state.status,
      },
    },
  });
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
      failuresByToolId: {},
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
      failuresByToolId: {},
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
