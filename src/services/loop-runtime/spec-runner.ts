import { randomUUID } from "crypto";
import {
  convertToModelMessages,
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  validateUIMessages,
  type UIMessage,
} from "ai";
import type { Response } from "express";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { loopBuilderOpenAiModel, loopBuilderStreamProviderOptions } from "../loop-builder/openai-chat.js";
import { sanitizeLoopBuilderChatMessages } from "../loop-builder/sessions.js";
import { resolveLoopChatLanguageModel } from "../llm/loop-chat-client.js";
import { getLoopWorkflow } from "../loop-executor/creator.js";
import { listLoopRunMessages, normalizeRunMessages, replaceLoopRunMessages } from "./run-messages.js";
import { buildSpecRunSystemPrompt } from "./spec-run-prompt.js";
import { loadWorkflowWorkspaceId, withWorkflowWorkspaceAuth } from "./resolve-loop-run-auth.js";
import { buildSpecRunTools } from "./spec-run-tools.js";
import { parseRunnableSpec, type RunnableSpec } from "./spec-run-types.js";
import { startLoopRunWorkflow, cancelLoopRunWorkflow } from "../../temporal/start-loop-run.js";
import { buildRunSeedMessage, projectRunContext, type RunContext } from "./build-run-context.js";
import { loadTriggerPayloadForRun } from "./trigger-payload.js";

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
  runnableSpec: RunnableSpec;
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

