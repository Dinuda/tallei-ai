import { randomUUID } from "crypto";
import { generateText, hasToolCall, stepCountIs, streamText, type UIMessageStreamWriter } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import {
  contractUsesJson,
  stripToSchema,
  validateContractData,
  type DataContract,
} from "../loop-engine/data-contract.js";
import type { InputSurface } from "../loop-engine/input-surfaces.js";
import { loopBuilderOpenAiModel, loopBuilderStreamProviderOptions } from "../loop-builder/openai-chat.js";
import { resolveLoopChatLanguageModel } from "../llm/loop-chat-client.js";
import { buildRunSeedMessage, type RunContext } from "./build-run-context.js";
import { enrichResolvedHandoffValue } from "./spec-run-handoff-enrichment.js";
import { SpecRunInteractionRequiredError } from "./spec-run-agent-errors.js";
import { emitRunEvent } from "./spec-run-agent-events.js";
import { buildAgentTools } from "./spec-run-agent-tools.js";
import { compileSpecRunPlan, type CompiledSpecRunPlan, type RunPlanAgent } from "./spec-run-plan.js";
import { hydrateDefinitionForExecution } from "./definition-hydration.js";
import { dicebearDylanUrl } from "../loop-builder/agent-personas.js";
import { buildSpecRunSystemPrompt } from "./spec-run-prompt.js";
import { configuredAgentGateRequired } from "./spec-run-gate-policy.js";
import { evaluateAgentHandoff } from "./spec-run-handoff-eval.js";
import {
  buildBoundaryEnvelope,
  normalizedHandoffFromStepOutput,
  projectStepOutputFromBoundary,
  readBoundaryEnvelope,
  routeBoundary,
  type AgentBoundaryEnvelope,
  type BoundaryRouterDecision,
} from "./runner-boundary.js";
import { persistStepBoundary, projectOutputWithBoundary } from "./boundary-store.js";
import {
  createSpecRunGateInteraction,
} from "./spec-run-interaction-writer.js";
import type { SpecRunDefinition } from "./spec-run-types.js";

export { SpecRunInteractionRequiredError } from "./spec-run-agent-errors.js";

type AgentStreamChunk = Parameters<UIMessageStreamWriter["write"]>[0];

type AgentStepRow = {
  id: string;
  step_index: number;
  attempt: number;
  agent_id: string;
  agent_snapshot: unknown;
  status: string;
  input_json: unknown;
  output_json: unknown;
  error_json: unknown;
};

type AgentStepQueryRow = AgentStepRow & {
  boundary_protocol_version?: string | null;
  boundary_raw_output_json?: unknown;
  boundary_structured_output_json?: unknown;
  boundary_normalized_output_json?: unknown;
  boundary_normalized_handoff_json?: unknown;
  boundary_goal_eval_json?: unknown;
  boundary_router_decision?: string | null;
};

type PriorAgentOutput = {
  agentId: string;
  agentName: string;
  output: unknown;
};

export type ResolvedHandoff = {
  value: Record<string, unknown>;
  resolvedBindings: Array<{
    targetPath: string;
    source: unknown;
    resolved: boolean;
    required: boolean;
  }>;
  missingRequired: string[];
};

