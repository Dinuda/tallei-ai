import { randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { config } from "../config/index.js";
import type { TestRunScenario } from "./conductor-tools.js";
import {
  buildTestRunPlannerPrompt,
  runPlannerDecision,
} from "./planning-agent.js";
import {
  compiledPlanSchema,
  type CompiledPlan,
  type PlannerDecision,
} from "./spec.js";
import { assertAgenticCompiledPlan } from "./plan-validators.js";
import { validateToolArgsAgainstSchema } from "./tool-schema.js";
import { createLoopRun, getCompiledPlan, getLatestBuildState, updateLoopRun } from "./store.js";
import { resolveComposioActionArgs } from "./composio-action-instructions.js";
import { isCompiledPlanCurrent } from "./build-continuity.js";

export type TestRunStep =
  | { kind: "plan"; decision: PlannerDecision }
  | {
      kind: "tool";
      toolId: string;
      capability: string;
      simulated: true;
      args: Record<string, unknown>;
      result: Record<string, unknown>;
    }
  | { kind: "error"; code: string; message: string };

export type TestRunResult =
  | {
      ok: true;
      runId: string;
      status: "passed";
      steps: TestRunStep[];
      preview: string;
    }
  | {
      ok: false;
      runId: string;
      status: "failed";
      error: string;
      steps: TestRunStep[];
    };

const DEFAULT_MAX_STEPS = 2;

/** Wall-clock budget for the full simulated test (all planner LLM calls). */
export function resolveTestRunTimeoutMs(maxSteps: number, overrideMs?: number): number {
  if (overrideMs != null && overrideMs > 0) return overrideMs;
  const perStep = config.plannerRequestTimeoutMs > 0 ? config.plannerRequestTimeoutMs : 300_000;
  return Math.max(config.loopTestRunTimeoutMs, perStep * maxSteps + 30_000);
}

function mapToolCatalog(plan: CompiledPlan) {
  return plan.toolCatalog.map((tool) => ({
    id: tool.id,
    capability: tool.capability,
    connector: tool.connector,
    actionSlug: tool.actionSlug,
    plannerCard: tool.plannerCard,
    ...(tool.modifiedInputSchema ? { modifiedInputSchema: tool.modifiedInputSchema } : {}),
    ...(tool.behaviorInstructions.length ? { behaviorInstructions: tool.behaviorInstructions } : {}),
    ...(tool.composioAction ? { composioAction: tool.composioAction } : {}),
  }));
}

function runStructuralProfileCheck(plan: CompiledPlan): TestRunResult | null {
  if (plan.profile === "monitor") {
    if (!plan.monitor?.rule) {
      return {
        ok: false,
        runId: "",
        status: "failed",
        error: "monitor_rule_missing",
        steps: [{ kind: "error", code: "MONITOR_RULE_MISSING", message: "Monitor profile requires monitor.rule" }],
      };
    }
    return null;
  }

  if (plan.profile === "sync") {
    const sync = plan.sync;
    if (!sync?.left?.connector || !sync.right?.connector || Object.keys(sync.mapping).length === 0) {
      return {
        ok: false,
        runId: "",
        status: "failed",
        error: "sync_config_incomplete",
        steps: [{ kind: "error", code: "SYNC_INCOMPLETE", message: "Sync profile requires left/right connectors and mapping" }],
      };
    }
    const readTools = plan.toolCatalog.filter(
      (tool) => tool.capability.includes("read") || tool.capability.includes("contact"),
    );
    if (readTools.length < 2) {
      return {
        ok: false,
        runId: "",
        status: "failed",
        error: "sync_read_tools_missing",
        steps: [{
          kind: "error",
          code: "SYNC_READ_TOOLS",
          message: "Sync profile needs read tools on both sides",
        }],
      };
    }
    return null;
  }

  try {
    assertAgenticCompiledPlan(plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "compiled_plan_invalid";
    return {
      ok: false,
      runId: "",
      status: "failed",
      error: message,
      steps: [{ kind: "error", code: "COMPILED_PLAN_INVALID", message }],
    };
  }

  return null;
}

/** @internal Exported for unit tests */
export function checkTestRunProfile(plan: CompiledPlan): TestRunResult | null {
  return runStructuralProfileCheck(plan);
}

async function persistTestRun(input: {
  loopId: string;
  workspaceId: string;
  compiledPlanId: string;
  scenario: TestRunScenario;
  steps: TestRunStep[];
  status: "passed" | "failed";
  preview?: string;
  error?: string;
}): Promise<string> {
  const runId = randomUUID();
  await createLoopRun({
    id: runId,
    loopId: input.loopId,
    workspaceId: input.workspaceId,
    compiledPlanId: input.compiledPlanId,
    triggerKind: "test",
    resultJson: {
      testRun: true,
      scenario: input.scenario,
      steps: input.steps,
      status: input.status,
    },
  });
  await updateLoopRun(runId, {
    status: input.status === "passed" ? "completed" : "failed",
    finishedAt: new Date().toISOString(),
    resultJson: {
      testRun: true,
      scenario: input.scenario,
      steps: input.steps,
      status: input.status,
      preview: input.preview,
      error: input.error,
    },
    ...(input.error ? { errorJson: { error: input.error } } : {}),
  });
  return runId;
}

async function runAgenticTestLoop(input: {
  plan: CompiledPlan;
  scenario: TestRunScenario;
  maxSteps: number;
  plannerTimeoutMs: number;
  userId?: string;
}): Promise<{ steps: TestRunStep[]; preview?: string; error?: string }> {
  const toolResults: Array<{ toolId: string; result: unknown }> = [];
  const steps: TestRunStep[] = [];

  for (let stepIndex = 0; stepIndex < input.maxSteps; stepIndex += 1) {
    const prompt = buildTestRunPlannerPrompt({
      planOutcome: input.plan.intent.outcome,
      planGoal: input.plan.intent.goal,
      agentInstructions: input.plan.agent?.instructions,
      successCriteria: input.plan.intent.successCriteria,
      scenario: input.scenario,
      toolCatalog: mapToolCatalog(input.plan),
      stepHistory: toolResults,
      connectorPlaybook: input.plan.connectorPlaybook,
    });

    const decision = await runPlannerDecision(prompt, {
      timeoutMs: input.plannerTimeoutMs,
      userId: input.userId,
    });
    steps.push({ kind: "plan", decision });

    if (decision.kind === "finish") {
      return { steps, preview: decision.summary };
    }

    const tool = input.plan.toolCatalog.find((row) => row.id === decision.toolId);
    if (!tool) {
      return {
        steps: [
          ...steps,
          { kind: "error", code: "UNKNOWN_TOOL", message: `Unknown tool: ${decision.toolId}` },
        ],
        error: `Unknown tool: ${decision.toolId}`,
      };
    }

    const resolvedArgs = resolveComposioActionArgs({
      plan: input.plan,
      tool,
      args: decision.args,
      ...(input.scenario.triggerPayload !== undefined ? { eventPayload: input.scenario.triggerPayload } : {}),
      toolResults,
    });
    if (resolvedArgs.missing.length > 0) {
      return {
        steps: [
          ...steps,
          {
            kind: "error",
            code: "MISSING_INPUT_SOURCE",
            message: `Missing input source: ${resolvedArgs.missing.map((row) => `${row.actionSlug}.${row.field}`).join(", ")}`,
          },
        ],
        error: `MISSING_INPUT_SOURCE: ${resolvedArgs.missing.map((row) => row.field).join(", ")}`,
      };
    }

    const validation = validateToolArgsAgainstSchema(resolvedArgs.args, tool.inputSchema);
    if (!validation.ok) {
      return {
        steps: [
          ...steps,
          {
            kind: "error",
            code: "SCHEMA_MISMATCH",
            message: `Missing required fields: ${validation.missing.join(", ")}`,
          },
        ],
        error: `SCHEMA_MISMATCH: ${validation.missing.join(", ")}`,
      };
    }

    const simulated = {
      successful: true,
      simulated: true,
      toolId: tool.id,
      capability: tool.capability,
      args: resolvedArgs.args,
    };
    steps.push({
      kind: "tool",
      toolId: tool.id,
      capability: tool.capability,
      simulated: true,
      args: resolvedArgs.args,
      result: simulated,
    });
    toolResults.push({ toolId: tool.id, result: simulated });

    // Smoke test: one valid simulated tool call is enough — no second planner round-trip.
    return {
      steps,
      preview: `Validated ${tool.capability} (${tool.actionSlug}) against the scenario.`,
    };
  }

  return {
    steps: [
      ...steps,
      { kind: "error", code: "MAX_STEPS", message: "Test run exceeded max steps without finishing" },
    ],
    error: "max_steps_exceeded",
  };
}

export async function executeLoopTestRun(
  auth: AuthContext,
  input: {
    loopId: string;
    compiledPlanId: string;
    scenario: TestRunScenario;
    maxSteps?: number;
    timeoutMs?: number;
  },
): Promise<TestRunResult> {
  const planRow = await getCompiledPlan(input.compiledPlanId);
  if (!planRow || planRow.loopId !== input.loopId) {
    return {
      ok: false,
      runId: "",
      status: "failed",
      error: "Compiled plan not found",
      steps: [{ kind: "error", code: "PLAN_NOT_FOUND", message: "Compiled plan not found" }],
    };
  }

  const state = await getLatestBuildState(auth, input.loopId);
  if (!isCompiledPlanCurrent(state, planRow)) {
    return {
      ok: false,
      runId: "",
      status: "failed",
      error: "Compiled plan is stale; confirm and compile the current outcome brief",
      steps: [{ kind: "error", code: "STALE_PLAN", message: "Compiled plan does not match the latest loop spec" }],
    };
  }

  const plan = compiledPlanSchema.parse(planRow);
  const maxSteps = input.maxSteps ?? config.loopTestRunMaxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = resolveTestRunTimeoutMs(maxSteps, input.timeoutMs);
  const plannerTimeoutMs = config.plannerRequestTimeoutMs > 0
    ? config.plannerRequestTimeoutMs
    : 0;

  const structuralFailure = runStructuralProfileCheck(plan);
  if (structuralFailure && !structuralFailure.ok) {
    if (!structuralFailure.runId) {
      structuralFailure.runId = await persistTestRun({
        loopId: input.loopId,
        workspaceId: plan.workspaceId,
        compiledPlanId: plan.id,
        scenario: input.scenario,
        steps: structuralFailure.steps,
        status: "failed",
        error: structuralFailure.error,
      });
    }
    return structuralFailure;
  }

  if (plan.profile !== "agentic") {
    const preview = plan.profile === "monitor"
      ? `Monitor rule validated for ${plan.monitor?.source ?? "source"}`
      : `Sync config validated for ${plan.sync?.left.connector} ↔ ${plan.sync?.right.connector}`;
    const steps: TestRunStep[] = [{ kind: "plan", decision: { kind: "finish", summary: preview } }];
    const runId = await persistTestRun({
      loopId: input.loopId,
      workspaceId: plan.workspaceId,
      compiledPlanId: plan.id,
      scenario: input.scenario,
      steps,
      status: "passed",
      preview,
    });
    return { ok: true, runId, status: "passed", steps, preview };
  }

  try {
    const outcome = await Promise.race([
      runAgenticTestLoop({
        plan,
        scenario: input.scenario,
        maxSteps,
        plannerTimeoutMs,
        userId: auth.userId,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("test_run_timeout")), timeoutMs);
      }),
    ]);

    if (outcome.error) {
      const runId = await persistTestRun({
        loopId: input.loopId,
        workspaceId: plan.workspaceId,
        compiledPlanId: plan.id,
        scenario: input.scenario,
        steps: outcome.steps,
        status: "failed",
        error: outcome.error,
      });
      return { ok: false, runId, status: "failed", error: outcome.error, steps: outcome.steps };
    }

    const runId = await persistTestRun({
      loopId: input.loopId,
      workspaceId: plan.workspaceId,
      compiledPlanId: plan.id,
      scenario: input.scenario,
      steps: outcome.steps,
      status: "passed",
      preview: outcome.preview,
    });
    return {
      ok: true,
      runId,
      status: "passed",
      steps: outcome.steps,
      preview: outcome.preview ?? "Test run passed",
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : "test_run_failed";
    const message = error instanceof Error && error.name === "AbortError"
      ? "planner_timeout"
      : raw;
    const steps: TestRunStep[] = [{
      kind: "error",
      code: message === "test_run_timeout" ? "TIMEOUT" : "TEST_RUN_FAILED",
      message,
    }];
    const runId = await persistTestRun({
      loopId: input.loopId,
      workspaceId: plan.workspaceId,
      compiledPlanId: plan.id,
      scenario: input.scenario,
      steps,
      status: "failed",
      error: message,
    });
    return { ok: false, runId, status: "failed", error: message, steps };
  }
}
