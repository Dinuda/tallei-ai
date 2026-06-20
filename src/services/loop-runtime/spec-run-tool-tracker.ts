import { randomUUID } from "crypto";
import { type Tool } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import type { RunContext } from "./build-run-context.js";
import { enrichDraftPayload } from "./spec-run-write-payload.js";
import {
  createWriteToolApprovalInteraction,
} from "./spec-run-interactions.js";

export class SpecRunApprovalRequiredError extends Error {
  readonly stepAttemptId: string;
  readonly interactionId: string;

  constructor(stepAttemptId: string, interactionId: string) {
    super("Run paused for operator approval");
    this.name = "SpecRunApprovalRequiredError";
    this.stepAttemptId = stepAttemptId;
    this.interactionId = interactionId;
  }
}

type ToolTrackerContext = {
  auth: AuthContext;
  runId: string;
  workflowId: string;
};

type DeferredWriteRef = {
  toolkit: string;
  actionSlug: string;
  actionLabel: string;
  isSendAction: boolean;
};

type ToolMeta = {
  displayName: string;
  task: string;
  toolRef: string;
  requiresApproval?: boolean;
  deferredWrite?: DeferredWriteRef;
};

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function humanizeActionSlug(slug: string): string {
  return titleCase(slug.replace(/^GMAIL_|^SLACK_|^NOTION_/i, ""));
}

export function toolDisplayName(toolKey: string): string {
  if (toolKey === "getTriggerTicket") return "Ticket Intake";
  if (toolKey === "searchMemory") return "Memory Search";
  if (toolKey === "searchWeb") return "Web Search";
  if (toolKey === "finalizeRun") return "Complete Run";
  if (toolKey === "recordClassification") return "Classification";
  if (toolKey.startsWith("search_")) {
    const toolkit = toolKey.slice("search_".length).replace(/_/g, " ");
    return `${titleCase(toolkit)} Search`;
  }
  if (toolKey.startsWith("action_")) {
    const parts = toolKey.split("_");
    const slugParts = parts.slice(2);
    return humanizeActionSlug(slugParts.join("_"));
  }
  return titleCase(toolKey);
}

function toolRefForKey(toolKey: string, deferredWrite?: ToolMeta["deferredWrite"]): string {
  if (toolKey === "searchMemory") return "internal.memory_search";
  if (toolKey === "searchWeb") return "internal.web_search";
  if (toolKey === "getTriggerTicket") return "internal.trigger_ticket";
  if (toolKey === "finalizeRun") return "internal.finalize_run";
  if (toolKey === "recordClassification") return "internal.record_classification";
  if (toolKey.startsWith("search_")) {
    const toolkit = toolKey.slice("search_".length);
    return `composio.${toolkit}.search`;
  }
  if (deferredWrite?.actionSlug) {
    return `composio.${deferredWrite.toolkit}.action.${deferredWrite.actionSlug}`;
  }
  return `internal.${toolKey}`;
}

function inferToolMeta(toolKey: string, deferredWrite?: ToolMeta["deferredWrite"]): ToolMeta {
  return {
    displayName: toolDisplayName(toolKey),
    task: `Execute ${toolDisplayName(toolKey)}`,
    toolRef: toolRefForKey(toolKey, deferredWrite),
    requiresApproval: Boolean(deferredWrite),
    deferredWrite,
  };
}

async function nextStepIndex(runId: string): Promise<number> {
  const result = await pool.query<{ next_index: number }>(
    `SELECT COALESCE(MAX(step_index), -1) + 1 AS next_index
     FROM loop_engine_step_attempts
     WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0]?.next_index ?? 0;
}

async function emitToolEvent(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  eventType: "tool_spawned" | "tool_completed" | "approval_requested";
  payload: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, step_attempt_id, event_type, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId,
      input.eventType,
      JSON.stringify(input.payload),
    ],
  );
}

async function spawnStepAttempt(input: {
  ctx: ToolTrackerContext;
  toolKey: string;
  meta: ToolMeta;
  inputJson: Record<string, unknown>;
}): Promise<{ stepId: string; stepIndex: number }> {
  const stepId = randomUUID();
  const stepIndex = await nextStepIndex(input.ctx.runId);
  await pool.query(
    `INSERT INTO loop_engine_step_attempts
       (id, tenant_id, user_id, run_id, step_index, agent_id, agent_snapshot, attempt, status, input_json, output_json, error_json, started_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, 'running', $8::jsonb, '{}'::jsonb, '{}'::jsonb, NOW(), NOW(), NOW())`,
    [
      stepId,
      input.ctx.auth.tenantId,
      input.ctx.auth.userId,
      input.ctx.runId,
      stepIndex,
      input.toolKey,
      JSON.stringify({
        id: input.toolKey,
        name: input.meta.displayName,
        task: input.meta.task,
        tools: [{ ref: input.meta.toolRef }],
      }),
      JSON.stringify(input.inputJson),
    ],
  );
  await emitToolEvent({
    auth: input.ctx.auth,
    runId: input.ctx.runId,
    stepAttemptId: stepId,
    eventType: "tool_spawned",
    payload: {
      toolKey: input.toolKey,
      displayName: input.meta.displayName,
    },
  });
  return { stepId, stepIndex };
}

async function completeStepAttempt(input: {
  ctx: ToolTrackerContext;
  stepAttemptId: string;
  toolKey: string;
  output: unknown;
}) {
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'succeeded',
         output_json = $2::jsonb,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.stepAttemptId,
      JSON.stringify({ data: input.output }),
    ],
  );
  await emitToolEvent({
    auth: input.ctx.auth,
    runId: input.ctx.runId,
    stepAttemptId: input.stepAttemptId,
    eventType: "tool_completed",
    payload: { toolKey: input.toolKey },
  });
}

async function failStepAttempt(stepAttemptId: string, message: string) {
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'failed',
         error_json = $2::jsonb,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [stepAttemptId, JSON.stringify({ message })],
  );
}

async function markStepWaiting(stepAttemptId: string) {
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'waiting_for_interaction', updated_at = NOW()
     WHERE id = $1`,
    [stepAttemptId],
  );
}

