import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { runLoopTool } from "./integration-registry.js";
import { LOOP_DEFINITION_VERSION, loopDefinitionSchema, type LoopDefinition, type LoopToolKey } from "./types.js";

interface WorkflowRecord {
  id: string;
  title: string;
  status: string;
  metadata_json: unknown;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readLoopDefinition(metadata: unknown): LoopDefinition {
  const row = readObject(metadata);
  return loopDefinitionSchema.parse(row.loopDefinition);
}

async function insertStep(input: {
  auth: AuthContext;
  runId: string;
  stepName: string;
  idempotencyKey: string;
  status: "started" | "completed" | "failed" | "skipped";
  inputJson: unknown;
  outputJson?: unknown;
  errorJson?: unknown;
  completed?: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO workflow_run_steps
     (id, tenant_id, user_id, workflow_run_id, step_name, idempotency_key, status, input_json, output_json, error_json, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, NOW(), CASE WHEN $11 THEN NOW() ELSE NULL END)
     ON CONFLICT (tenant_id, user_id, idempotency_key) DO UPDATE
       SET status = EXCLUDED.status,
           output_json = EXCLUDED.output_json,
           error_json = EXCLUDED.error_json,
           completed_at = EXCLUDED.completed_at,
           updated_at = NOW()`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepName,
      input.idempotencyKey,
      input.status,
      JSON.stringify(input.inputJson ?? {}),
      JSON.stringify(input.outputJson ?? {}),
      JSON.stringify(input.errorJson ?? {}),
      input.completed === true,
    ]
  );
}

async function loadWorkflow(auth: AuthContext, workflowId: string): Promise<WorkflowRecord> {
  const result = await pool.query<WorkflowRecord>(
    `SELECT id, title, status, metadata_json
     FROM workflows
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND definition_version = $4
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION]
  );
  const workflow = result.rows[0];
  if (!workflow) throw new Error("Loop workflow not found");
  if (workflow.status !== "active") throw new Error(`Loop workflow is ${workflow.status}`);
  return workflow;
}

export async function executeLoopWorkflow(input: {
  auth: AuthContext;
  workflowId: string;
  runMode: "manual" | "scheduled";
  scheduledFor?: string | null;
}): Promise<{ runId: string; status: string; draftRequired: boolean; finalOutput: string }> {
  const workflow = await loadWorkflow(input.auth, input.workflowId);
  const definition = readLoopDefinition(workflow.metadata_json);

  const runId = randomUUID();
  await pool.query(
    `INSERT INTO workflow_runs
     (id, tenant_id, user_id, workflow_id, run_mode, status, scheduled_for, draft_output, connector_action_status, metadata_json)
     VALUES ($1, $2, $3, $4, $5, 'running', $6::timestamptz, NULL, 'not_required', $7::jsonb)`,
    [
      runId,
      input.auth.tenantId,
      input.auth.userId,
      workflow.id,
      input.runMode,
      input.scheduledFor ?? null,
      JSON.stringify({
        loop_definition_version: definition.definitionVersion,
        scheduler_target: definition.schedulerTarget,
      }),
    ]
  );

  const priorOutputs: Array<{ agentId: string; agentName: string; output: unknown }> = [];
  const drafts: Array<{ kind: string; summary: string; payload: Record<string, unknown>; agentId: string }> = [];

  try {
    await insertStep({
      auth: input.auth,
      runId,
      stepName: "ceo_dispatch",
      idempotencyKey: `${runId}:ceo_dispatch`,
      status: "completed",
      inputJson: {
        goal: definition.goal,
        policy: definition.ceo.policy,
        agentCount: definition.agents.length,
      },
      outputJson: {
        message: "CEO accepted loop run and dispatched specialist execution agents.",
        agents: definition.agents.map((agent) => ({ id: agent.id, name: agent.name, task: agent.task })),
      },
      completed: true,
    });

    for (const agent of definition.agents) {
      const [toolKey] = agent.toolPolicy.allowedTools;
      if (!toolKey) throw new Error(`Agent ${agent.name} must have exactly one tool`);
      if (agent.integration !== "internal" && !definition.integrations.includes(agent.integration)) {
        throw new Error(`Agent ${agent.name} requested unavailable integration ${agent.integration}`);
      }

      const idempotencyKey = `${runId}:agent:${agent.id}:${toolKey}`;
      await insertStep({
        auth: input.auth,
        runId,
        stepName: `agent:${agent.id}`,
        idempotencyKey,
        status: "started",
        inputJson: {
          agent,
          toolKey,
          priorOutputCount: priorOutputs.length,
        },
      });

      const result = await runLoopTool(toolKey as LoopToolKey, {
        goal: definition.goal,
        agentName: agent.name,
        agentTask: agent.task,
        priorOutputs,
      });
      priorOutputs.push({ agentId: agent.id, agentName: agent.name, output: result.text });
      if (result.draft) drafts.push({ ...result.draft, agentId: agent.id });

      await insertStep({
        auth: input.auth,
        runId,
        stepName: `agent:${agent.id}`,
        idempotencyKey,
        status: "completed",
        inputJson: {
          agent,
          toolKey,
          priorOutputCount: priorOutputs.length - 1,
        },
        outputJson: {
          text: result.text,
          data: result.data,
          draft: result.draft ?? null,
        },
        completed: true,
      });
    }

    const finalOutput = [
      `Loop run: ${workflow.title}`,
      "",
      ...priorOutputs.map((item) => `## ${item.agentName}\n${String(item.output)}`),
      drafts.length > 0
        ? "\nDraft approval required before any external action runs."
        : "\nNo external draft approval required.",
    ].join("\n\n");
    const draftRequired = drafts.length > 0 && definition.draftPolicy.requireDraftBeforeExternalAction;
    const status = draftRequired ? "waiting_for_approval" : "completed";

    await insertStep({
      auth: input.auth,
      runId,
      stepName: "ceo_finalize",
      idempotencyKey: `${runId}:ceo_finalize`,
      status: "completed",
      inputJson: {
        childOutputCount: priorOutputs.length,
        draftCount: drafts.length,
      },
      outputJson: {
        finalOutput,
        drafts,
        status,
      },
      completed: true,
    });

    await pool.query(
      `UPDATE workflow_runs
       SET status = $5,
           draft_output = $6,
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $7::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND workflow_id = $2
         AND tenant_id = $3
         AND user_id = $4`,
      [
        runId,
        workflow.id,
        input.auth.tenantId,
        input.auth.userId,
        status,
        finalOutput,
        JSON.stringify({
          loop_executor: {
            completedAt: new Date().toISOString(),
            draftRequired,
            drafts,
          },
        }),
      ]
    );

    return { runId, status, draftRequired, finalOutput };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await insertStep({
      auth: input.auth,
      runId,
      stepName: "ceo_failure",
      idempotencyKey: `${runId}:ceo_failure`,
      status: "failed",
      inputJson: {
        workflowId: workflow.id,
        priorOutputCount: priorOutputs.length,
      },
      errorJson: { message },
      completed: true,
    });
    await pool.query(
      `UPDATE workflow_runs
       SET status = 'failed',
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND workflow_id = $2
         AND tenant_id = $3
         AND user_id = $4`,
      [
        runId,
        workflow.id,
        input.auth.tenantId,
        input.auth.userId,
        JSON.stringify({ loop_executor: { failedAt: new Date().toISOString(), error: { message } } }),
      ]
    );
    throw error;
  }
}
