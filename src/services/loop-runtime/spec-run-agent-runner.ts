import { randomUUID } from "crypto";
import { generateText, stepCountIs, streamText, type UIMessageStreamWriter } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { loopBuilderOpenAiModel, loopBuilderStreamProviderOptions } from "../loop-builder/openai-chat.js";
import { resolveLoopChatLanguageModel } from "../llm/loop-chat-client.js";
import { buildRunSeedMessage, type RunContext } from "./build-run-context.js";
import { SpecRunInteractionRequiredError } from "./spec-run-agent-errors.js";
import { emitRunEvent } from "./spec-run-agent-events.js";
import { buildAgentTools } from "./spec-run-agent-tools.js";
import { compileSpecRunPlan, type CompiledSpecRunPlan, type RunPlanAgent } from "./spec-run-plan.js";
import { dicebearDylanUrl } from "../loop-builder/agent-personas.js";
import { buildSpecRunSystemPrompt } from "./spec-run-prompt.js";
import type { RunnableSpec } from "./spec-run-types.js";

export { SpecRunInteractionRequiredError } from "./spec-run-agent-errors.js";

type AgentStepRow = {
  id: string;
  step_index: number;
  agent_id: string;
  agent_snapshot: unknown;
  status: string;
  input_json: unknown;
  output_json: unknown;
  error_json: unknown;
};

type PriorAgentOutput = {
  agentId: string;
  agentName: string;
  output: unknown;
};