async function loadRunnableSpec(auth: AuthContext, workflowId: string): Promise<{ spec: RunnableSpec; title: string }> {
  const loop = await getLoopWorkflow(auth, workflowId);
  if (!loop?.runnableSpec) throw new Error("This workflow does not have a runnable spec. Re-save from the loop builder.");
  return { spec: loop.runnableSpec, title: loop.title };
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
  const { spec, title } = await loadRunnableSpec(auth, workflowId);
  const runId = randomUUID();
  const now = new Date().toISOString();
  const resolvedTrigger: SpecRunTrigger = trigger ?? { source: "manual", label: "Manual" };
  const contextJson = {
    engine: "loop_spec_v1",
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
      JSON.stringify({ engine: "loop_spec_v1", goal: spec.goal }),
      JSON.stringify(contextJson),
      now,
    ],
  );

  await pool.query(
    `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, event_type, payload_json)
     VALUES ($1, $2, $3, 'run_queued', $4::jsonb)`,
    [auth.tenantId, auth.userId, runId, JSON.stringify({
      workflowId,
      workflowTitle: title,
      engine: "loop_spec_v1",
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
    metadata_json: unknown;
  }>(
    `SELECT r.id, r.workflow_id, r.status, r.definition_snapshot, r.context_json, r.error_json,
            r.started_at, r.finished_at, r.created_at, r.updated_at, w.title, w.metadata_json
     FROM loop_engine_runs r
     JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1 AND r.tenant_id = $2 AND r.user_id = $3
     LIMIT 1`,
    [runId, auth.tenantId, auth.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Run not found");

  const runnableSpec = parseRunnableSpec(row.metadata_json);
  if (!runnableSpec) throw new Error("Run workflow is missing runnable spec metadata");

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
    runnableSpec,
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

async function consumeUIMessageStream(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

type ExecuteSpecRunInput = {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  messages: UIMessage[];
  mode: "headless" | "stream";
  res?: Response;
  runContext?: RunContext;
};

async function resolveRunContext(input: {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  spec: RunnableSpec;
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

async function executeSpecRun(input: ExecuteSpecRunInput): Promise<void> {
  const { spec, title } = await loadRunnableSpec(input.auth, input.workflowId);
  const workspaceId = await loadWorkflowWorkspaceId(input.auth.tenantId, input.auth.userId, input.workflowId);
  const auth = withWorkflowWorkspaceAuth(input.auth, workspaceId);
  const runContext = input.runContext ?? await resolveRunContext({
    auth,
    workflowId: input.workflowId,
    runId: input.runId,
    spec,
  });

  await pool.query(
    `UPDATE loop_engine_runs SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1`,
    [input.runId],
  );

  const tools = buildSpecRunTools({
    auth,
    spec,
    runId: input.runId,
    workflowId: input.workflowId,
    workflowTitle: title,
    runContext,
    onFinalize: async (summary) => {
      await setRunStatus(input.runId, "succeeded", { summary });
      await pool.query(
        `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, event_type, payload_json)
         VALUES ($1, $2, $3, 'run_succeeded', $4::jsonb)`,
        [input.auth.tenantId, input.auth.userId, input.runId, JSON.stringify({ summary })],
      );
    },
  });

  const system = buildSpecRunSystemPrompt(spec, runContext);
  const modelId = loopBuilderOpenAiModel();
  const model = resolveLoopChatLanguageModel(modelId);
  const apiMessages = sanitizeLoopBuilderChatMessages(input.messages);
  const result = streamText({
    model,
    system,
    messages: await convertToModelMessages(apiMessages, { tools }),
    tools,
    providerOptions: loopBuilderStreamProviderOptions(modelId),
    stopWhen: stepCountIs(12),
    onError: ({ error }) => console.error("Spec loop run stream failed:", error),
  });

  const stream = createUIMessageStream({
    originalMessages: input.messages,
    execute: async ({ writer }) => {
      if (input.mode === "stream") {
        writer.write({ type: "data-run", data: { runId: input.runId, workflowId: input.workflowId }, transient: true });
      }
      writer.merge(result.toUIMessageStream({ originalMessages: input.messages, sendReasoning: true }));
    },
    onFinish: async ({ messages: completedMessages }) => {
      await replaceLoopRunMessages(input.auth, input.runId, completedMessages);
      const current = await getSpecRunProjection(auth, input.runId);
      if (current.status !== "succeeded" && current.status !== "failed" && current.status !== "cancelled") {
        const lastAssistant = [...completedMessages].reverse().find((message) => message.role === "assistant");
        const text = lastAssistant?.parts
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (text) {
          await setRunStatus(input.runId, "succeeded", { summary: text.slice(0, 2000) });
        }
      }
    },
    onError: (error) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
  });

  if (input.mode === "stream" && input.res) {
    pipeUIMessageStreamToResponse({ response: input.res, stream });
    return;
  }

  await consumeUIMessageStream(stream);
}

export async function streamSpecRunChat(input: {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  messages: UIMessage[];
  res: Response;
}): Promise<void> {
  const messages = await validateUIMessages({ messages: normalizeRunMessages(input.messages) });
  await replaceLoopRunMessages(input.auth, input.runId, messages);
  await executeSpecRun({
    auth: input.auth,
    workflowId: input.workflowId,
    runId: input.runId,
    messages,
    mode: "stream",
    res: input.res,
  });
}

export async function executeSpecRunHeadless(
  auth: AuthContext,
  workflowId: string,
  runId: string,
): Promise<void> {
  const { spec } = await loadRunnableSpec(auth, workflowId);
  const workspaceId = await loadWorkflowWorkspaceId(auth.tenantId, auth.userId, workflowId);
  const hydratedAuth = withWorkflowWorkspaceAuth(auth, workspaceId);
  const runContext = await resolveRunContext({
    auth: hydratedAuth,
    workflowId,
    runId,
    spec,
  });
  const initialMessages: UIMessage[] = [{
    id: randomUUID(),
    role: "user",
    parts: [{ type: "text", text: buildRunSeedMessage(runContext, spec) }],
  }];

  try {
    await executeSpecRun({
      auth: hydratedAuth,
      workflowId,
      runId,
      messages: initialMessages,
      mode: "headless",
      runContext,
    });
  } catch (error) {
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
    `UPDATE loop_engine_runs
     SET status = 'queued',
         error_json = '{}'::jsonb,
         finished_at = NULL,
         context_json = context_json - 'summary',
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [runId, hydratedAuth.tenantId, hydratedAuth.userId],
  );
  await replaceLoopRunMessages(hydratedAuth, runId, []);

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

export async function isSpecDrivenWorkflow(auth: AuthContext, workflowId: string): Promise<boolean> {
  const loop = await getLoopWorkflow(auth, workflowId);
  return Boolean(loop?.runnableSpec);
}

export function scheduleTriggerLabel(scheduleRrule: string): string {
  const cron = scheduleRrule.replace(/^CRON:/i, "").trim();
  if (cron === "0 * * * *") return "Hourly schedule";
  if (cron === "0 9 * * *") return "Daily schedule";
  if (cron === "0 9 * * 1") return "Weekly schedule";
  return `Schedule (${cron})`;
}