type ExecuteAgenticSpecRunInput = {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  spec: SpecRunDefinition;
  workflowTitle: string;
  runContext: RunContext;
  writer?: UIMessageStreamWriter;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isTextStreamChunk(chunk: AgentStreamChunk): boolean {
  return chunk.type === "text-start" || chunk.type === "text-delta" || chunk.type === "text-end";
}

function isReasoningStreamChunk(chunk: AgentStreamChunk): boolean {
  return chunk.type.startsWith("reasoning-");
}

function isSuppressedAgentStreamChunk(chunk: AgentStreamChunk): boolean {
  return isTextStreamChunk(chunk) || isReasoningStreamChunk(chunk);
}

export function suppressAgentTextChunks(stream: ReadableStream<AgentStreamChunk>): ReadableStream<AgentStreamChunk> {
  return new ReadableStream<AgentStreamChunk>({
    async start(controller) {
      try {
        for await (const chunk of stream as AsyncIterable<AgentStreamChunk>) {
          if (isSuppressedAgentStreamChunk(chunk)) continue;
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function jsonPointerSegments(path: string): string[] {
  const normalized = path.trim() || "/";
  if (normalized === "/") return [];
  return normalized
    .replace(/^#/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of jsonPointerSegments(path)) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[segment];
    } else if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else {
      return undefined;
    }
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = jsonPointerSegments(path);
  if (segments.length === 0) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(target, value as Record<string, unknown>);
    }
    return;
  }
  let current: Record<string, unknown> = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function stableConfigForRun(input: {
  spec: SpecRunDefinition;
  workflowTitle: string;
  runContext: RunContext;
}): Record<string, unknown> {
  return {
    workflow: {
      title: input.workflowTitle,
      goal: input.spec.goal,
    },
    schedule: input.spec.schedule,
    trigger: input.runContext.trigger,
    ticket: input.runContext.ticket ?? null,
    customer: input.runContext.customer ?? null,
  };
}

function mapAgentStepRow(row: AgentStepQueryRow): AgentStepRow {
  return {
    id: row.id,
    step_index: row.step_index,
    attempt: row.attempt,
    agent_id: row.agent_id,
    agent_snapshot: row.agent_snapshot,
    status: row.status,
    input_json: row.input_json,
    output_json: projectOutputWithBoundary({
      outputJson: row.output_json,
      boundary: {
        protocol_version: row.boundary_protocol_version,
        raw_output_json: row.boundary_raw_output_json,
        structured_output_json: row.boundary_structured_output_json,
        normalized_output_json: row.boundary_normalized_output_json,
        normalized_handoff_json: row.boundary_normalized_handoff_json,
        goal_eval_json: row.boundary_goal_eval_json,
        router_decision: row.boundary_router_decision,
      },
    }),
    error_json: row.error_json,
  };
}

function structuredOutputFromStep(step: AgentStepRow): unknown {
  const envelope = readBoundaryEnvelope(step.output_json);
  if (envelope) return envelope.normalizedHandoff;
  const output = asRecord(step.output_json);
  const data = asRecord(output.data);
  if ("structuredOutput" in data) return data.structuredOutput;
  if ("data" in data) return data.data;
  if (Object.keys(data).length > 0) return data;
  return output;
}

function hasPendingInteraction(input: { auth: AuthContext; runId: string }): Promise<boolean> {
  return pool.query<{ id: string }>(
    `SELECT id
     FROM loop_engine_interactions
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'pending'
     LIMIT 1`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  ).then((result) => result.rows.length > 0);
}

async function markRunStatus(input: {
  runId: string;
  status: "queued" | "running" | "waiting_for_interaction" | "succeeded" | "failed" | "cancelled";
  summary?: string;
  error?: string;
  currentStepIndex?: number | null;
}): Promise<void> {
  const contextPatch = input.summary ? { summary: input.summary } : {};
  const errorPatch = input.error ? { message: input.error } : null;
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = $2,
         context_json = context_json || $3::jsonb,
         error_json = CASE WHEN $4::jsonb IS NULL THEN error_json ELSE $4::jsonb END,
         current_step_index = COALESCE($5, current_step_index),
         started_at = COALESCE(started_at, NOW()),
         finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN NOW() ELSE finished_at END,
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.runId,
      input.status,
      JSON.stringify(contextPatch),
      errorPatch ? JSON.stringify(errorPatch) : null,
      input.currentStepIndex ?? null,
    ],
  );
}

async function ensureAgentSteps(input: {
  auth: AuthContext;
  runId: string;
  plan: CompiledSpecRunPlan;
}): Promise<AgentStepRow[]> {
  for (const agent of input.plan.agents) {
    await pool.query(
      `INSERT INTO loop_engine_step_attempts
         (id, tenant_id, user_id, run_id, step_index, agent_id, agent_snapshot, attempt, status, input_json, output_json, error_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, 'queued', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (run_id, step_index, attempt) DO NOTHING`,
      [
        randomUUID(),
        input.auth.tenantId,
        input.auth.userId,
        input.runId,
        agent.index,
        agent.id,
        JSON.stringify({
          id: agent.id,
          name: agent.name,
          task: agent.goal,
          tools: agent.toolRefs.map((ref) => ({ ref })),
          inputContract: agent.inputContract,
          outputContract: agent.outputContract,
          handoffBindings: agent.handoffBindings,
          doneCriteria: agent.doneCriteria,
          gate: agent.gate,
          renderer: agent.outputContract.renderer,
          outputArtifactId: agent.outputArtifactId,
          outputArtifactKind: agent.outputArtifactKind,
          ...(agent.persona ? {
            persona: {
              displayName: agent.persona.displayName,
              roleKey: agent.persona.roleKey,
              roleLabel: agent.persona.roleLabel,
              avatarSeed: agent.persona.avatarSeed,
              avatarUrl: dicebearDylanUrl(agent.persona.avatarSeed),
            },
          } : {}),
        }),
      ],
    );
  }

  const result = await pool.query<AgentStepQueryRow>(
    `SELECT sa.id, sa.step_index, sa.attempt, sa.agent_id, sa.agent_snapshot, sa.status, sa.input_json, sa.output_json, sa.error_json,
            b.protocol_version AS boundary_protocol_version,
            b.raw_output_json AS boundary_raw_output_json,
            b.structured_output_json AS boundary_structured_output_json,
            b.normalized_output_json AS boundary_normalized_output_json,
            b.normalized_handoff_json AS boundary_normalized_handoff_json,
            b.goal_eval_json AS boundary_goal_eval_json,
            b.router_decision AS boundary_router_decision
     FROM loop_engine_step_attempts sa
     LEFT JOIN loop_engine_boundaries b ON b.step_attempt_id = sa.id
     WHERE sa.run_id = $1 AND sa.tenant_id = $2 AND sa.user_id = $3
     ORDER BY sa.step_index ASC, sa.attempt ASC`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
  const agentIds = new Set(input.plan.agents.map((agent) => agent.id));
  return result.rows.map(mapAgentStepRow).filter((row) => agentIds.has(row.agent_id));
}

export async function materializeSpecRunAgentSteps(input: {
  auth: AuthContext;
  runId: string;
  spec: SpecRunDefinition;
  workflowId?: string;
}): Promise<AgentStepRow[]> {
  let workflowId = input.workflowId;
  if (!workflowId) {
    const row = await pool.query<{ workflow_id: string }>(
      `SELECT workflow_id FROM loop_engine_runs WHERE id = $1 LIMIT 1`,
      [input.runId],
    );
    workflowId = row.rows[0]?.workflow_id;
  }
  const spec = workflowId
    ? await hydrateDefinitionForExecution(input.auth, workflowId, input.spec)
    : input.spec;
  const plan = compileSpecRunPlan(spec);
  if (plan.agents.length === 0) {
    throw new Error("Runnable spec has no approved agents to execute.");
  }
  return ensureAgentSteps({
    auth: input.auth,
    runId: input.runId,
    plan,
  });
}

function latestStepForIndex(steps: AgentStepRow[], stepIndex: number): AgentStepRow | undefined {
  return steps
    .filter((row) => row.step_index === stepIndex)
    .sort((left, right) => right.attempt - left.attempt)[0];
}

function latestStepForAgent(steps: AgentStepRow[], agent: RunPlanAgent): AgentStepRow {
  const step = latestStepForIndex(steps, agent.index);
  if (!step) throw new Error(`Missing materialized step for agent ${agent.name}`);
  return step;
}

async function loadAgentSteps(input: {
  auth: AuthContext;
  runId: string;
  plan: CompiledSpecRunPlan;
}): Promise<AgentStepRow[]> {
  const result = await pool.query<AgentStepQueryRow>(
    `SELECT sa.id, sa.step_index, sa.attempt, sa.agent_id, sa.agent_snapshot, sa.status, sa.input_json, sa.output_json, sa.error_json,
            b.protocol_version AS boundary_protocol_version,
            b.raw_output_json AS boundary_raw_output_json,
            b.structured_output_json AS boundary_structured_output_json,
            b.normalized_output_json AS boundary_normalized_output_json,
            b.normalized_handoff_json AS boundary_normalized_handoff_json,
            b.goal_eval_json AS boundary_goal_eval_json,
            b.router_decision AS boundary_router_decision
     FROM loop_engine_step_attempts sa
     LEFT JOIN loop_engine_boundaries b ON b.step_attempt_id = sa.id
     WHERE sa.run_id = $1 AND sa.tenant_id = $2 AND sa.user_id = $3
     ORDER BY sa.step_index ASC, sa.attempt ASC`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
  const agentIds = new Set(input.plan.agents.map((agent) => agent.id));
  return result.rows.map(mapAgentStepRow).filter((row) => agentIds.has(row.agent_id));
}

async function loadLatestArtifacts(input: {
  auth: AuthContext;
  runId: string;
}): Promise<Record<string, unknown>> {
  const result = await pool.query<{
    artifact_key: string;
    body: string;
    data_json: unknown;
  }>(
    `SELECT DISTINCT ON (artifact_key) artifact_key, body, data_json
     FROM loop_engine_artifacts
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3 AND invalidated_at IS NULL
     ORDER BY artifact_key, version DESC, created_at DESC`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
  return Object.fromEntries(result.rows.map((row) => [
    row.artifact_key,
    {
      body: row.body,
      ...asRecord(row.data_json),
    },
  ]));
}

async function resolveHandoffForAgent(input: {
  auth: AuthContext;
  runId: string;
  spec: SpecRunDefinition;
  workflowTitle: string;
  runContext: RunContext;
  plan: CompiledSpecRunPlan;
  agent: RunPlanAgent;
  steps: AgentStepRow[];
}): Promise<ResolvedHandoff> {
  const value: Record<string, unknown> = {};
  const resolvedBindings: ResolvedHandoff["resolvedBindings"] = [];
  const missingRequired: string[] = [];
  if (input.agent.handoffBindings.length === 0) {
    return { value, resolvedBindings, missingRequired };
  }

  const outputsByAgent = new Map<string, unknown>();
  const operatorInputs: Record<string, unknown> = {};
  for (const planAgent of input.plan.agents) {
    const step = latestStepForIndex(input.steps, planAgent.index);
    if (step?.status === "succeeded") outputsByAgent.set(planAgent.id, normalizedHandoffFromStepOutput(step.output_json));
    Object.assign(operatorInputs, asRecord(asRecord(step?.input_json).operatorInputs));
  }
  const artifacts = await loadLatestArtifacts(input);
  const stableConfig = stableConfigForRun({ spec: input.spec, workflowTitle: input.workflowTitle, runContext: input.runContext });

  for (const binding of input.agent.handoffBindings) {
    let sourceRoot: unknown;
    if (binding.source.kind === "agent_output") {
      sourceRoot = binding.source.agentId ? outputsByAgent.get(binding.source.agentId) : undefined;
    } else if (binding.source.kind === "operator_input") {
      sourceRoot = binding.source.key ? operatorInputs[binding.source.key] : operatorInputs;
    } else if (binding.source.kind === "stable_config") {
      sourceRoot = binding.source.key ? stableConfig[binding.source.key] : stableConfig;
    } else if (binding.source.kind === "artifact") {
      sourceRoot = binding.source.key ? artifacts[binding.source.key] : artifacts;
    }
    const resolved = readPath(sourceRoot, binding.source.path);
    const ok = isPresent(resolved);
    resolvedBindings.push({
      targetPath: binding.targetPath,
      source: binding.source,
      resolved: ok,
      required: binding.required,
    });
    if (ok) {
      writePath(value, binding.targetPath, resolved);
    } else if (binding.required) {
      missingRequired.push(binding.targetPath);
    }
  }

  if (input.agent.handoffBindings.some((binding) => binding.source.kind === "agent_output")) {
    const enriched = enrichResolvedHandoffValue(input.runContext, value);
    Object.assign(value, enriched);
    for (const entry of resolvedBindings) {
      if (!entry.resolved && isPresent(readPath(value, entry.targetPath))) {
        entry.resolved = true;
        const missingIndex = missingRequired.indexOf(entry.targetPath);
        if (missingIndex >= 0) missingRequired.splice(missingIndex, 1);
      }
    }
  }

  return { value, resolvedBindings, missingRequired };
}

function priorOutputsForAgent(plan: CompiledSpecRunPlan, steps: AgentStepRow[], currentIndex: number): PriorAgentOutput[] {
  return plan.agents
    .filter((agent) => agent.index < currentIndex)
    .flatMap((agent): PriorAgentOutput[] => {
      const step = latestStepForIndex(steps, agent.index);
      if (!step || step.status !== "succeeded") return [];
      return [{
        agentId: agent.id,
        agentName: agent.name,
        output: normalizedHandoffFromStepOutput(step.output_json),
      }];
    });
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output.trim();
  const record = asRecord(output);
  if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  if (typeof record.summary === "string" && record.summary.trim()) return record.summary.trim();
  for (const field of ["body", "rationale", "findings", "analysis", "conclusion", "notes", "message", "reply"]) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const priority = typeof record.priority === "string" ? record.priority.trim() : "";
  const rationale = typeof record.rationale === "string" ? record.rationale.trim() : "";
  if (priority) return rationale ? `Priority: ${priority}\n\n${rationale}` : `Priority: ${priority}`;
  if (record.approved === true && typeof record.interactionKind === "string") return "";
  if (record.ok === true && record.output) return "External action completed successfully.";
  return "";
}

function normalizedRecordForOutput(output: unknown, text?: string): Record<string, unknown> {
  const record = asRecord(output);
  if (Object.keys(record).length > 0) return record;
  const fallbackText = typeof output === "string" && output.trim()
    ? output.trim()
    : text?.trim();
  return fallbackText ? { text: fallbackText } : {};
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStrings(entry, depth + 1));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    key,
    ...collectStrings(entry, depth + 1),
  ]);
}

function isNoActionRequiredOutput(output: unknown): boolean {
  const record = asRecord(output);
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  if (status === "no_action_required" || status === "no_tickets_found" || status === "no_ticket_found") {
    return true;
  }

  const text = collectStrings(output)
    .join("\n")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  if (!text.trim()) return false;
  return /\bno (new )?(support )?tickets? (found|detected)\b/.test(text)
    || /\bno (formal )?support tickets?\b/.test(text)
    || /\bno drafts? (were )?(created|needed|could be created)\b/.test(text)
    || /\bnothing actionable\b/.test(text);
}

/** Only terminal no-op from draft/delivery ends the run; context evidence still hands off downstream. */
function shouldTerminateRunAfterAgent(output: unknown): boolean {
  const record = asRecord(output);
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  return status === "no_action_required";
}

function tryParseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Unwrap common finalizeAgent mistakes before output-contract validation. */
export function normalizeAgentStepOutput(
  output: unknown,
): unknown {
  let candidate = output;

  if (typeof candidate === "string") {
    return tryParseJsonObject(candidate) ?? candidate;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return candidate;
  }

  const record = candidate as Record<string, unknown>;
  if (typeof record.text === "string") {
    const parsed = tryParseJsonObject(record.text);
    if (parsed) candidate = parsed;
  }

  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const next = candidate as Record<string, unknown>;
    if (
      next.output
      && typeof next.output === "object"
      && !Array.isArray(next.output)
      && Object.keys(next).length === 1
    ) {
      candidate = next.output;
    }
  }

  return candidate;
}

function missingAgentOutputError(input: {
  agent: RunPlanAgent;
  finishReason?: string;
  toolCalls?: string[];
  streamError?: unknown;
}): Error {
  if (input.streamError instanceof Error) return input.streamError;
  const toolCalls = input.toolCalls && input.toolCalls.length > 0
    ? input.toolCalls.join(", ")
    : "none";
  const finishReason = input.finishReason ?? "unknown";
  return new Error(
    `${input.agent.name} did not call finalizeAgent and produced no text output. finishReason=${finishReason}; lastStepToolCalls=${toolCalls}`,
  );
}

function coerceOutputToContract(input: {
  contract: DataContract;
  output: unknown;
}): { structuredOutput: unknown; normalizedOutput: Record<string, unknown>; text: string; contractIssues: string[] } {
  const contractIssues: string[] = [];
  if (contractUsesJson(input.contract)) {
    let structuredOutput = normalizeAgentStepOutput(input.output);
    if (typeof structuredOutput === "string") {
      try {
        structuredOutput = JSON.parse(structuredOutput) as unknown;
      } catch {
        contractIssues.push("Agent output contract requires JSON, but finalizeAgent output was not valid JSON.");
      }
    }
    const stripped = stripToSchema(input.contract.schema, structuredOutput);
    const validation = validateContractData(input.contract.schema, stripped);
    if (!validation.valid) contractIssues.push(validation.reason);
    const text = outputText(stripped);
    return {
      structuredOutput: stripped,
      normalizedOutput: normalizedRecordForOutput(stripped, text),
      text,
      contractIssues,
    };
  }
  const structuredOutput = input.output;
  const text = outputText(structuredOutput);
  return {
    structuredOutput,
    normalizedOutput: normalizedRecordForOutput(structuredOutput, text),
    text,
    contractIssues,
  };
}

function textFromStructuredOutput(output: unknown): string {
  if (typeof output === "string") return output;
  const record = asRecord(output);
  for (const field of ["body", "text", "content", "message", "summary", "html"]) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return JSON.stringify(output, null, 2);
}

function artifactPayloadForOutput(input: {
  agent: RunPlanAgent;
  structuredOutput: unknown;
  text: string;
}): { kind: string; body: string; dataJson: Record<string, unknown> } {
  const renderer = input.agent.outputContract.renderer;
  const record = asRecord(input.structuredOutput);
  if (renderer === "canvas.email") {
    const subject = typeof record.subject === "string" && record.subject.trim()
      ? record.subject.trim()
      : "Email draft";
    const bodyText = textFromStructuredOutput(input.structuredOutput);
    const html = typeof record.html === "string" && record.html.trim()
      ? record.html
      : `<html><body><p>${bodyText.replace(/\n/g, "<br/>")}</p></body></html>`;
    return {
      kind: "canvas_email",
      body: html,
      dataJson: {
        renderer,
        renderTarget: renderer,
        outputContract: input.agent.outputContract,
        structuredOutput: input.structuredOutput,
        emailTemplate: {
          design: asRecord(record.design),
          html,
          text: bodyText,
          subject,
          preview: typeof record.preview === "string" ? record.preview : subject,
          source: "spec-run",
        },
        data: input.structuredOutput,
      },
    };
  }
  return {
    kind: renderer === "canvas.preview" ? "preview" : input.agent.outputArtifactKind,
    body: input.text || textFromStructuredOutput(input.structuredOutput),
    dataJson: {
      ...(renderer ? { renderer, renderTarget: renderer } : {}),
      outputContract: input.agent.outputContract,
      structuredOutput: input.structuredOutput,
      data: input.structuredOutput,
    },
  };
}

async function persistAgentOutputArtifact(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  agent: RunPlanAgent;
  structuredOutput: unknown;
  text: string;
}): Promise<void> {
  if (!input.agent.outputContract.renderer && input.agent.outputContract.visibility !== "operator") return;
  const artifact = artifactPayloadForOutput({
    agent: input.agent,
    structuredOutput: input.structuredOutput,
    text: input.text,
  });
  await pool.query(
    `INSERT INTO loop_engine_artifacts
       (id, tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9::jsonb, NOW())
     ON CONFLICT (run_id, artifact_key, version) DO UPDATE
       SET kind = EXCLUDED.kind,
           body = EXCLUDED.body,
           data_json = EXCLUDED.data_json,
           invalidated_at = NULL`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId,
      input.agent.outputArtifactId,
      artifact.kind,
      artifact.body,
      JSON.stringify(artifact.dataJson),
    ],
  );
}

async function completeAgentStep(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  agent: RunPlanAgent;
  boundaryEnvelope: AgentBoundaryEnvelope;
  routerDecision: BoundaryRouterDecision;
  boundaryIssues?: string[];
  text: string;
  stepInput?: Record<string, unknown>;
}): Promise<{ structuredOutput: unknown; text: string }> {
  const deferSuccess = agentNeedsConfiguredGate({
    agent: input.agent,
    stepInput: input.stepInput ?? {},
    structuredOutput: input.boundaryEnvelope.structuredOutput,
  });
  const projectedOutputJson = projectStepOutputFromBoundary({
    envelope: input.boundaryEnvelope,
    text: input.text,
  });
  await persistStepBoundary({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    status: deferSuccess ? "waiting_for_interaction" : "succeeded",
    envelope: input.boundaryEnvelope,
    routerDecision: input.routerDecision,
    boundaryIssues: input.boundaryIssues,
    projectedOutputJson,
  });
  await persistAgentOutputArtifact({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    agent: input.agent,
    structuredOutput: input.boundaryEnvelope.structuredOutput,
    text: input.text,
  });
  return { structuredOutput: input.boundaryEnvelope.structuredOutput, text: input.text };
}

