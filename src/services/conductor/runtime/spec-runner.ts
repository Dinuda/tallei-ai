import { randomUUID } from "crypto";
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  validateUIMessages,
  type UIMessage,
} from "ai";
import type { Response } from "express";

import type { AuthContext } from "../../../domain/auth/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import { createLoopFromDefinition, getLoopWorkflow } from "../workflow/creator.js";
import { LOOP_DEFINITION_VERSION } from "../workflow/types.js";
import { listLoopRunMessages, mergeRunChatMessages, normalizeRunMessages, replaceLoopRunMessages } from "./run-messages.js";
import { loadWorkflowWorkspaceId, withWorkflowWorkspaceAuth } from "./resolve-loop-run-auth.js";
import { parseLoopDefinitionSnapshot, type SpecRunDefinition } from "./spec-run-types.js";
import { slimLoopDefinitionForPersistence } from "./definition-slim.js";
import { startLoopRunWorkflow, cancelLoopRunWorkflow } from "../../../temporal/start-loop-run.js";
import { buildRunSeedMessage, projectRunContext, type RunContext } from "./build-run-context.js";
import { loadTriggerPayloadForRun } from "./trigger-payload.js";
import { enqueueLoopRunCommand } from "./spec-run-commands.js";
import {
  executeAgenticSpecRun,
  materializeSpecRunAgentSteps,
  SpecRunInteractionRequiredError,
} from "./spec-run-agent-runner.js";

const activeSpecRunChatStreams = new Set<string>();

export type SpecRunTriggerSource = "manual" | "schedule" | "event";

export type SpecRunTrigger = {
  source: SpecRunTriggerSource;
  label?: string;
  eventId?: string;
  triggerSlug?: string;
  triggerInstanceId?: string;
};

type SpecRunProjection = {
  id: string;
  workflowId: string;
  workflowTitle: string;
  status: "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";
  loopDefinition: SpecRunDefinition;
  summary: string | null;
  error: string | null;
  triggerSource: SpecRunTriggerSource;
  triggerLabel: string | null;
  builderSessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function parseTriggerFromContext(context: Record<string, unknown>): SpecRunTrigger {
  const trigger = context.trigger && typeof context.trigger === "object" && !Array.isArray(context.trigger)
    ? context.trigger as Record<string, unknown>
    : null;
  const source = trigger?.source;
  if (source === "manual" || source === "schedule" || source === "event") {
    return {
      source,
      label: typeof trigger?.label === "string" ? trigger.label : undefined,
      eventId: typeof trigger?.eventId === "string" ? trigger.eventId : undefined,
      triggerSlug: typeof trigger?.triggerSlug === "string" ? trigger.triggerSlug : undefined,
      triggerInstanceId: typeof trigger?.triggerInstanceId === "string" ? trigger.triggerInstanceId : undefined,
    };
  }
  return { source: "manual", label: "Manual" };
}

async function loadLoopDefinition(auth: AuthContext, workflowId: string): Promise<{ spec: SpecRunDefinition; title: string }> {
  const loop = await getLoopWorkflow(auth, workflowId);
  if (!loop?.definition) throw new Error("This workflow does not have a loop definition.");
  return { spec: loop.definition, title: loop.title };
}

export async function findBuilderSessionIdForWorkflow(
  auth: AuthContext,
  workflowId: string,
): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM workflow_builder_sessions
     WHERE workflow_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY updated_at DESC
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId],
  );
  return result.rows[0]?.id ?? null;
}

export async function createSpecLoopRun(
  auth: AuthContext,
  workflowId: string,
  trigger?: SpecRunTrigger,
): Promise<SpecRunProjection> {
  const { spec, title } = await loadLoopDefinition(auth, workflowId);
  const slimSpec = slimLoopDefinitionForPersistence(spec);
  const runId = randomUUID();
  const now = new Date().toISOString();
  const resolvedTrigger: SpecRunTrigger = trigger ?? { source: "manual", label: "Manual" };
  const contextJson = {
    engine: LOOP_DEFINITION_VERSION,
    trigger: resolvedTrigger,
  };

  await pool.query(
    `INSERT INTO loop_engine_runs
       (id, tenant_id, user_id, workflow_id, status, definition_snapshot, context_json, started_at)
     VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, $6::jsonb, $7::timestamptz)`,
    [
      runId,
      auth.tenantId,
      auth.userId,
      workflowId,
      JSON.stringify(slimSpec),
      JSON.stringify(contextJson),
      now,
    ],
  );

  await materializeSpecRunAgentSteps({ auth, runId, spec: slimSpec, workflowId });

  await pool.query(
    `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, event_type, payload_json)
     VALUES ($1, $2, $3, 'run_queued', $4::jsonb)`,
    [auth.tenantId, auth.userId, runId, JSON.stringify({
      workflowId,
      workflowTitle: title,
      engine: LOOP_DEFINITION_VERSION,
      trigger: resolvedTrigger,
    })],
  );

  return getSpecRunProjection(auth, runId);
}