async function setRunWaitingForApproval(runId: string) {
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'waiting_for_interaction', updated_at = NOW()
     WHERE id = $1`,
    [runId],
  );
}

async function isStepApproved(stepAttemptId: string): Promise<{ output: unknown } | null> {
  const result = await pool.query<{ decision_json: unknown }>(
    `SELECT decision_json
     FROM loop_engine_interactions
     WHERE step_attempt_id = $1 AND status = 'approved'
     ORDER BY created_at DESC
     LIMIT 1`,
    [stepAttemptId],
  );
  const decision = result.rows[0]?.decision_json;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const output = (decision as Record<string, unknown>).output;
  return output !== undefined ? { output } : null;
}

export type DeferredWriteMeta = {
  toolkit: string;
  actionSlug: string;
  actionLabel: string;
  isSendAction: boolean;
};

export function buildTrackedSpecRunTools(input: {
  auth: AuthContext;
  runId: string;
  workflowId: string;
  tools: Record<string, Tool>;
  deferredWrites?: Record<string, DeferredWriteMeta>;
  runContext?: RunContext;
}) {
  const ctx: ToolTrackerContext = {
    auth: input.auth,
    runId: input.runId,
    workflowId: input.workflowId,
  };
  const tracked: Record<string, Tool> = {};

  for (const [toolKey, baseTool] of Object.entries(input.tools)) {
    const deferredWrite = input.deferredWrites?.[toolKey];
    const meta = inferToolMeta(toolKey, deferredWrite ? {
      toolkit: deferredWrite.toolkit,
      actionSlug: deferredWrite.actionSlug,
      actionLabel: deferredWrite.actionLabel,
      isSendAction: deferredWrite.isSendAction,
    } : undefined);

    const { execute, needsApproval: _ignored, ...rest } = baseTool as Tool & {
      execute?: (args: Record<string, unknown>) => Promise<unknown>;
      needsApproval?: boolean;
    };
    if (!execute) {
      tracked[toolKey] = baseTool;
      continue;
    }

    tracked[toolKey] = {
      ...rest,
      execute: async (args: Record<string, unknown>) => {
        const { stepId: stepAttemptId, stepIndex } = await spawnStepAttempt({
          ctx,
          toolKey,
          meta,
          inputJson: args,
        });

        if (meta.requiresApproval && deferredWrite) {
          const priorApproval = await isStepApproved(stepAttemptId);
          if (priorApproval) {
            await completeStepAttempt({
              ctx,
              stepAttemptId,
              toolKey,
              output: priorApproval.output,
            });
            return priorApproval.output;
          }

          const rawPayload = (args.payload && typeof args.payload === "object" && !Array.isArray(args.payload))
            ? args.payload as Record<string, unknown>
            : {};
          const enrichedPayload = enrichDraftPayload(
            deferredWrite.actionSlug,
            rawPayload,
            input.runContext,
          );
          const interactionId = await createWriteToolApprovalInteraction({
            auth: input.auth,
            runId: input.runId,
            stepAttemptId,
            toolKey,
            deferred: {
              toolkit: deferredWrite.toolkit,
              actionSlug: deferredWrite.actionSlug,
              actionLabel: deferredWrite.actionLabel,
              isSendAction: deferredWrite.isSendAction,
              payload: enrichedPayload,
              rationale: typeof args.rationale === "string" ? args.rationale : undefined,
            },
            agentName: meta.displayName,
            stepIndex,
          });

          await markStepWaiting(stepAttemptId);
          await setRunWaitingForApproval(input.runId);
          await emitToolEvent({
            auth: input.auth,
            runId: input.runId,
            stepAttemptId,
            eventType: "approval_requested",
            payload: {
              toolKey,
              interactionId,
              displayName: meta.displayName,
            },
          });
          throw new SpecRunApprovalRequiredError(stepAttemptId, interactionId);
        }

        try {
          const output = await execute(args);
          await completeStepAttempt({
            ctx,
            stepAttemptId,
            toolKey,
            output,
          });
          return output;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await failStepAttempt(stepAttemptId, message);
          throw error;
        }
      },
    };
  }

  return tracked;
}
