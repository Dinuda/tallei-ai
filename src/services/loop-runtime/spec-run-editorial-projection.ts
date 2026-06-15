import type { UIMessage } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { listLoopRunMessages } from "./run-messages.js";
import { getSpecRunProjection } from "./spec-runner.js";
import type { RunnableSpec } from "./spec-run-types.js";

function extractAssistantText(messages: UIMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) chunks.push(part.text.trim());
    }
  }
  return chunks.join("\n\n");
}

function mapSpecStepStatus(runStatus: string): string {
  if (runStatus === "waiting_for_approval") return "waiting_for_interaction";
  if (runStatus === "queued") return "queued";
  if (runStatus === "running") return "running";
  if (runStatus === "failed") return "failed";
  if (runStatus === "cancelled") return "cancelled";
  if (runStatus === "succeeded") return "succeeded";
  return runStatus;
}

function buildSpecRunnerStep(input: {
  runId: string;
  spec: RunnableSpec;
  runStatus: string;
  outputText: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}) {
  const stepId = `${input.runId}:spec-runner`;
  return {
    id: stepId,
    step_index: 0,
    agent_id: "spec_runner",
    agent_snapshot: {
      id: "spec_runner",
      name: "Loop runner",
      task: input.spec.goal,
    },
    attempt: 1,
    status: mapSpecStepStatus(input.runStatus),
    created_at: input.createdAt,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    output_json: {
      text: input.outputText,
      data: { engine: "loop_spec_v1" },
    },
    error_json: input.error ? { message: input.error } : {},
  };
}

function buildFinalArtifact(input: {
  runId: string;
  stepId: string;
  body: string;
  createdAt: string;
}) {
  if (!input.body.trim()) return null;
  return {
    id: `${input.runId}:final-result`,
    step_attempt_id: input.stepId,
    artifact_key: "final.result",
    version: 1,
    kind: "structured_output",
    body: input.body,
    created_at: input.createdAt,
    data_json: {
      artifactEnvelope: {
        visibility: "operator" as const,
        renderer: "markdown",
      },
    },
    invalidated_at: null,
  };
}

export async function getSpecRunEditorialProjection(auth: AuthContext, runId: string) {
  const specRun = await getSpecRunProjection(auth, runId);
  const [messages, eventsResult] = await Promise.all([
    listLoopRunMessages(auth, runId),
    pool.query<{
      id: string;
      created_at: string | Date;
      event_type: string;
      step_attempt_id: string | null;
      payload_json: unknown;
    }>(
      `SELECT id, created_at, event_type, step_attempt_id, payload_json
       FROM loop_engine_events
       WHERE run_id = $1
       ORDER BY created_at ASC, id ASC`,
      [runId],
    ),
  ]);

  const assistantText = extractAssistantText(messages);
  const outputText = specRun.summary?.trim() || assistantText;
  const step = buildSpecRunnerStep({
    runId: specRun.id,
    spec: specRun.runnableSpec,
    runStatus: specRun.status,
    outputText,
    error: specRun.error,
    createdAt: specRun.createdAt,
    startedAt: specRun.startedAt,
    finishedAt: specRun.finishedAt,
  });
  const finalArtifact = buildFinalArtifact({
    runId: specRun.id,
    stepId: step.id,
    body: outputText,
    createdAt: specRun.finishedAt ?? specRun.updatedAt,
  });

  return {
    id: specRun.id,
    workflow_id: specRun.workflowId,
    workflow_title: specRun.workflowTitle,
    status: specRun.status === "waiting_for_approval" ? "waiting_for_interaction" : specRun.status,
    error_json: specRun.error ? { message: specRun.error } : {},
    created_at: specRun.createdAt,
    updated_at: specRun.updatedAt,
    started_at: specRun.startedAt,
    finished_at: specRun.finishedAt,
    current_step_index: specRun.status === "succeeded" || specRun.status === "failed" ? 0 : 0,
    definition: {
      goal: specRun.runnableSpec.goal,
      agentGraph: {
        parent: {
          name: "Tallei Orchestrator",
          task: "Coordinates this loop run.",
        },
        children: [{
          id: "spec_runner",
          name: "Loop runner",
          task: specRun.runnableSpec.goal,
        }],
      },
    },
    context: {
      engine: "loop_spec_v1",
      trigger: {
        source: specRun.triggerSource,
        label: specRun.triggerLabel,
      },
      summary: specRun.summary,
      builderSessionId: specRun.builderSessionId,
    },
    steps: [step],
    interactions: [],
    artifacts: finalArtifact ? [finalArtifact] : [],
    events: eventsResult.rows.map((row) => ({
      id: row.id,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      event_type: row.event_type,
      step_attempt_id: row.step_attempt_id,
      payload_json: row.payload_json && typeof row.payload_json === "object" && !Array.isArray(row.payload_json)
        ? row.payload_json as Record<string, unknown>
        : {},
    })),
    operatorView: null,
  };
}