export async function getSpecRunProjection(auth: AuthContext, runId: string): Promise<SpecRunProjection> {
  const result = await pool.query<{
    id: string;
    workflow_id: string;
    status: string;
    definition_snapshot: unknown;
    context_json: unknown;
    error_json: unknown;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
    title: string;
  }>(
    `SELECT r.id, r.workflow_id, r.status, r.definition_snapshot, r.context_json, r.error_json,
            r.started_at, r.finished_at, r.created_at, r.updated_at, w.title
     FROM loop_engine_runs r
     JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1 AND r.tenant_id = $2 AND r.user_id = $3
     LIMIT 1`,
    [runId, auth.tenantId, auth.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Run not found");

  const loopDefinition = parseLoopDefinitionSnapshot(row.definition_snapshot);
  if (!loopDefinition) throw new Error("Run is missing loop definition metadata");

  const context = row.context_json && typeof row.context_json === "object" && !Array.isArray(row.context_json)
    ? row.context_json as Record<string, unknown>
    : {};
  const errorJson = row.error_json && typeof row.error_json === "object" && !Array.isArray(row.error_json)
    ? row.error_json as Record<string, unknown>
    : {};

  const mappedStatus = row.status === "waiting_for_interaction"
    ? "waiting_for_approval"
    : row.status as SpecRunProjection["status"];

  const trigger = parseTriggerFromContext(context);
  const builderSessionId = await findBuilderSessionIdForWorkflow(auth, row.workflow_id);

  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowTitle: row.title,
    status: mappedStatus,
    loopDefinition,
    summary: typeof context.summary === "string" ? context.summary : null,
    error: typeof errorJson.message === "string" ? errorJson.message : null,
    triggerSource: trigger.source,
    triggerLabel: trigger.label ?? null,
    builderSessionId,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSpecLoopRuns(auth: AuthContext, workflowId: string): Promise<SpecRunProjection[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM loop_engine_runs
     WHERE workflow_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY created_at DESC LIMIT 50`,
    [workflowId, auth.tenantId, auth.userId],
  );
  const runs: SpecRunProjection[] = [];
  for (const row of result.rows) {
    try {
      runs.push(await getSpecRunProjection(auth, row.id));
    } catch {
      // skip legacy graph runs
    }
  }
  return runs;
}

async function setRunStatus(runId: string, status: string, extra?: { summary?: string; error?: string }) {
  const contextPatch = extra?.summary ? { summary: extra.summary } : {};
  const errorPatch = extra?.error ? { message: extra.error } : null;
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = $2,
         context_json = context_json || $3::jsonb,
         error_json = COALESCE($4::jsonb, error_json),
         finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN NOW() ELSE finished_at END,
         updated_at = NOW()
     WHERE id = $1`,
    [runId, status, JSON.stringify(contextPatch), errorPatch ? JSON.stringify(errorPatch) : null],
  );
}

async function resolveRunContext(input: {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  spec: SpecRunDefinition;
}): Promise<RunContext> {
  const result = await pool.query<{ context_json: unknown }>(
    `SELECT context_json FROM loop_engine_runs WHERE id = $1 LIMIT 1`,
    [input.runId],
  );
  const context = result.rows[0]?.context_json && typeof result.rows[0].context_json === "object" && !Array.isArray(result.rows[0].context_json)
    ? result.rows[0].context_json as Record<string, unknown>
    : {};
  const trigger = parseTriggerFromContext(context);
  const triggerPayload = await loadTriggerPayloadForRun({
    runId: input.runId,
    triggerInstanceId: trigger.triggerInstanceId,
    externalEventId: trigger.eventId,
  });
  return projectRunContext({
    spec: input.spec,
    workflowId: input.workflowId,
    trigger,
    triggerPayload,
  });
}

export async function streamSpecRunChat(input: {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  messages: UIMessage[];
  res: Response;
}): Promise<void> {
  if (activeSpecRunChatStreams.has(input.runId)) {
    if (!input.res.headersSent) {
      input.res.status(409).json({ error: "Run stream already in progress" });
    }
    return;
  }
  activeSpecRunChatStreams.add(input.runId);
  const releaseChatLock = () => {
    activeSpecRunChatStreams.delete(input.runId);
  };
  input.res.on("close", releaseChatLock);

  try {
  const projection = await getSpecRunProjection(input.auth, input.runId);
  const spec = projection.loopDefinition;
  const title = projection.workflowTitle;
  const workspaceId = await loadWorkflowWorkspaceId(input.auth.tenantId, input.auth.userId, input.workflowId);
  const hydratedAuth = withWorkflowWorkspaceAuth(input.auth, workspaceId);
  const runContext = await resolveRunContext({
    auth: hydratedAuth,
    workflowId: input.workflowId,
    runId: input.runId,
    spec,
  });
  const normalizedMessages = await validateUIMessages({ messages: normalizeRunMessages(input.messages) });
  const existingMessages = await listLoopRunMessages(hydratedAuth, input.runId);
  const triggerSeedMessages: UIMessage[] = [{
    id: randomUUID(),
    role: "user",
    parts: [{ type: "text", text: buildRunSeedMessage(runContext, spec) }],
  }];
  const messages: UIMessage[] = normalizedMessages.length > 0
    ? mergeRunChatMessages(existingMessages, normalizedMessages)
    : existingMessages.length > 0
      ? existingMessages
      : triggerSeedMessages;
  await replaceLoopRunMessages(hydratedAuth, input.runId, messages);

  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: async ({ writer }) => {
      writer.write({ type: "data-run", data: { runId: input.runId, workflowId: input.workflowId }, transient: true });
      try {
        await executeAgenticSpecRun({
          auth: hydratedAuth,
          workflowId: input.workflowId,
          runId: input.runId,
          spec,
          workflowTitle: title,
          runContext,
          writer,
        });
      } catch (error) {
        if (!(error instanceof SpecRunInteractionRequiredError)) {
          throw error;
        }
      }
      const projection = await getSpecRunProjection(hydratedAuth, input.runId);
      writer.write({
        type: "data-run",
        data: {
          runId: input.runId,
          workflowId: input.workflowId,
          status: projection.status,
          summary: projection.summary,
        },
        transient: true,
      });
    },
    onFinish: async ({ messages: completedMessages }) => {
      try {
        await replaceLoopRunMessages(hydratedAuth, input.runId, completedMessages);
      } finally {
        releaseChatLock();
      }
    },
  });
  pipeUIMessageStreamToResponse({ response: input.res, stream });
  } catch (error) {
    releaseChatLock();
    throw error;
  }
}

