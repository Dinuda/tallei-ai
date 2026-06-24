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
  getLoop,
  listLoopRuns,
  listLoops,
  moveLoopToWorkspace as moveLoopRow,
  saveSpecDraft,
  setLoopStatus,
  updateLoopRun,
} from "./store.js";
import { resolveWorkspaceId } from "../services/workspace/index.js";
import {
  registerLoopEventTrigger,
  unregisterLoopEventTrigger,
} from "../integrations/composio/triggers.js";

export async function resolveLoopAuthWorkspace(auth: AuthContext, workspaceId?: string | null) {
  const resolved = await resolveWorkspaceId(auth, workspaceId ?? auth.workspaceId);
  return { ...auth, workspaceId: resolved };
}

export async function createLoopInWorkspace(
  auth: AuthContext,
  input: { name: string; templateId?: string; workspaceId?: string },
) {
  const ctx = await resolveLoopAuthWorkspace(auth, input.workspaceId);
  const workspaceId = ctx.workspaceId!;
  return createLoop(ctx, { workspaceId, name: input.name, templateId: input.templateId });
}

export async function compileLoop(auth: AuthContext, loopId: string) {
  const spec = await getLatestSpec(auth, loopId);
  if (!spec) throw new Error("Loop spec not found");
  const ctx = await resolveLoopAuthWorkspace(auth, spec.workspaceId);
  return compileLoopSpec(ctx, loopId, spec);
}

export async function activateLoop(auth: AuthContext, loopId: string, compiledPlanId: string) {
  const loop = await getLoop(auth, loopId);
  if (!loop) throw new Error("Loop not found");
  const plan = await getCompiledPlan(compiledPlanId);
  if (!plan || plan.loopId !== loopId) throw new Error("Compiled plan not found");
  const ctx = await resolveLoopAuthWorkspace(auth, loop.workspaceId);
  await activateCompiledPlan(ctx, loopId, compiledPlanId);

  if (plan.trigger.kind === "event") {
    await registerLoopEventTrigger({
      auth: ctx,
      loopId,
      workspaceId: loop.workspaceId,
      source: plan.trigger.source,
      eventType: plan.trigger.eventType,
    });
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
  return { loopId, activePlanId: compiledPlanId, status: "active" };
}

export async function pauseLoop(auth: AuthContext, loopId: string) {
  await unregisterLoopEventTrigger(loopId);
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
    await registerLoopEventTrigger({
      auth: ctx,
      loopId,
      workspaceId: loop.workspaceId,
      source: plan.trigger.source,
      eventType: plan.trigger.eventType,
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
  return { loopId, status: "active" as const };
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
  await unregisterLoopEventTrigger(loopId);
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
  saveSpecDraft,
  setLoopStatus,
  getMissingSlots,
  isReadyToCompile,
};