async function failAgentStep(input: {
  auth: AuthContext;
  stepAttemptId: string;
  message: string;
}): Promise<void> {
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'failed',
         error_json = $2::jsonb,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $3 AND user_id = $4`,
    [input.stepAttemptId, JSON.stringify({ message: input.message }), input.auth.tenantId, input.auth.userId],
  );
}

async function requeueAgentStepRetry(input: {
  auth: AuthContext;
  runId: string;
  step: AgentStepRow;
  agent: RunPlanAgent;
  message: string;
}): Promise<AgentStepRow | null> {
  if (input.step.attempt >= 3) return null;
  await failAgentStep({
    auth: input.auth,
    stepAttemptId: input.step.id,
    message: input.message,
  });
  const nextId = randomUUID();
  await pool.query(
    `INSERT INTO loop_engine_step_attempts
       (id, tenant_id, user_id, run_id, step_index, agent_id, agent_snapshot, attempt, status, input_json, output_json, error_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'queued', $9::jsonb, '{}'::jsonb, '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (run_id, step_index, attempt) DO NOTHING`,
    [
      nextId,
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.step.step_index,
      input.step.agent_id,
      JSON.stringify(input.step.agent_snapshot),
      input.step.attempt + 1,
      JSON.stringify({
        ...asRecord(input.step.input_json),
        retry: {
          reason: input.message,
          previousStepAttemptId: input.step.id,
        },
      }),
    ],
  );
  return {
    ...input.step,
    id: nextId,
    attempt: input.step.attempt + 1,
    status: "queued",
    input_json: {
      ...asRecord(input.step.input_json),
      retry: { reason: input.message, previousStepAttemptId: input.step.id },
    },
    output_json: {},
    error_json: {},
  };
}

