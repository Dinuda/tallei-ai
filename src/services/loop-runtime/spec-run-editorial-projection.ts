import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { compileSpecRunPlan } from "./spec-run-plan.js";
import { resolveBuildContract } from "./definition-hydration.js";
import { getSpecRunProjection } from "./spec-runner.js";
import {
  buildOperatorViewFromInteraction,
  loadPendingInteractionForRun,
  mapInteractionKindForUi,
} from "./spec-run-interactions.js";
import { projectOutputWithBoundary } from "./boundary-store.js";

type StepRow = {
  id: string;
  step_index: number;
  agent_id: string;
  agent_snapshot: unknown;
  attempt: number;
  status: string;
  input_json: unknown;
  output_json: unknown;
  error_json: unknown;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  boundary_protocol_version?: string | null;
  boundary_raw_output_json?: unknown;
  boundary_structured_output_json?: unknown;
  boundary_normalized_output_json?: unknown;
  boundary_normalized_handoff_json?: unknown;
  boundary_goal_eval_json?: unknown;
  boundary_router_decision?: string | null;
  boundary_legacy_output_json?: unknown;
};

type InteractionRow = {
  id: string;
  step_attempt_id: string;
  interaction_kind: string;
  status: string;
  question: string;
  payload_json: unknown;
  decision_json: unknown;
  created_at: string | Date;
  completed_at: string | Date | null;
};

type ArtifactRow = {
  id: string;
  step_attempt_id: string | null;
  artifact_key: string;
  version: number;
  kind: string;
  body: string;
  data_json: unknown;
  created_at: string | Date;
  invalidated_at: string | Date | null;
};

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

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

function toolDisplayName(toolKey: string): string {
  if (toolKey === "getTriggerPayload") return "Trigger Payload";
  if (toolKey === "searchMemory") return "Memory Search";
  if (toolKey === "searchWeb") return "Web Search";
  if (toolKey === "finalizeRun") return "Complete Run";
  if (toolKey.startsWith("search_")) {
    const toolkit = toolKey.slice("search_".length).replace(/_/g, " ");
    return `${titleCase(toolkit)} Search`;
  }
  if (toolKey.startsWith("action_")) {
    const parts = toolKey.split("_");
    return humanizeActionSlug(parts.slice(2).join("_"));
  }
  return titleCase(toolKey);
}

function mapStepStatus(status: string, stepAttemptId: string, pendingInteraction: { step_attempt_id: string } | null): string {
  if (status === "waiting_for_interaction") return "waiting_for_interaction";
  if (pendingInteraction?.step_attempt_id === stepAttemptId && status !== "failed" && status !== "cancelled") {
    return "waiting_for_interaction";
  }
  return status;
}

function stepOutputText(outputJson: unknown): string {
  const output = asRecord(outputJson);
  const rawText = typeof output.text === "string" ? output.text.trim() : "";
  if (rawText.startsWith("{") || rawText.startsWith("[")) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const merged = { ...asRecord(output.data), ...parsed as Record<string, unknown> };
        const fromMerged = formatRecordOutput(merged);
        if (fromMerged) return fromMerged;
      }
    } catch {
      // Fall through to plain-text handling.
    }
  }
  if (rawText && !rawText.startsWith("{") && !rawText.startsWith("[")) {
    return rawText;
  }
  return formatRecordOutput(asRecord(output.data));
}

