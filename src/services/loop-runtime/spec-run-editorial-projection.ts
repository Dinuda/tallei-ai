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

function slugifyAgentId(name: string, index: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return slug || `agent_${index}`;
}

function inferAgentToolRefs(agent: { name?: string; goal?: string }): Array<{ ref: string }> {
  const source = `${agent.name ?? ""} ${agent.goal ?? ""}`.toLowerCase();
  if (source.includes("memory") || source.includes("search") || source.includes("recall")) {
    return [{ ref: "internal.memory_search" }];
  }
  if (source.includes("draft") || source.includes("reply") || source.includes("email") || source.includes("gmail")) {
    return [{ ref: "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT" }];
  }
  return [{ ref: "internal.llm_only" }];
}

function partToolName(part: { type?: string }): string | null {
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice("tool-".length);
  }
  return null;
}

function partState(part: { state?: string }): string | null {
  return typeof part.state === "string" ? part.state : null;
}

function inferActiveAgentIndex(messages: UIMessage[], runStatus: string, agentCount: number): number {
  if (agentCount === 0) return 0;
  if (runStatus === "succeeded") return agentCount;

  let hasAssistantOutput = false;
  let sawSearchMemory = false;
  let sawWriteAction = false;
  let pendingApproval = false;
  let sawFinalize = false;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "text" && "text" in part && String(part.text ?? "").trim()) {
        hasAssistantOutput = true;
      }
      const tool = partToolName(part as { type?: string });
      const state = partState(part as { state?: string });
      if (!tool) continue;
      if (tool === "finalizeRun" && state === "output-available") sawFinalize = true;
      if (tool === "searchMemory" && state === "output-available") sawSearchMemory = true;
      if (tool.startsWith("action_") && state === "output-available") sawWriteAction = true;
      if (state === "approval-requested" || state === "approval-responded") pendingApproval = true;
    }
  }

  if (sawFinalize) return agentCount;
  if (pendingApproval || runStatus === "waiting_for_approval") {
    return Math.min(agentCount, Math.max(1, agentCount - 1));
  }
  if (sawWriteAction) return Math.min(agentCount, Math.max(1, agentCount - 1));
  if (sawSearchMemory || hasAssistantOutput) return Math.min(agentCount, 1);
  return 0;
}

function mapAgentStepStatus(index: number, activeIndex: number, runStatus: string): string {
  if (runStatus === "failed" || runStatus === "cancelled") {
    if (index < activeIndex) return "succeeded";
    if (index === activeIndex) return "failed";
    return "queued";
  }
  if (index < activeIndex) return "succeeded";
  if (index === activeIndex) {
    if (runStatus === "waiting_for_approval") return "waiting_for_gate";
    if (runStatus === "running" || runStatus === "queued") return "running";
    if (runStatus === "succeeded") return "succeeded";
    return "running";
  }
  return "queued";
}

function buildSpecAgentSteps(input: {
  runId: string;
  spec: RunnableSpec;
  runStatus: string;
  messages: UIMessage[];
  outputText: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}) {
  const agents = input.spec.noSlopSpec.specJson.agents;
  if (agents.length === 0) {
    return [buildLegacySpecRunnerStep(input)];
  }

  const activeIndex = inferActiveAgentIndex(input.messages, input.runStatus, agents.length);
  return agents.map((agent, index) => {
    const agentId = slugifyAgentId(agent.name, index);
    const status = mapAgentStepStatus(index, activeIndex, input.runStatus);
    const isLast = index === agents.length - 1;
    return {
      id: `${input.runId}:${agentId}`,
      step_index: index,
      agent_id: agentId,
      agent_snapshot: {
        id: agentId,
        name: agent.name,
        task: agent.goal,
        tools: inferAgentToolRefs(agent),
      },
      attempt: 1,
      status: mapSpecStepStatus(status === "waiting_for_gate" ? "waiting_for_approval" : status),
      created_at: input.createdAt,
      started_at: index <= activeIndex ? input.startedAt : null,
      finished_at: index < activeIndex || (input.runStatus === "succeeded" && isLast)
        ? input.finishedAt
        : null,
      output_json: {
        text: isLast ? input.outputText : "",
        data: { engine: "loop_spec_v1", agentIndex: index },
      },
      error_json: index === activeIndex && input.error ? { message: input.error } : {},
    };
  });
}

function buildLegacySpecRunnerStep(input: {
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
  const steps = buildSpecAgentSteps({
    runId: specRun.id,
    spec: specRun.runnableSpec,
    runStatus: specRun.status,
    messages,
    outputText,
    error: specRun.error,
    createdAt: specRun.createdAt,
    startedAt: specRun.startedAt,
    finishedAt: specRun.finishedAt,
  });
  const specAgents = specRun.runnableSpec.noSlopSpec.specJson.agents;
  const finalStepId = steps[steps.length - 1]?.id ?? `${specRun.id}:spec-runner`;
  const finalArtifact = buildFinalArtifact({
    runId: specRun.id,
    stepId: finalStepId,
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
    current_step_index: steps.findIndex((step) => step.status === "running" || step.status === "waiting_for_interaction") ?? 0,
    definition: {
      goal: specRun.runnableSpec.goal,
      agentGraph: {
        parent: {
          name: "Tallei Orchestrator",
          task: "Coordinates agents for this loop run.",
        },
        children: specAgents.length > 0
          ? specAgents.map((agent, index) => ({
              id: slugifyAgentId(agent.name, index),
              name: agent.name,
              task: agent.goal,
              tools: inferAgentToolRefs(agent),
            }))
          : [{
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
    steps,
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