export async function executeSpecRunHeadless(
  auth: AuthContext,
  workflowId: string,
  runId: string,
): Promise<void> {
  const projection = await getSpecRunProjection(auth, runId);
  const spec = projection.loopDefinition;
  const title = projection.workflowTitle;
  const workspaceId = await loadWorkflowWorkspaceId(auth.tenantId, auth.userId, workflowId);
  const hydratedAuth = withWorkflowWorkspaceAuth(auth, workspaceId);
  const runContext = await resolveRunContext({
    auth: hydratedAuth,
    workflowId,
    runId,
    spec,
  });
  const existingMessages = await listLoopRunMessages(hydratedAuth, runId);
  const triggerSeedMessages: UIMessage[] = [{
    id: randomUUID(),
    role: "user",
    parts: [{ type: "text", text: buildRunSeedMessage(runContext, spec) }],
  }];
  const initialMessages: UIMessage[] = existingMessages.length > 0
    ? existingMessages
    : triggerSeedMessages;
  if (existingMessages.length === 0) {
    await replaceLoopRunMessages(hydratedAuth, runId, initialMessages);
  }

  try {
    await executeAgenticSpecRun({
      auth: hydratedAuth,
      workflowId,
      runId,
      spec,
      workflowTitle: title,
      runContext,
    });
  } catch (error) {
    if (error instanceof SpecRunInteractionRequiredError) return;
    const message = error instanceof Error ? error.message : String(error);
    await setRunStatus(runId, "failed", { error: message });
    throw error;
  }
}

export async function runSpecLoopHeadless(auth: AuthContext, workflowId: string, runId?: string): Promise<SpecRunProjection> {
  const projection = runId
    ? await getSpecRunProjection(auth, runId)
    : await createSpecLoopRun(auth, workflowId, { source: "schedule", label: "Scheduled" });

  await executeSpecRunHeadless(auth, workflowId, projection.id);
  return getSpecRunProjection(auth, projection.id);
}

export async function getSpecRunMessages(auth: AuthContext, runId: string): Promise<UIMessage[]> {
  return listLoopRunMessages(auth, runId);
}