async function createMissingHandoffInputIfPossible(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  agent: RunPlanAgent;
  missingRequired: string[];
  reason: string;
}): Promise<boolean> {
  const gate = input.agent.gate;
  if (gate?.type !== "input") return false;
  const key = gate.input?.key ?? `${input.agent.id}_missing_handoff`;
  const surface = gate.input?.surface ?? "input.text";
  const interactionId = await createSpecRunGateInteraction({
    gateType: "input",
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    agentId: input.agent.id,
    agentName: input.agent.name,
    stepIndex: input.agent.index,
    surface,
    key,
    label: gate.input?.label ?? "Missing handoff input",
    description: gate.input?.description ?? `${input.reason}\n\nMissing: ${input.missingRequired.join(", ")}`,
  });
  await markStepWaitingForInteraction({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    interactionId,
    eventType: "interaction_requested",
    payload: {
      toolKey: "handoffPreflight",
      surface,
      key,
      missingRequired: input.missingRequired,
    },
  });
  return true;
}

function reviewSurfaceForAgent(agent: RunPlanAgent): InputSurface {
  if (agent.gate?.type === "approval" && agent.gate.approval.surface) {
    return agent.gate.approval.surface;
  }
  if (agent.outputContract.renderer === "canvas.email") return "review.email";
  if (agent.outputContract.renderer === "canvas.preview") return "review.preview";
  return "review.preview";
}