type ExecuteAgenticSpecRunInput = {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  spec: RunnableSpec;
  workflowTitle: string;
  runContext: RunContext;
  writer?: UIMessageStreamWriter;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

  const result = await pool.query<AgentStepRow>(
    `SELECT id, step_index, agent_id, agent_snapshot, status, input_json, output_json, error_json
     FROM loop_engine_step_attempts
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY step_index ASC, attempt ASC`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
  const agentIds = new Set(input.plan.agents.map((agent) => agent.id));
  return result.rows.filter((row) => agentIds.has(row.agent_id));
}

export async function materializeSpecRunAgentSteps(input: {
  auth: AuthContext;
  runId: string;
  spec: RunnableSpec;
}): Promise<AgentStepRow[]> {
  const plan = compileSpecRunPlan(input.spec);
  if (plan.agents.length === 0) {
    throw new Error("Runnable spec has no approved agents to execute.");
  }
  return ensureAgentSteps({
    auth: input.auth,
    runId: input.runId,
    plan,
  });
}

function latestStepForAgent(steps: AgentStepRow[], agent: RunPlanAgent): AgentStepRow {
  const step = steps.find((row) => row.step_index === agent.index);
  if (!step) throw new Error(`Missing materialized step for agent ${agent.name}`);
  return step;
}

async function loadAgentSteps(input: {
  auth: AuthContext;
  runId: string;
  plan: CompiledSpecRunPlan;
}): Promise<AgentStepRow[]> {
  const result = await pool.query<AgentStepRow>(
    `SELECT id, step_index, agent_id, agent_snapshot, status, input_json, output_json, error_json
     FROM loop_engine_step_attempts
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY step_index ASC, attempt ASC`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
  const agentIds = new Set(input.plan.agents.map((agent) => agent.id));
  return result.rows.filter((row) => agentIds.has(row.agent_id));
}

function priorOutputsForAgent(plan: CompiledSpecRunPlan, steps: AgentStepRow[], currentIndex: number): PriorAgentOutput[] {
  return plan.agents
    .filter((agent) => agent.index < currentIndex)
    .flatMap((agent): PriorAgentOutput[] => {
      const step = steps.find((row) => row.step_index === agent.index);
      if (!step || step.status !== "succeeded") return [];
      return [{
        agentId: agent.id,
        agentName: agent.name,
        output: asRecord(step.output_json),
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

async function completeAgentStep(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  output: unknown;
}): Promise<void> {
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'succeeded',
         output_json = $2::jsonb,
         error_json = '{}'::jsonb,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $3 AND user_id = $4`,
    [
      input.stepAttemptId,
      JSON.stringify({ data: input.output, text: outputText(input.output) }),
      input.auth.tenantId,
      input.auth.userId,
    ],
  );
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

function buildAgentPrompt(input: {
  spec: RunnableSpec;
  runContext: RunContext;
  plan: CompiledSpecRunPlan;
  agent: RunPlanAgent;
  priorOutputs: PriorAgentOutput[];
  stepInput: Record<string, unknown>;
}): string {
  const pendingRevision = asRecord(input.stepInput.revision);
  const reviewApproval = asRecord(input.stepInput.reviewApproval);
  const reviewWasApproved = Object.keys(reviewApproval).length > 0;
  return [
    buildRunSeedMessage(input.runContext, input.spec),
    "",
    `Current agent (${input.agent.index + 1}/${input.plan.agents.length}): ${input.agent.name}`,
    `Goal: ${input.agent.goal}`,
    input.agent.guardrails.length > 0 ? `Guardrails:\n${input.agent.guardrails.map((entry) => `- ${entry}`).join("\n")}` : "",
    input.agent.doneWhen.length > 0 ? `Done when:\n${input.agent.doneWhen.map((entry) => `- ${entry}`).join("\n")}` : "",
    input.agent.failureModes.length > 0 ? `Failure modes:\n${input.agent.failureModes.map((entry) => `- ${entry}`).join("\n")}` : "",
    `Allowed tool refs:\n${input.agent.toolRefs.map((entry) => `- ${entry}`).join("\n")}`,
    input.plan.inputRequirements.length > 0
      ? `Declared operator surfaces:\n${JSON.stringify(input.plan.inputRequirements, null, 2)}`
      : "",
    input.plan.reviewSurfaces.length > 0
      ? `Review surfaces available: ${input.plan.reviewSurfaces.join(", ")}`
      : "",
    input.priorOutputs.length > 0
      ? `Structured handoff context from prior agents:\n${JSON.stringify(input.priorOutputs, null, 2)}`
      : "No prior agent outputs yet.",
    Object.keys(pendingRevision).length > 0
      ? `Operator revision feedback for this retry:\n${JSON.stringify(pendingRevision, null, 2)}`
      : "",
    reviewWasApproved
      ? `The operator has approved this run's draft review. DO NOT call requestReview again. Proceed immediately to the connector write/send action using requestApproval; the runner will execute covered approved actions without opening another review. The approved draft content is already saved as an artifact.\nApproval context: ${JSON.stringify(reviewApproval, null, 2)}`
      : "",
    "",
    "Run only this agent.",
    "Allowed direct tools (call without any gate): searchMemory, searchWeb, getTriggerPayload, connector read tools, finalizeAgent.",
    "Operator gate tools (ONLY for data that only a human can supply): requestInput, requestReview, requestApproval.",
    "NEVER call requestInput for searchMemory queries, IDs you could look up, or any data accessible via a direct tool.",
    "Do not narrate tool choices, print JSON, or draft operator-facing content in normal prose before the relevant tool call. Use tool calls for work products: requestReview/requestApproval for operator-visible drafts and finalizeAgent for the structured handoff.",
    "When your agent step is complete, call finalizeAgent with structured output.",
  ].filter(Boolean).join("\n");
}

async function runAgent(input: {
  auth: AuthContext;
  workflowId: string;
  runId: string;
  spec: RunnableSpec;
  runContext: RunContext;
  plan: CompiledSpecRunPlan;
  agent: RunPlanAgent;
  step: AgentStepRow;
  priorOutputs: PriorAgentOutput[];
  writer?: UIMessageStreamWriter;
}): Promise<{ output: unknown; runSummary?: string }> {
  const finalized: { agentOutput?: unknown; runSummary?: string } = {};
  const tools = buildAgentTools({
    auth: input.auth,
    workflowId: input.workflowId,
    runId: input.runId,
    spec: input.spec,
    runContext: input.runContext,
    plan: input.plan,
    agent: input.agent,
    stepAttemptId: input.step.id,
    finalized,
  });
  const modelId = loopBuilderOpenAiModel();
  const model = resolveLoopChatLanguageModel(modelId);
  const system = [
    buildSpecRunSystemPrompt(input.spec, input.runContext),
    "",
    "Execution architecture: one model invocation controls exactly one approved spec agent. Mutating external actions are never direct tools; create requestApproval interactions instead. Operator input and review must be represented with runtime tools, not prose.",
  ].join("\n");
  const prompt = buildAgentPrompt({
    spec: input.spec,
    runContext: input.runContext,
    plan: input.plan,
    agent: input.agent,
    priorOutputs: input.priorOutputs,
    stepInput: asRecord(input.step.input_json),
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
    const agentStream = streamText({
      model,
      system,
      prompt,
      tools,
      providerOptions: loopBuilderStreamProviderOptions(modelId),
      stopWhen: stepCountIs(10),
      onError: ({ error }) => {
        if (!(error instanceof SpecRunInteractionRequiredError)) {
          console.error("Agent stream error:", error);
        }
      },
    });
    input.writer.merge(agentStream.toUIMessageStream({ sendReasoning: true }));
    const text = await agentStream.text;
    return {
      output: finalized.agentOutput ?? { text: text.trim() },
      runSummary: finalized.runSummary,
    };
  }

  const result = await generateText({
    model,
    system,
    prompt,
    tools,
    providerOptions: loopBuilderStreamProviderOptions(modelId),
    stopWhen: stepCountIs(10),
  });
  return {
    output: finalized.agentOutput ?? { text: result.text.trim() },
    runSummary: finalized.runSummary,
  };
}

export async function executeAgenticSpecRun(input: ExecuteAgenticSpecRunInput): Promise<void> {
  const plan = compileSpecRunPlan(input.spec);
  if (plan.agents.length === 0) {
    throw new Error("Runnable spec has no approved agents to execute.");
  }
  await markRunStatus({ runId: input.runId, status: "running" });
  await ensureAgentSteps({ auth: input.auth, runId: input.runId, plan });
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
        spec: input.spec,
        runContext: input.runContext,
        plan,
        agent,
        step,
        priorOutputs,
        writer: input.writer,
      });
      await completeAgentStep({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        output: result.output,
      });
      finalSummary = result.runSummary ?? outputText(result.output);
      await emitRunEvent({
        auth: input.auth,
        runId: input.runId,
        stepAttemptId: step.id,
        eventType: "agent_completed",
        payload: { agentId: agent.id, agentName: agent.name },
      });
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