function formatRecordOutput(data: Record<string, unknown>): string {
  if (data.approved === true && typeof data.interactionKind === "string") {
    const extraKeys = Object.keys(data).filter((key) => !["approved", "interactionKind", "ok", "value"].includes(key));
    if (extraKeys.length === 0) return "";
  }
  for (const field of ["text", "summary", "body", "rationale", "agentOutput", "message", "reply", "draft", "analysis", "findings", "recommendedTemplate", "customerHistory"]) {
    const value = data[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const priority = typeof data.priority === "string" ? data.priority.trim() : "";
  const rationale = typeof data.rationale === "string" ? data.rationale.trim() : "";
  if (priority) return rationale ? `Priority: ${priority}\n\n${rationale}` : `Priority: ${priority}`;
  if (data.ok === true && data.output) return "Connector action completed successfully.";
  return "";
}

export async function getSpecRunEditorialProjection(auth: AuthContext, runId: string) {
  const specRun = await getSpecRunProjection(auth, runId);

  const [stepsResult, interactionsResult, artifactsResult, eventsResult, pendingInteraction] = await Promise.all([
    pool.query<StepRow>(
      `SELECT sa.id, sa.step_index, sa.agent_id, sa.agent_snapshot, sa.attempt, sa.status, sa.input_json, sa.output_json, sa.error_json,
              sa.created_at, sa.started_at, sa.finished_at,
              b.protocol_version AS boundary_protocol_version,
              b.raw_output_json AS boundary_raw_output_json,
              b.structured_output_json AS boundary_structured_output_json,
              b.normalized_output_json AS boundary_normalized_output_json,
              b.normalized_handoff_json AS boundary_normalized_handoff_json,
              b.goal_eval_json AS boundary_goal_eval_json,
              b.router_decision AS boundary_router_decision,
              b.legacy_output_json AS boundary_legacy_output_json
       FROM loop_engine_step_attempts sa
       LEFT JOIN loop_engine_boundaries b ON b.step_attempt_id = sa.id
       WHERE sa.run_id = $1 AND sa.tenant_id = $2 AND sa.user_id = $3
       ORDER BY sa.step_index ASC, sa.attempt ASC`,
      [runId, auth.tenantId, auth.userId],
    ),
    pool.query<InteractionRow>(
      `SELECT id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json,
              created_at, completed_at
       FROM loop_engine_interactions
       WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3
       ORDER BY created_at ASC`,
      [runId, auth.tenantId, auth.userId],
    ),
    pool.query<ArtifactRow>(
      `SELECT id, step_attempt_id, artifact_key, version, kind, body, data_json, created_at, invalidated_at
       FROM loop_engine_artifacts
       WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3
       ORDER BY created_at ASC`,
      [runId, auth.tenantId, auth.userId],
    ),
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
    loadPendingInteractionForRun(auth, runId),
  ]);

  const planAgentIds = new Set(
    compileSpecRunPlan(specRun.loopDefinition).agents.map((agent) => agent.id),
  );

  const steps = stepsResult.rows
    .filter((row) => planAgentIds.has(row.agent_id))
    .map((row) => {
    const projectedOutput = projectOutputWithBoundary({
      outputJson: row.output_json,
      boundary: {
        protocol_version: row.boundary_protocol_version,
        raw_output_json: row.boundary_raw_output_json,
        structured_output_json: row.boundary_structured_output_json,
        normalized_output_json: row.boundary_normalized_output_json,
        normalized_handoff_json: row.boundary_normalized_handoff_json,
        goal_eval_json: row.boundary_goal_eval_json,
        router_decision: row.boundary_router_decision,
        legacy_output_json: row.boundary_legacy_output_json,
      },
    });
    const snapshot = asRecord(row.agent_snapshot);
    const personaRaw = asRecord(snapshot.persona);
    return {
      id: row.id,
      step_index: row.step_index,
      agent_id: row.agent_id,
      agent_snapshot: {
        id: typeof snapshot.id === "string" ? snapshot.id : row.agent_id,
        name: typeof snapshot.name === "string" ? snapshot.name : toolDisplayName(row.agent_id),
        task: typeof snapshot.task === "string" ? snapshot.task : "",
        tools: Array.isArray(snapshot.tools) ? snapshot.tools : [],
        inputContract: asRecord(snapshot.inputContract),
        outputContract: asRecord(snapshot.outputContract),
        handoffBindings: Array.isArray(snapshot.handoffBindings) ? snapshot.handoffBindings : [],
        doneCriteria: Array.isArray(snapshot.doneCriteria) ? snapshot.doneCriteria : [],
        gate: asRecord(snapshot.gate),
        artifactRole: typeof snapshot.artifactRole === "string" ? snapshot.artifactRole : undefined,
        renderer: typeof snapshot.renderer === "string" ? snapshot.renderer : undefined,
        outputArtifactId: typeof snapshot.outputArtifactId === "string" ? snapshot.outputArtifactId : undefined,
        outputArtifactKind: typeof snapshot.outputArtifactKind === "string" ? snapshot.outputArtifactKind : undefined,
        ...(typeof personaRaw.displayName === "string" ? {
          persona: {
            displayName: personaRaw.displayName,
            roleKey: personaRaw.roleKey,
            roleLabel: typeof personaRaw.roleLabel === "string" ? personaRaw.roleLabel : "",
            avatarSeed: typeof personaRaw.avatarSeed === "string" ? personaRaw.avatarSeed : "",
            avatarUrl: typeof personaRaw.avatarUrl === "string" ? personaRaw.avatarUrl : "",
          },
        } : {}),
      },
      attempt: row.attempt,
      status: mapStepStatus(row.status, row.id, pendingInteraction),
      created_at: iso(row.created_at) ?? specRun.createdAt,
      started_at: iso(row.started_at),
      finished_at: iso(row.finished_at),
      input_json: asRecord(row.input_json),
      output_json: {
        text: stepOutputText(projectedOutput),
        data: asRecord(asRecord(projectedOutput).data),
      },
      error_json: asRecord(row.error_json),
    };
  });

  const interactions = interactionsResult.rows.map((row) => ({
    id: row.id,
    step_attempt_id: row.step_attempt_id,
    interaction_kind: mapInteractionKindForUi({
      ...row,
      decision_json: row.decision_json,
      run_id: runId,
    }),
    status: row.status,
    question: row.question,
    payload_json: asRecord(row.payload_json),
    decision_json: asRecord(row.decision_json),
    created_at: iso(row.created_at) ?? specRun.createdAt,
    completed_at: iso(row.completed_at),
  }));

  const artifacts = artifactsResult.rows
    .filter((row) => !row.invalidated_at)
    .map((row) => ({
      id: row.id,
      step_attempt_id: row.step_attempt_id,
      artifact_key: row.artifact_key,
      version: row.version,
      kind: row.kind,
      body: row.body,
      created_at: iso(row.created_at) ?? specRun.createdAt,
      data_json: asRecord(row.data_json),
      invalidated_at: iso(row.invalidated_at),
    }));

  const pendingStep = pendingInteraction
    ? steps.find((step) => step.id === pendingInteraction.step_attempt_id)
    : null;
  const operatorView = pendingInteraction
    ? buildOperatorViewFromInteraction(pendingInteraction, {
      name: pendingStep?.agent_snapshot?.name,
    })
    : null;

  const currentStepIndex = steps.findIndex((step) =>
    step.status === "running" || step.status === "waiting_for_interaction");

  const buildContract = resolveBuildContract(specRun.loopDefinition);
  const specId = specRun.loopDefinition.builderMeta?.specId ?? null;
  const agents = (specRun.loopDefinition.agentGraph?.children ?? []).map((agent) => ({
    id: agent.id,
    name: agent.name,
    goal: agent.goal ?? agent.task,
    tools: agent.tools ?? [],
    persona: agent.persona,
    gate: agent.gate,
    outputContract: agent.outputContract,
    artifactRole: agent.artifactRole,
    guardrails: agent.guardrails ?? [],
    doneCriteria: agent.doneCriteria ?? [],
    failureModes: agent.failureModes ?? [],
  }));

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
    current_step_index: currentStepIndex >= 0 ? currentStepIndex : Math.max(0, steps.length - 1),
    spec: {
      version: specRun.loopDefinition.definitionVersion,
      title: specRun.workflowTitle,
      goal: specRun.loopDefinition.goal,
      schedule: specRun.loopDefinition.schedule,
      triggerSource: specRun.triggerSource,
      triggerLabel: specRun.triggerLabel,
      builderSessionId: specRun.builderSessionId,
      buildContract,
      specId,
      agents,
      artifacts: [],
    },
    definition: {
      ...specRun.loopDefinition,
      agentGraph: {
        ...specRun.loopDefinition.agentGraph,
        children: specRun.loopDefinition.agentGraph.children.map((child) => ({
          ...child,
          renderer: child.outputContract?.renderer,
        })),
      },
    },
    context: {
      engine: "loop_executor_v2",
      trigger: {
        source: specRun.triggerSource,
        label: specRun.triggerLabel,
      },
      summary: specRun.summary,
      builderSessionId: specRun.builderSessionId,
    },
    steps,
    interactions,
    artifacts,
    events: eventsResult.rows.map((row) => ({
      id: row.id,
      created_at: iso(row.created_at) ?? specRun.createdAt,
      event_type: row.event_type,
      step_attempt_id: row.step_attempt_id,
      payload_json: asRecord(row.payload_json),
    })),
    operatorView,
  };
}