async function markStepWaitingForInteraction(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  interactionId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'waiting_for_interaction', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [input.stepAttemptId, input.auth.tenantId, input.auth.userId],
  );
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'waiting_for_interaction', updated_at = NOW()
     WHERE id = $1`,
    [input.runId],
  );
  await emitRunEvent({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    eventType: input.eventType,
    payload: {
      interactionId: input.interactionId,
      ...input.payload,
    },
  });
}

function agentNeedsConfiguredGate(input: {
  agent: RunPlanAgent;
  stepInput: Record<string, unknown>;
  structuredOutput: unknown;
}): boolean {
  if (!input.agent.gate) return false;
  if (asRecord(input.stepInput.reviewApproval).approved === true) return false;
  if (isNoActionRequiredOutput(input.structuredOutput)) return false;
  return true;
}

async function markAgentStepSucceeded(input: {
  auth: AuthContext;
  stepAttemptId: string;
}): Promise<void> {
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'succeeded',
         finished_at = COALESCE(finished_at, NOW()),
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [input.stepAttemptId, input.auth.tenantId, input.auth.userId],
  );
}

async function createConfiguredGateIfNeeded(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  agent: RunPlanAgent;
  stepInput: Record<string, unknown>;
  structuredOutput: unknown;
  text: string;
  plan?: CompiledSpecRunPlan;
}): Promise<boolean> {
  if (!input.agent.gate) return false;
  const gateType = input.agent.gate.type.trim().toLowerCase();
  // Spec-defined gates are authoritative: builder/compiler decides whether a gate exists.
  if (!configuredAgentGateRequired(gateType)) return false;
  if (asRecord(input.stepInput.reviewApproval).approved === true) return false;
  if (isNoActionRequiredOutput(input.structuredOutput)) return false;

  if (input.agent.gate.type === "input") {
    const key = input.agent.gate.input?.key ?? `${input.agent.id}_input`;
    const surface = input.agent.gate.input?.surface ?? "input.text";
    const interactionId = await createSpecRunGateInteraction({
      gateType: "input",
      auth: input.auth,
      runId: input.runId,
      stepAttemptId: input.stepAttemptId,
      agentId: input.agent.id,
      agentName: input.agent.name,
      stepIndex: input.agent.index,
      surface,
      key,
      label: input.agent.gate.input?.label ?? input.agent.gate.question,
      description: input.agent.gate.input?.description ?? input.agent.gate.question,
    });
    await markStepWaitingForInteraction({
      auth: input.auth,
      runId: input.runId,
      stepAttemptId: input.stepAttemptId,
      interactionId,
      eventType: "interaction_requested",
      payload: { toolKey: "configuredGate", surface, key, gateType: "input" },
    });
    return true;
  }

  const surface = reviewSurfaceForAgent(input.agent);
  const artifactKey = input.agent.gate.approval.artifactKey ?? input.agent.outputArtifactId;
  const artifactData = {
    ...asRecord(input.structuredOutput),
    structuredOutput: input.structuredOutput,
    text: input.text,
    outputContract: input.agent.outputContract,
  };
  const interactionId = await createSpecRunGateInteraction({
    gateType: "review",
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    agentId: input.agent.id,
    agentName: input.agent.name,
    stepIndex: input.agent.index,
    surface,
    artifactKey,
    artifactData,
    rationale: input.agent.gate.question,
    configuredGate: true,
    nextAgentName: input.plan?.agents[input.agent.index + 1]?.name,
  });
  await markStepWaitingForInteraction({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    interactionId,
    eventType: "interaction_requested",
    payload: {
      toolKey: "configuredGate",
      surface,
      artifactKey,
      gateType: "approval",
    },
  });
  return true;
}

function buildAgentPrompt(input: {
  spec: SpecRunDefinition;
  runContext: RunContext;
  plan: CompiledSpecRunPlan;
  agent: RunPlanAgent;
  priorOutputs: PriorAgentOutput[];
  resolvedHandoff: ResolvedHandoff;
  stepInput: Record<string, unknown>;
  availableToolNames: string[];
}): string {
  const pendingRevision = asRecord(input.stepInput.revision);
  const reviewApproval = asRecord(input.stepInput.reviewApproval);
  const reviewWasApproved = Object.keys(reviewApproval).length > 0;
  const gateToolNameSet = new Set<string>(["requestGate"]);
  const gateToolNames = input.availableToolNames.filter((name) => gateToolNameSet.has(name));
  const directToolNames = input.availableToolNames.filter((name) => !gateToolNameSet.has(name));
  const writeActionRefs = input.plan.writeTools
    .filter((toolRef) => input.agent.toolRefs.includes(toolRef.toolRef))
    .map((toolRef) => toolRef.toolRef);
  const readOnlyAgent = writeActionRefs.length === 0;
  return [
    buildRunSeedMessage(input.runContext, input.spec),
    "",
    `Current agent (${input.agent.index + 1}/${input.plan.agents.length}): ${input.agent.name}`,
    `Goal: ${input.agent.goal}`,
    input.agent.guardrails.length > 0 ? `Guardrails:\n${input.agent.guardrails.map((entry) => `- ${entry}`).join("\n")}` : "",
    input.agent.doneCriteria.length > 0 ? `Done criteria:\n${input.agent.doneCriteria.map((entry) => `- ${entry}`).join("\n")}` : "",
    input.agent.failureModes.length > 0 ? `Failure modes:\n${input.agent.failureModes.map((entry) => `- ${entry}`).join("\n")}` : "",
    `Input contract:\n${JSON.stringify(input.agent.inputContract, null, 2)}`,
    `Output contract:\n${JSON.stringify(input.agent.outputContract, null, 2)}`,
    input.agent.handoffBindings.length > 0
      ? `Declared handoff bindings:\n${JSON.stringify(input.agent.handoffBindings, null, 2)}`
      : "",
    input.agent.gate
      ? `Configured gate (runner creates this after finalizeAgent; do not call requestGate for it):\n${JSON.stringify(input.agent.gate, null, 2)}`
      : "",
    `Build-spec tool refs assigned to this agent (authorization identifiers, not callable tool names):\n${input.agent.toolRefs.map((entry) => `- ${entry}`).join("\n")}`,
    `Callable tools available in this invocation:\n${input.availableToolNames.map((entry) => `- ${entry}`).join("\n")}`,
    "Never call build-spec refs directly. Do not call internal.* or composio.* names as tools. For connector reads, use the action_* callable tool listed above. For connector writes/sends, call requestGate with type=approval and approval.actionRef/payload.",
    readOnlyAgent
      ? "This agent has no write actionRefs. It is read-only: do not create labels, drafts, replies, sends, or any other Gmail mutations. If the needed mutation tool is not listed, finalize with the evidence/status instead of inventing a tool name."
      : "",
    directToolNames.some((name) => name.startsWith("action_"))
      ? "Connector action_* tools enforce the declared Composio input schema via Zod. Pass fields at the top level using exact property names (for example thread_id, not threadId). Do not nest fields under payload."
      : "",
    writeActionRefs.length > 0
      ? `Write actionRefs allowed through requestGate type=approval:\n${writeActionRefs.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    input.plan.inputRequirements.length > 0
      ? `Declared operator surfaces:\n${JSON.stringify(input.plan.inputRequirements, null, 2)}`
      : "",
    input.plan.reviewSurfaces.length > 0
      ? `Review surfaces available: ${input.plan.reviewSurfaces.join(", ")}`
      : "",
    input.priorOutputs.length > 0
      ? `Structured handoff context from prior agents:\n${JSON.stringify(input.priorOutputs, null, 2)}`
      : "No prior agent outputs yet.",
    input.agent.handoffBindings.length > 0
      ? `Resolved inputs from declared handoff bindings:\n${JSON.stringify(input.resolvedHandoff, null, 2)}`
      : "",
    Object.keys(pendingRevision).length > 0
      ? `Operator revision feedback for this retry:\n${JSON.stringify(pendingRevision, null, 2)}`
      : "",
    reviewWasApproved
      ? `The operator approved this run's gate. Do not call requestGate again for the same artifact/action. Continue the agent. Before any connector write/send, call requestGate with type=approval and the exact approval.actionRef; the runner will create the required approval gate or execute only if that exact action was already approved. Approval context: ${JSON.stringify(reviewApproval, null, 2)}`
      : "",
    "",
    "Run only this agent.",
    directToolNames.length > 0
      ? `Direct callable tools in this invocation:\n${directToolNames.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    gateToolNames.length > 0
      ? `Operator gate callable tools in this invocation:\n${gateToolNames.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    "NEVER call requestGate type=input for searchMemory queries, IDs you could look up, or any data accessible via a direct tool.",
    input.runContext.ticket && input.agent.handoffBindings.length > 0
      ? "The run seed and resolved handoff already include ticket/customer context when present. Do not call requestGate type=input for subject, body, sender name, sender email, or thread/message IDs — use the handoff and run seed directly."
      : "",
    "requestGate type=input is ONLY for input.* surfaces (input.text, input.markdown, input.file, etc.). requestGate type=approval is for review.* / confirm.send surfaces or connector action approval. Configured gates are created automatically after finalizeAgent — do not call requestGate for them.",
    "Do not narrate tool choices, print JSON, or draft operator-facing content in normal prose before the relevant tool call. Use finalizeAgent for the declared output contract; the runner will create configured artifacts/reviews from outputContract.renderer and gate.",
    gateToolNames.length > 0
      ? "If operator choices are needed, you MUST create them with requestGate. Never write that a review was submitted, approval is pending, or the run is paused unless requestGate has been called."
      : "",
    "When your agent step is complete, call finalizeAgent with structured output. Stop after finalizeAgent; the runtime advances gates, later agents, and final run status.",
  ].filter(Boolean).join("\n");
}

