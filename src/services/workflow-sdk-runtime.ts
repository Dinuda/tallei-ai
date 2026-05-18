import type { World } from "@workflow/world";
import { createWorld } from "@workflow/world-postgres";

import { config } from "../config/index.js";
import { pool } from "../infrastructure/db/pool.js";

let world: (World & { start(): Promise<void> }) | null = null;
let worldStarted = false;
let worldStarting: Promise<void> | null = null;
let runPollingTimer: ReturnType<typeof setInterval> | null = null;
const inFlightRunIds = new Set<string>();

type WorkflowSdkRunExecution = {
  workflowName: string;
  runId: string;
  input: unknown;
  executionContext?: Record<string, unknown>;
};

export type WorkflowSdkRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type WorkflowSdkRunProcessorResult = {
  deferred?: boolean;
  output?: unknown;
};

type WorkflowSdkRunProcessor = (run: WorkflowSdkRunExecution) => Promise<WorkflowSdkRunProcessorResult>;

let runProcessor: WorkflowSdkRunProcessor | null = null;
let runStatusObserver: ((input: { runId: string; status: WorkflowSdkRunStatus }) => Promise<void> | void) | null = null;

const RUN_POLL_MS = 5_000;

export function registerWorkflowSdkRunProcessor(processor: WorkflowSdkRunProcessor): void {
  runProcessor = processor;
}

export function registerWorkflowSdkRunStatusObserver(
  observer: (input: { runId: string; status: WorkflowSdkRunStatus }) => Promise<void> | void
): void {
  runStatusObserver = observer;
}

export function isWorkflowSdkEnabled(): boolean {
  return config.workflowTargetWorld === "@workflow/world-postgres";
}

export async function startWorkflowSdkRuntime(): Promise<void> {
  if (!isWorkflowSdkEnabled()) return;
  if (worldStarted) return;
  if (worldStarting) {
    await worldStarting;
    return;
  }

  worldStarting = (async () => {
    world = createWorld({
      pool,
      jobPrefix: config.workflowPostgresJobPrefix,
      queueConcurrency: config.workflowPostgresQueueConcurrency,
    });

    await world.start();
    worldStarted = true;
    console.log("[workflow-sdk] Postgres world started");
    startRunPollingLoop();
  })();
  try {
    await worldStarting;
  } finally {
    worldStarting = null;
  }
}

export async function stopWorkflowSdkRuntime(): Promise<void> {
  if (!worldStarted) return;
  if (runPollingTimer) {
    clearInterval(runPollingTimer);
    runPollingTimer = null;
  }
  inFlightRunIds.clear();
  try {
    await world?.close?.();
  } finally {
    world = null;
    worldStarted = false;
  }
}

function startRunPollingLoop(): void {
  if (runPollingTimer) return;
  runPollingTimer = setInterval(() => {
    void processPendingRunsTick();
  }, RUN_POLL_MS);
  runPollingTimer.unref?.();
  void processPendingRunsTick();
}

async function processPendingRunsTick(): Promise<void> {
  if (!runProcessor || !worldStarted || !world) return;
  try {
    const runs = await world.runs.list({
      status: "pending",
      pagination: { limit: 50 },
      resolveData: "all",
    });
    for (const run of runs.data ?? []) {
      const runRecord = run as { runId?: unknown };
      const runId = typeof runRecord.runId === "string" ? runRecord.runId : null;
      if (!runId || inFlightRunIds.has(runId)) continue;
      await emitRunStatus(runId, "pending");
      inFlightRunIds.add(runId);
      void executeRun(runId).finally(() => inFlightRunIds.delete(runId));
    }
  } catch (error) {
    console.error("[workflow-sdk] failed to poll pending runs:", error);
  }
}