export async function startSpecManualLoopRun(auth: AuthContext, workflowId: string): Promise<SpecRunProjection> {
  const run = await createSpecLoopRun(auth, workflowId, { source: "manual", label: "Manual" });
  await enqueueLoopRunCommand({
    auth,
    runId: run.id,
    commandType: "start_run",
    idempotencyKey: `spec-run:${run.id}:start`,
    payload: { workflowId, trigger: "manual" },
  });
  await startLoopRunWorkflow({
    tenantId: auth.tenantId,
    userId: auth.userId,
    workflowId,
    runId: run.id,
    trigger: { source: "manual", label: "Manual" },
  });
  return run;
}

export async function cancelSpecLoopRun(auth: AuthContext, runId: string): Promise<SpecRunProjection> {
  const projection = await getSpecRunProjection(auth, runId);
  if (projection.status === "succeeded" || projection.status === "failed" || projection.status === "cancelled") {
    return projection;
  }

  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [runId, auth.tenantId, auth.userId],
  );

  await cancelLoopRunWorkflow({
    tenantId: auth.tenantId,
    workflowId: projection.workflowId,
    runId,
  });

  return getSpecRunProjection(auth, runId);
}

export async function retrySpecLoopRun(auth: AuthContext, runId: string): Promise<SpecRunProjection> {
  const projection = await getSpecRunProjection(auth, runId);
  if (projection.status === "running" || projection.status === "queued") {
    throw new Error("This run is still in progress.");
  }

  const workspaceId = await loadWorkflowWorkspaceId(auth.tenantId, auth.userId, projection.workflowId);
  const hydratedAuth = withWorkflowWorkspaceAuth(auth, workspaceId);

  await pool.query(
    `DELETE FROM loop_engine_step_attempts
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3`,
    [runId, hydratedAuth.tenantId, hydratedAuth.userId],
  );
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'queued',
         error_json = '{}'::jsonb,
         finished_at = NULL,
         context_json = context_json - 'summary',
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [runId, hydratedAuth.tenantId, hydratedAuth.userId],
  );
  await materializeSpecRunAgentSteps({
    auth: hydratedAuth,
    runId,
    spec: projection.loopDefinition,
    workflowId: projection.workflowId,
  });
  await replaceLoopRunMessages(hydratedAuth, runId, []);
  await enqueueLoopRunCommand({
    auth: hydratedAuth,
    runId,
    commandType: "start_run",
    idempotencyKey: `spec-run:${runId}:retry:${Date.now()}`,
    payload: { workflowId: projection.workflowId, retry: true },
  });

  await startLoopRunWorkflow({
    tenantId: hydratedAuth.tenantId,
    userId: hydratedAuth.userId,
    workflowId: projection.workflowId,
    runId,
    trigger: {
      source: projection.triggerSource,
      label: projection.triggerLabel ?? "Retry",
    },
  });

  return getSpecRunProjection(hydratedAuth, runId);
}

export async function saveSpecRunAsLoop(input: {
  auth: AuthContext;
  runId: string;
  title?: string;
  definition?: unknown;
}): Promise<{ loop: Awaited<ReturnType<typeof createLoopFromDefinition>> }> {
  const projection = await getSpecRunProjection(input.auth, input.runId);
  const definition = input.definition === undefined
    ? projection.loopDefinition
    : parseLoopDefinitionSnapshot(input.definition);
  if (!definition) throw new Error("Edited run definition is invalid.");
  const workspaceId = await loadWorkflowWorkspaceId(input.auth.tenantId, input.auth.userId, projection.workflowId);
  const loop = await createLoopFromDefinition({
    auth: input.auth,
    definition: slimLoopDefinitionForPersistence(definition),
    title: input.title ?? `${projection.workflowTitle} copy`,
    workspaceId,
    initialStatus: "verifying",
    provenance: {
      source: "run_snapshot",
      sourceWorkflowId: projection.workflowId,
      sourceRunId: projection.id,
      sourceBuilderSessionId: projection.builderSessionId,
      savedAt: new Date().toISOString(),
    },
  });
  return { loop };
}

export async function isSpecDrivenWorkflow(auth: AuthContext, workflowId: string): Promise<boolean> {
  const loop = await getLoopWorkflow(auth, workflowId);
  return Boolean(loop?.definition);
}

export function scheduleTriggerLabel(scheduleRrule: string): string {
  const cron = scheduleRrule.replace(/^CRON:/i, "").trim();
  if (cron === "0 * * * *") return "Hourly schedule";
  if (cron === "0 9 * * *") return "Daily schedule";
  if (cron === "0 9 * * 1") return "Weekly schedule";
  return `Schedule (${cron})`;
}