async function runAgent(input: {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  spec: SpecRunDefinition;
  workflowTitle: string;
  runContext: RunContext;
  plan: CompiledSpecRunPlan;
  agent: RunPlanAgent;
  step: AgentStepRow;
  priorOutputs: PriorAgentOutput[];
  resolvedHandoff: ResolvedHandoff;
  writer?: UIMessageStreamWriter;
}): Promise<{ output: unknown }> {
  const finalized: { agentOutput?: unknown } = {};
  const tools = buildAgentTools({
    auth: input.auth,
    workflowId: input.workflowId,
    runId: input.runId,
    spec: input.spec,
    workflowTitle: input.workflowTitle,
    runContext: input.runContext,
    plan: input.plan,
    agent: input.agent,
    stepAttemptId: input.step.id,
    finalized,
    resolvedHandoff: input.resolvedHandoff.value,
  });
  const modelId = loopBuilderOpenAiModel();
  const model = resolveLoopChatLanguageModel(modelId);
  const system = [
    buildSpecRunSystemPrompt(input.spec, input.runContext),
    "",
    "Execution architecture: one model invocation controls exactly one approved spec agent. Mutating external actions are never direct tools; create requestGate type=approval interactions instead. Operator input and approval must be represented with requestGate, not prose.",
  ].join("\n");
  const prompt = buildAgentPrompt({
    spec: input.spec,
    runContext: input.runContext,
    plan: input.plan,
    agent: input.agent,
    priorOutputs: input.priorOutputs,
    resolvedHandoff: input.resolvedHandoff,
    stepInput: asRecord(input.step.input_json),
    availableToolNames: Object.keys(tools),
  });

  if (input.writer) {
    const persona = input.agent.persona
      ? {
          displayName: input.agent.persona.displayName,
          roleKey: input.agent.persona.roleKey,
          roleLabel: input.agent.persona.roleLabel,
          avatarSeed: input.agent.persona.avatarSeed,
          avatarUrl: dicebearDylanUrl(input.agent.persona.avatarSeed),
        }
      : undefined;
    input.writer.write({
      type: "data-agent",
      data: {
        agentId: input.agent.id,
        agentName: input.agent.name,
        stepIndex: input.agent.index,
        totalAgents: input.plan.agents.length,
        task: input.agent.goal,
        phase: "working",
        ...(persona ? { persona } : {}),
      },
    });
    let streamError: unknown;
    const agentStream = streamText({
      model,
      system,
      prompt,
      tools,
      providerOptions: loopBuilderStreamProviderOptions(modelId) as never,
      stopWhen: [hasToolCall("finalizeAgent"), hasToolCall("finalizeRun"), stepCountIs(10)],
      onError: ({ error }) => {
        if (!(error instanceof SpecRunInteractionRequiredError)) {
          streamError = error;
          console.error("Agent stream error:", error);
        }
      },
    });
    input.writer.merge(suppressAgentTextChunks(agentStream.toUIMessageStream({ sendReasoning: true })));
    const [text, finishReason, toolCalls] = await Promise.all([
      agentStream.text,
      Promise.resolve(agentStream.finishReason).catch(() => undefined),
      Promise.resolve(agentStream.toolCalls).catch(() => []),
    ]);
    if (finalized.agentOutput !== undefined) return { output: finalized.agentOutput };
    const trimmed = text.trim();
    if (trimmed) return { output: { text: trimmed } };
    throw missingAgentOutputError({
      agent: input.agent,
      finishReason,
      toolCalls: toolCalls.map((call: { toolName: string }) => String(call.toolName)),
      streamError,
    });
  }

  const result = await generateText({
    model,
    system,
    prompt,
    tools,
    providerOptions: loopBuilderStreamProviderOptions(modelId) as never,
    stopWhen: [hasToolCall("finalizeAgent"), hasToolCall("finalizeRun"), stepCountIs(10)],
  });
  if (finalized.agentOutput !== undefined) return { output: finalized.agentOutput };
  const trimmed = result.text.trim();
  if (trimmed) {
    return {
      output: { text: trimmed },
    };
  }
  throw missingAgentOutputError({
    agent: input.agent,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls.map((call) => String(call.toolName)),
  });
}

