import { randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { config } from "../config/index.js";
import { compileLoopSpec } from "./compiler.js";
import { getMissingSlots, isReadyToCompile } from "./patch.js";
import {
  activateCompiledPlan,
  createLoop,
  createLoopRun,
  getCompiledPlan,
  getLatestSpec,
  getLatestBuildState,
  getLoop,
  listLoopRuns,
  listLoops,
  moveLoopToWorkspace as moveLoopRow,
  commitLoopBuildArtifact,
  recoverLoopBuildPhase,
  setLoopStatus,
  updateLoopName,
  updateLoopRun,
} from "./store.js";
import {
  assembleLoopSpec,
  BuildStateError,
  BUILD_ERROR_CODES,
  compileArtifactSchema,
  testArtifactSchema,
} from "./build-state.js";
import { resolveWorkspaceId } from "../services/workspace/index.js";
import { getConnectorProvider } from "../integrations/connectors/index.js";
import { determineBuildContinuityRecovery } from "./build-continuity.js";

const connectorProvider = getConnectorProvider();

export async function reconcileLoopBuildContinuity(auth: AuthContext, loopId: string) {
  const state = await getLatestBuildState(auth, loopId);
  if (!state) throw new Error("Loop build state not found");
  const compileArtifact = state.artifacts.compile
    ? compileArtifactSchema.parse(state.artifacts.compile.artifact)
    : null;
  const plan = compileArtifact ? await getCompiledPlan(compileArtifact.compiledPlanId) : null;
  const recovery = determineBuildContinuityRecovery(state, plan);
  if (!recovery) return { state, recovered: false as const, recovery: null };
  const result = await recoverLoopBuildPhase({ auth, loopId, ...recovery });
  return { state: result.state, recovered: result.recovered, recovery };
}

export async function recoverLoopBuildToCompile(
  auth: AuthContext,
  loopId: string,
  reason: string,
) {
  const state = await getLatestBuildState(auth, loopId);
  if (!state) throw new Error("Loop build state not found");
  if (state.buildPhase !== "test" && state.buildPhase !== "activation") {
    return { state, recovered: false as const, recovery: null, invalidatedPhases: [] };
  }
  const parentArtifactHash = state.artifacts.review?.artifactHash ?? "root";
  const recovery = { phase: "compile" as const, reason, parentArtifactHash };
  const result = await recoverLoopBuildPhase({ auth, loopId, ...recovery });
  return {
    state: result.state,
    recovered: result.recovered,
    recovery,
    invalidatedPhases: result.invalidatedPhases,
  };
}

export async function resolveLoopAuthWorkspace(auth: AuthContext, workspaceId?: string | null) {
  const resolved = await resolveWorkspaceId(auth, workspaceId ?? auth.workspaceId);
  return { ...auth, workspaceId: resolved };
}

export async function createLoopInWorkspace(
  auth: AuthContext,
  input: { name: string; templateId?: string; workspaceId?: string; prompt?: string },
) {
  const ctx = await resolveLoopAuthWorkspace(auth, input.workspaceId);
  const workspaceId = ctx.workspaceId!;
  return createLoop(ctx, {
    workspaceId,
    name: input.name,
    templateId: input.templateId,
    prompt: input.prompt,
  });
}

export async function compileLoop(auth: AuthContext, loopId: string) {
  const state = await getLatestBuildState(auth, loopId);
  if (!state) throw new Error("Loop build state not found");
  if (state.buildPhase !== "compile" || !state.artifacts.review) {
    throw new BuildStateError(BUILD_ERROR_CODES.INVALID_TRANSITION, `Cannot compile while phase is ${state.buildPhase}`);
  }
  const spec = assembleLoopSpec(state);
  const ctx = await resolveLoopAuthWorkspace(auth, spec.workspaceId);
  const result = await compileLoopSpec(ctx, loopId, spec);
  if (!result.plan || result.errors.length > 0) return result;
  await commitLoopBuildArtifact({
    auth: ctx, loopId, phase: "compile", expectedParentHash: state.artifacts.review.artifactHash,
    artifact: {
      reviewHash: state.artifacts.review.artifactHash,
      compiledPlanId: result.plan.id,
      compiledPlanHash: result.plan.contentHash,
    },
    source: "compile-plan",
  });
  return result;
}

export async function recordLoopTestResult(auth: AuthContext, loopId: string, input: {
  compiledPlanId: string; runId: string; passed: boolean;
}) {
  const state = await getLatestBuildState(auth, loopId);
  if (!state?.artifacts.compile || state.buildPhase !== "test") {
    throw new BuildStateError(BUILD_ERROR_CODES.INVALID_TRANSITION, `Cannot record test while phase is ${state?.buildPhase ?? "missing"}`);
  }
  const compiled = compileArtifactSchema.parse(state.artifacts.compile.artifact);
  if (compiled.compiledPlanId !== input.compiledPlanId) {
    throw new BuildStateError(BUILD_ERROR_CODES.PLAN_MISMATCH, "Test result belongs to a different compiled plan");
  }
  if (!input.passed) {
    throw new BuildStateError(BUILD_ERROR_CODES.PASSING_TEST_REQUIRED, "Only a passing test can advance the build");
  }
  return commitLoopBuildArtifact({
    auth, loopId, phase: "test", expectedParentHash: state.artifacts.compile.artifactHash,
    artifact: {
      compileHash: state.artifacts.compile.artifactHash,
      compiledPlanId: input.compiledPlanId,
      runId: input.runId,
      passed: true,
    }, source: "test-result",
  });
}

export async function activateLoop(auth: AuthContext, loopId: string, compiledPlanId: string, confirmedByUser = false) {
  const state = await getLatestBuildState(auth, loopId);
  if (!state?.artifacts.test || state.buildPhase !== "activation") {
    throw new BuildStateError(BUILD_ERROR_CODES.INVALID_TRANSITION, `Cannot activate while phase is ${state?.buildPhase ?? "missing"}`);
  }
  if (!confirmedByUser) {
    throw new BuildStateError(BUILD_ERROR_CODES.USER_CONFIRMATION_REQUIRED, "Explicit activation confirmation is required");
  }
  const test = testArtifactSchema.parse(state.artifacts.test.artifact);
  if (test.compiledPlanId !== compiledPlanId) {
    throw new BuildStateError(BUILD_ERROR_CODES.PLAN_MISMATCH, "Activation plan does not match the passing test");
  }
  const loop = await getLoop(auth, loopId);
  if (!loop) throw new Error("Loop not found");
  const plan = await getCompiledPlan(compiledPlanId);
  if (!plan || plan.loopId !== loopId) throw new Error("Compiled plan not found");
  const ctx = await resolveLoopAuthWorkspace(auth, loop.workspaceId);

  try {
    if (plan.trigger.kind === "event") {
      await connectorProvider.registerTrigger({
        auth: ctx,
        loopId,
        workspaceId: loop.workspaceId,
        toolkit: plan.trigger.source,
        triggerSlug: plan.trigger.composioSlug,
        eventType: plan.trigger.eventType,
        config: plan.trigger.config,
      });
    }

    await activateCompiledPlan(ctx, loopId, compiledPlanId);
  } catch (error) {
    if (plan.trigger.kind === "event") {
      await connectorProvider.unregisterTrigger(loopId).catch(() => undefined);
      await setLoopStatus(ctx, loopId, "paused").catch(() => undefined);
    }
    throw error;
  }

  if (config.temporalEnabled) {
    const { upsertLoopSchedule } = await import("../temporal/schedules.js");
    await upsertLoopSchedule({
      loopId,
      workspaceId: loop.workspaceId,
      compiledPlanId,
      trigger: plan.trigger,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    });
  }

  await setLoopStatus(auth, loopId, "active");
  await commitLoopBuildArtifact({
    auth: ctx, loopId, phase: "activation", expectedParentHash: state.artifacts.test.artifactHash,
    artifact: {
      testHash: state.artifacts.test.artifactHash,
      compiledPlanId,
      confirmedByUser: true,
      activatedAt: new Date().toISOString(),
    }, source: "activation",
  });

  const { getLoopEventTriggerStatus } = await import("./store.js");
  const eventTrigger = plan.trigger.kind === "event"
    ? await getLoopEventTriggerStatus(loopId)
    : null;

  return {
    loopId,
    activePlanId: compiledPlanId,
    status: "active" as const,
    ...(eventTrigger ? { eventTrigger } : {}),
  };
}

export async function pauseLoop(auth: AuthContext, loopId: string) {
  await connectorProvider.unregisterTrigger(loopId);
  if (config.temporalEnabled) {
    const { deleteLoopSchedule } = await import("../temporal/schedules.js");
    await deleteLoopSchedule(loopId);
  }
  await setLoopStatus(auth, loopId, "paused");
  return { loopId, status: "paused" as const };
}

export async function resumeLoop(auth: AuthContext, loopId: string) {
  const loop = await getLoop(auth, loopId);
  if (!loop?.activePlanId) throw new Error("Loop has no active plan");
  const plan = await getCompiledPlan(loop.activePlanId);
  if (!plan) throw new Error("Active plan not found");
  const ctx = await resolveLoopAuthWorkspace(auth, loop.workspaceId);

  if (plan.trigger.kind === "event") {
    await connectorProvider.registerTrigger({
      auth: ctx,
      loopId,
      workspaceId: loop.workspaceId,
      toolkit: plan.trigger.source,
      triggerSlug: plan.trigger.composioSlug,
      eventType: plan.trigger.eventType,
      config: plan.trigger.config,
    });
  }

  if (config.temporalEnabled) {
    const { upsertLoopSchedule } = await import("../temporal/schedules.js");
    await upsertLoopSchedule({
      loopId,
      workspaceId: loop.workspaceId,
      compiledPlanId: plan.id,
      trigger: plan.trigger,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    });
  }

  await setLoopStatus(auth, loopId, "active");

  const { getLoopEventTriggerStatus } = await import("./store.js");
  const eventTrigger = plan.trigger.kind === "event"
    ? await getLoopEventTriggerStatus(loopId)
    : null;

  return {
    loopId,
    status: "active" as const,
    ...(eventTrigger ? { eventTrigger } : {}),
  };
}

export async function triggerManualRun(auth: AuthContext, loopId: string) {
  const loop = await getLoop(auth, loopId);
  if (!loop?.activePlanId) throw new Error("Loop has no active plan");
  const plan = await getCompiledPlan(loop.activePlanId);
  if (!plan) throw new Error("Active plan not found");

  const runId = randomUUID();
  if (config.temporalEnabled) {
    const run = await createLoopRun({
      id: runId,
      loopId,
      workspaceId: loop.workspaceId,
      compiledPlanId: plan.id,
      triggerKind: "manual",
    });
    const { startLoopRun } = await import("../temporal/start-loop-run.js");
    const temporal = await startLoopRun({
      loopId,
      workspaceId: loop.workspaceId,
      compiledPlanId: plan.id,
      runId,
      triggerKind: "manual",
      tenantId: auth.tenantId,
      userId: auth.userId,
    });
    await updateLoopRun(runId, { temporalWorkflowId: temporal.workflowId });
    return { ...run, temporal_workflow_id: temporal.workflowId };
  }

  const { executeLoopRunHeadless } = await import("../temporal/activities/loop-run.activity.js");
  const run = await createLoopRun({
    loopId,
    workspaceId: loop.workspaceId,
    compiledPlanId: plan.id,
    triggerKind: "manual",
  });
  void executeLoopRunHeadless({
    loopId,
    workspaceId: loop.workspaceId,
    compiledPlanId: plan.id,
    runId: run.id,
    triggerKind: "manual",
    tenantId: auth.tenantId,
    userId: auth.userId,
  });
  return run;
}

export async function renameLoop(auth: AuthContext, loopId: string, name: string) {
  const loop = await getLoop(auth, loopId);
  if (!loop) throw new Error("Loop not found");
  const updated = await updateLoopName(auth, loopId, name);
  if (!updated) throw new Error("Loop not found");
  return updated;
}

export async function moveLoopToWorkspace(
  auth: AuthContext,
  loopId: string,
  workspaceId: string,
) {
  const loop = await getLoop(auth, loopId);
  if (!loop) throw new Error("Loop not found");
  const ctx = await resolveLoopAuthWorkspace(auth, workspaceId);
  await moveLoopRow(auth, loopId, ctx.workspaceId!);
  return { loopId, workspaceId: ctx.workspaceId, needsRecompile: true };
}

export async function archiveLoop(auth: AuthContext, loopId: string) {
  await connectorProvider.unregisterTrigger(loopId);
  if (config.temporalEnabled) {
    const { deleteLoopSchedule } = await import("../temporal/schedules.js");
    await deleteLoopSchedule(loopId);
  }
  await setLoopStatus(auth, loopId, "archived");
  return { loopId, status: "archived" as const };
}

export {
  getLoop,
  getLatestSpec,
  listLoops,
  listLoopRuns,
  setLoopStatus,
  getMissingSlots,
  isReadyToCompile,
};