async function executeRun(runId: string): Promise<void> {
  const startedWorld = await requireStartedWorld();
  if (!runProcessor) return;

  let run: Awaited<ReturnType<typeof startedWorld.runs.get>>;
  try {
    run = await startedWorld.runs.get(runId, { resolveData: "all" });
  } catch (error) {
    console.error("[workflow-sdk] failed to load run:", runId, error);
    return;
  }

  const runRecord = run as {
    status?: unknown;
    workflowName?: unknown;
    runId?: unknown;
    input?: unknown;
    executionContext?: unknown;
  };
  if (runRecord.status !== "pending") return;

  try {
    await startedWorld.events.create(runId, { eventType: "run_started" });
    await emitRunStatus(runId, "running");
  } catch {
    return;
  }

  try {
    const result = await runProcessor({
      workflowName: typeof runRecord.workflowName === "string" ? runRecord.workflowName : "",
      runId: typeof runRecord.runId === "string" ? runRecord.runId : runId,
      input: runRecord.input,
      executionContext: (
        runRecord.executionContext &&
        typeof runRecord.executionContext === "object" &&
        !Array.isArray(runRecord.executionContext)
      )
        ? runRecord.executionContext as Record<string, unknown>
        : undefined,
    });

    if (result?.deferred) return;

    await startedWorld.events.create(runId, {
      eventType: "run_completed",
      eventData: {
        output: result?.output ?? { ok: true },
      },
    });
    await emitRunStatus(runId, "completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await startedWorld.events.create(runId, {
      eventType: "run_failed",
      eventData: { error: { message } },
    });
    await emitRunStatus(runId, "failed");
  }
}

async function emitRunStatus(runId: string, status: WorkflowSdkRunStatus): Promise<void> {
  if (!runStatusObserver) return;
  try {
    await runStatusObserver({ runId, status });
  } catch (error) {
    console.error("[workflow-sdk] run status observer failed:", { runId, status, error });
  }
}

async function requireStartedWorld(): Promise<World & { start(): Promise<void> }> {
  await startWorkflowSdkRuntime();
  if (!world || !worldStarted) {
    throw new Error("Workflow SDK world is not started");
  }
  return world;
}

export async function createWorkflowSdkRun(input: {
  workflowName: string;
  workflowInput: unknown;
  executionContext?: Record<string, unknown>;
}): Promise<string | null> {
  if (!isWorkflowSdkEnabled()) return null;
  const startedWorld = await requireStartedWorld();
  const deploymentId = await startedWorld.getDeploymentId();
  const created = await startedWorld.events.create(null, {
    eventType: "run_created",
    eventData: {
      deploymentId,
      workflowName: input.workflowName,
      input: input.workflowInput,
      executionContext: input.executionContext,
    },
  });
  const createdRun = (created as { run?: { runId?: unknown } }).run;
  if (!createdRun || typeof createdRun.runId !== "string") {
    throw new Error("Workflow SDK did not return a valid runId");
  }
  return createdRun.runId;
}

export async function completeWorkflowSdkRun(runId: string, output: unknown): Promise<void> {
  if (!isWorkflowSdkEnabled()) return;
  const startedWorld = await requireStartedWorld();
  try {
    await startedWorld.events.create(runId, {
      eventType: "run_completed",
      eventData: { output },
    });
    await emitRunStatus(runId, "completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/terminal state|completed|cancelled|failed/i.test(message)) return;
    throw error;
  }
}

export async function failWorkflowSdkRun(runId: string, error: { message: string; code?: string }): Promise<void> {
  if (!isWorkflowSdkEnabled()) return;
  const startedWorld = await requireStartedWorld();
  await startedWorld.events.create(runId, {
    eventType: "run_failed",
    eventData: { error, errorCode: error.code },
  });
}

export async function cancelWorkflowSdkRun(runId: string): Promise<void> {
  if (!isWorkflowSdkEnabled()) return;
  const startedWorld = await requireStartedWorld();
  try {
    await startedWorld.events.create(runId, {
      eventType: "run_cancelled",
    });
    await emitRunStatus(runId, "cancelled");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/terminal state|completed|cancelled|failed/i.test(message)) return;
    throw error;
  }
}

export async function getWorkflowSdkRunDetails(runId: string): Promise<{
  run: unknown;
  events: unknown[];
}> {
  if (!isWorkflowSdkEnabled()) {
    throw new Error("Workflow SDK runtime is disabled");
  }
  const startedWorld = await requireStartedWorld();
  const run = await startedWorld.runs.get(runId, { resolveData: "none" as const });
  const events = await startedWorld.events.list({
    runId,
    pagination: { limit: 200 },
    resolveData: "none",
  });
  return {
    run,
    events: events.data ?? [],
  };
}