async function reconcileStaleRunningSteps(input: {
  auth: AuthContext;
  runId: string;
}): Promise<void> {
  // A prior chat stream may have died after marking a step running. Interactive
  // duplicate streams are blocked by activeSpecRunChatStreams before we get here.
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'queued',
         updated_at = NOW()
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'running'`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
}

async function reconcilePendingInteractionSteps(input: {
  auth: AuthContext;
  runId: string;
}): Promise<void> {
  await pool.query(
    `UPDATE loop_engine_step_attempts sa
     SET status = 'waiting_for_interaction',
         updated_at = NOW()
     FROM loop_engine_interactions i
     WHERE i.step_attempt_id = sa.id
       AND i.run_id = $1
       AND i.tenant_id = $2
       AND i.user_id = $3
       AND i.status = 'pending'
       AND sa.status IN ('running', 'succeeded')`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'waiting_for_interaction', updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND status IN ('running', 'queued')
       AND EXISTS (
         SELECT 1
         FROM loop_engine_interactions i
         WHERE i.run_id = loop_engine_runs.id
           AND i.tenant_id = $2
           AND i.user_id = $3
           AND i.status = 'pending'
       )`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
}

export async function executeAgenticSpecRun(input: ExecuteAgenticSpecRunInput): Promise<void> {
  const spec = await hydrateDefinitionForExecution(input.auth, input.workflowId, input.spec);
  const plan = compileSpecRunPlan(spec);
  if (plan.agents.length === 0) {
    throw new Error("Runnable spec has no approved agents to execute.");
  }
  await markRunStatus({ runId: input.runId, status: "running" });
  await ensureAgentSteps({ auth: input.auth, runId: input.runId, plan });
  await reconcilePendingInteractionSteps({ auth: input.auth, runId: input.runId });
  await reconcileStaleRunningSteps({ auth: input.auth, runId: input.runId });
  if (await hasPendingInteraction({ auth: input.auth, runId: input.runId })) {
    await markRunStatus({ runId: input.runId, status: "waiting_for_interaction" });
    return;
  }

  let finalSummary: string | undefined;
  for (const agent of plan.agents) {
    const steps = await loadAgentSteps({ auth: input.auth, runId: input.runId, plan });
    const step = latestStepForAgent(steps, agent);
    if (step.status === "succeeded") {
      const output = asRecord(step.output_json);
      if (typeof output.text === "string") finalSummary = output.text;
      continue;
    }
    if (step.status === "waiting_for_interaction") {
      await markRunStatus({ runId: input.runId, status: "waiting_for_interaction", currentStepIndex: agent.index });
      return;
    }
    if (step.status === "failed" || step.status === "cancelled") {
      throw new Error(`Agent step ${agent.name} is ${step.status}.`);
    }

    const priorOutputs = priorOutputsForAgent(plan, steps, agent.index);
    const resolvedHandoff = await resolveHandoffForAgent({
      auth: input.auth,
      runId: input.runId,
      spec,
      workflowTitle: input.workflowTitle,
      runContext: input.runContext,
      plan,
      agent,
      steps,
    });
    if (resolvedHandoff.missingRequired.length > 0) {
      const reason = `Missing required handoff bindings for ${agent.name}: ${resolvedHandoff.missingRequired.join(", ")}`;
      const waiting = await createMissingHandoffInputIfPossible({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        agent,
        missingRequired: resolvedHandoff.missingRequired,
        reason,
      });
      if (waiting) return;
      await failAgentStep({ auth: input.auth, stepAttemptId: step.id, message: reason });
      await markRunStatus({ runId: input.runId, status: "failed", error: reason });
      await emitRunEvent({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        eventType: "handoff_evaluated",
        payload: {
          agentId: agent.id,
          agentName: agent.name,
          status: "needs_input",
          reason,
          missingRequired: resolvedHandoff.missingRequired,
        },
      });
      throw new Error(reason);
    }
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'running',
           input_json = input_json || $2::jsonb,
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $3 AND user_id = $4`,
      [
        step.id,
        JSON.stringify({
          runContext: input.runContext,
          priorOutputs,
          resolvedHandoff,
          agent: { id: agent.id, name: agent.name },
        }),
        input.auth.tenantId,
        input.auth.userId,
      ],
    );
    await markRunStatus({ runId: input.runId, status: "running", currentStepIndex: agent.index });
    await emitRunEvent({
      auth: input.auth,
      runId: input.runId,
      stepAttemptId: step.id,
      eventType: "agent_started",
      payload: { agentId: agent.id, agentName: agent.name, stepIndex: agent.index },
    });

    try {
      const result = await runAgent({
        auth: input.auth,
        workflowId: input.workflowId,
        runId: input.runId,
        spec,
        workflowTitle: input.workflowTitle,
        runContext: input.runContext,
        plan,
        agent,
        step,
        priorOutputs,
        resolvedHandoff,
        writer: input.writer,
      });
      const stepInput = asRecord(step.input_json);
      const agentOutput = result.output;
      const coerced = coerceOutputToContract({
        contract: agent.outputContract,
        output: agentOutput,
      });
      const nextAgent = plan.agents.find((candidate) => candidate.index === agent.index + 1);
      const goalEval = await evaluateAgentHandoff({
        plan,
        agent,
        nextAgent,
        rawOutput: result.output,
        structuredOutput: coerced.structuredOutput,
        normalizedOutput: coerced.normalizedOutput,
        priorOutputs,
        resolvedHandoff,
        contractIssues: coerced.contractIssues,
      });
      await emitRunEvent({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        eventType: "handoff_evaluated",
        payload: {
          agentId: agent.id,
          agentName: agent.name,
          status: goalEval.status,
          reason: goalEval.reason,
          blockers: goalEval.blockers,
          missingRequired: goalEval.missingRequired,
        },
      });
      const normalizedOutput = asRecord(goalEval.normalizedOutput);
      const normalizedHandoff = asRecord(goalEval.normalizedHandoff);
      const boundaryStructuredOutput = coerced.structuredOutput;
      const boundaryNormalizedOutput = Object.keys(normalizedOutput).length > 0 ? normalizedOutput : coerced.normalizedOutput;
      const routerDecision = routeBoundary({
        goalEval,
        normalizedOutput: boundaryNormalizedOutput,
        structuredOutput: boundaryStructuredOutput,
      });
      await emitRunEvent({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        eventType: "boundary_routed",
        payload: {
          agentId: agent.id,
          agentName: agent.name,
          routerDecision,
          goalEvalStatus: goalEval.status,
        },
      });
      if (routerDecision === "pause_for_input") {
        const missingRequired = goalEval.missingRequired ?? resolvedHandoff.missingRequired;
        const waiting = await createMissingHandoffInputIfPossible({
          auth: input.auth,
          runId: input.runId,
          stepAttemptId: step.id,
          agent,
          missingRequired,
          reason: goalEval.reason,
        });
        if (waiting) return;
        await failAgentStep({ auth: input.auth, stepAttemptId: step.id, message: goalEval.reason });
        await markRunStatus({ runId: input.runId, status: "failed", error: goalEval.reason });
        return;
      }
      if (routerDecision === "retry_step") {
        const retryStep = await requeueAgentStepRetry({
          auth: input.auth,
          runId: input.runId,
          step,
          agent,
          message: goalEval.reason,
        });
        if (!retryStep) {
          await failAgentStep({ auth: input.auth, stepAttemptId: step.id, message: goalEval.reason });
          await markRunStatus({ runId: input.runId, status: "failed", error: goalEval.reason });
          return;
        }
        await markRunStatus({ runId: input.runId, status: "running", currentStepIndex: agent.index });
        return executeAgenticSpecRun(input);
      }
      if (routerDecision === "fail_run") {
        await failAgentStep({ auth: input.auth, stepAttemptId: step.id, message: goalEval.reason });
        await markRunStatus({ runId: input.runId, status: "failed", error: goalEval.reason });
        return;
      }
      const boundaryEnvelope = buildBoundaryEnvelope({
        rawOutput: result.output,
        structuredOutput: boundaryStructuredOutput,
        normalizedOutput: boundaryNormalizedOutput,
        normalizedHandoff: Object.keys(normalizedHandoff).length > 0
          ? normalizedHandoff
          : boundaryNormalizedOutput,
        goalEval,
      });
      const completed = await completeAgentStep({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        agent,
        boundaryEnvelope,
        routerDecision,
        boundaryIssues: coerced.contractIssues,
        text: coerced.text,
        stepInput,
      });
      finalSummary = completed.text;
      await emitRunEvent({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        eventType: "boundary_persisted",
        payload: { agentId: agent.id, agentName: agent.name, routerDecision },
      });
      await emitRunEvent({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        eventType: "agent_completed",
        payload: { agentId: agent.id, agentName: agent.name },
      });
      if (routerDecision === "finish_no_action" || shouldTerminateRunAfterAgent(completed.structuredOutput)) {
        finalSummary = completed.text || finalSummary;
        break;
      }
      const gated = await createConfiguredGateIfNeeded({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        agent,
        stepInput,
        structuredOutput: completed.structuredOutput,
        text: completed.text,
        plan,
      });
      if (gated) return;
      if (agent.gate) {
        await markAgentStepSucceeded({
          auth: input.auth,
          stepAttemptId: step.id,
        });
      }
    } catch (error) {
      if (error instanceof SpecRunInteractionRequiredError) return;
      const message = error instanceof Error ? error.message : String(error);
      await failAgentStep({ auth: input.auth, stepAttemptId: step.id, message });
      await markRunStatus({ runId: input.runId, status: "failed", error: message });
      await emitRunEvent({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        eventType: "agent_failed",
        payload: { agentId: agent.id, agentName: agent.name, message },
      });
      throw error;
    }
  }

  const summary = finalSummary ?? `Run completed for ${input.workflowTitle}.`;
  await markRunStatus({ runId: input.runId, status: "succeeded", summary });
  await emitRunEvent({
    auth: input.auth,
    runId: input.runId,
    eventType: "run_succeeded",
    payload: { summary },
  });
}
