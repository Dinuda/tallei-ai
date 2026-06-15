import { createHash, randomUUID } from "node:crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { evaluateAgentGoal } from "../loop-engine/goal-eval.js";
import { extractWebSearchSources } from "../loop-engine/contracts.js";
import { selectedConnectorAccountId } from "../loop-engine/build-contract.js";
import { contractMediaType, contractRenderer, contractVisibility } from "../loop-engine/data-contract.js";
import {
  activeOperatorInteractionSchema,
  findOperatorInteraction,
  operatorInteractionCommandSchema,
  type OperatorInteractionKind,
  type OperatorInteractionPlanItem,
} from "../loop-engine/operator-interactions.js";
import { renderArtifact } from "./artifact-renderers.js";
import { buildAgentHandoff, buildOperatorRevisionPatch, applyGateDecisionToRunMemory, type RunMemory } from "./memory.js";
import { runLoopAgent } from "../loop-executor/agent-runner.js";
import {
  loadWorkflowUserProfile,
  sanitizeWorkflowUserProfile,
} from "../loop-engine/workflow-user-profile.js";
import {
  connectedAppToolkits,
  executeApprovedComposioAction,
  listConnectorAccounts,
  markConnectorActionEventFailed,
} from "../connectors/composio.js";
import { getLoopTool } from "../loop-executor/tool-catalog.js";
import { loopRunAgentSchema, type LoopContactRow, type LoopRunAgent } from "../loop-executor/types.js";
import { deriveSubjectFromBody, type CanvasEmailTemplate } from "./email-canvas.js";
import {
  selectLatestArtifactsByKey,
} from "./artifact-selection.js";
import {
  buildDeliveryRecipientsPatch,
  stashContactListAsDocument,
} from "./contacts-context.js";
import { parseContactListCsv } from "../loop-executor/csv-parser.js";
import {
  ConnectorActionPayloadError,
  mergeStableConfigWithRuntimeInputs,
  normalizeConnectorPayloadForSchema,
  resolveConnectorActionContract,
  resolveConnectorOutputForValidation,
  sanitizeConnectorDetails,
  validateConnectorActionOutput,
} from "./connector-action-payload.js";
import { validateConnectorReadiness } from "../tool-spec/action-readiness.js";
import { buildPriorOutputIndex, extractStructuredOutputFromArtifact, resolveAgentHandoffBindings } from "./typed-handoff.js";
import { runtimeContextSchema, runtimeDefinitionSchema, type RuntimeContext, type RuntimeDefinition } from "./types.js";
import {
  evaluateExecutionBlockingAt,
  applyGateSurfaceSubmission,
  collectRequirements,
  isRequirementSatisfied,
  readRequirementValue,
  resolvedRuntimeInputs,
} from "./input-satisfaction.js";
import { projectOperatorView } from "./operator-view.js";
import { persistLoopRunWorkspaceMemory } from "../workspace-memory.js";
import {
  gateSurfaceSubmissionSchema,
  isInputSurface,
  type InputRequirementWhen,
  type SurfaceSubmissionValue,
} from "../loop-engine/input-surfaces.js";

const WORKER_LEASE_MS = 60_000;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const;
const workerId = `loop-runtime-${randomUUID()}`;

type CommandRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  run_id: string;
  step_attempt_id: string | null;
  command_type: "start_run" | "execute_step" | "continue_after_interaction" | "finalize_run" | "retry_step";
  attempts: number;
  max_attempts: number;
  payload_json: unknown;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isTypedOperatorWorkflow(definition: RuntimeDefinition): boolean {
  return definition.builderMeta?.planningIRVersion === "v2";
}

function requirePlannedInteraction<TKind extends OperatorInteractionPlanItem["kind"]>(
  definition: RuntimeDefinition,
  kind: TKind,
  predicate: (item: Extract<OperatorInteractionPlanItem, { kind: TKind }>) => boolean,
): Extract<OperatorInteractionPlanItem, { kind: TKind }> | undefined {
  const interaction = findOperatorInteraction(definition.operatorInteractionPlan, kind, predicate);
  if (!interaction && isTypedOperatorWorkflow(definition)) {
    throw new Error(`Typed operator interaction plan is missing ${kind}. Refine or re-draft this workflow.`);
  }
  return interaction;
}

function runMemoryFromContext(context: RuntimeContext): RunMemory {
  return {
    inputs: context.inputs,
    approvedMemories: context.approvedMemories,
    approvedSources: context.approvedSources,
    operatorRevisions: context.operatorRevisions,
    updatedAt: new Date().toISOString(),
  };
}

function sourceConfirmationItems(resultData: Record<string, unknown>) {
  return extractWebSearchSources(resultData).map((source, index) => ({
    id: source.url || `source_${index + 1}`,
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    include: true,
  }));
}

function compactArtifactBody(body: string, maxChars = 6_000) {
  if (body.length <= maxChars) return body;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.floor(maxChars * 0.2);
  return [
    body.slice(0, headChars),
    `[truncated ${body.length - headChars - tailChars} chars]`,
    body.slice(body.length - tailChars),
  ].join("\n");
}

function compactArtifactData(data: unknown, maxChars = 6_000) {
  try {
    const text = JSON.stringify(data);
    if (text.length <= maxChars) return data;
    return {
      truncated: true,
      originalSizeChars: text.length,
      excerpt: text.slice(0, maxChars),
    };
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function parseComposioActionRef(ref: string): { toolkit: string; actionSlug: string } | null {
  const match = ref.toLowerCase().match(/^composio\.([a-z0-9_-]+)\.action\.(.+)$/);
  return match ? { toolkit: match[1], actionSlug: match[2] } : null;
}

function approvedConnectorAction(definition: RuntimeDefinition, agent: LoopRunAgent) {
  const assignment = agent.tools.find((tool) => parseComposioActionRef(tool.ref));
  if (!assignment) return null;
  const parsed = parseComposioActionRef(assignment.ref);
  if (!parsed) return null;
  const writePolicy = definition.connectorPolicy?.allowedWriteActions.find((action) =>
    action.toolkit.toLowerCase() === parsed.toolkit
    && action.actionSlug.toLowerCase() === parsed.actionSlug
    && action.requiresPreSendApproval
  );
  if (writePolicy) return { assignment, toolkit: writePolicy.toolkit, actionSlug: writePolicy.actionSlug, policy: writePolicy, requiresApproval: true };
  const readPolicy = definition.connectorPolicy?.allowedReadActions.find((action) =>
    action.toolkit.toLowerCase() === parsed.toolkit
    && action.actionSlug.toLowerCase() === parsed.actionSlug
  );
  if (!readPolicy) return null;
  return { assignment, toolkit: readPolicy.toolkit, actionSlug: readPolicy.actionSlug, policy: readPolicy, requiresApproval: false };
}

async function prepareConnectorActionPayload(input: {
  agent: LoopRunAgent;
  assignmentConfig: Record<string, unknown>;
  priorOutputs: Record<string, unknown>;
  definition: RuntimeDefinition;
  context: RuntimeContext;
  toolRef: string;
}) {
  const contract = await resolveConnectorActionContract({
    definition: input.definition,
    toolRef: input.toolRef,
  });
  const operatorInputs = resolvedRuntimeInputs(input.definition, input.context);
  const handoff = resolveAgentHandoffBindings({
    agent: input.agent,
    priorOutputs: input.priorOutputs,
    operatorInputs,
    stableConfig: mergeStableConfigWithRuntimeInputs(
      input.assignmentConfig,
      operatorInputs,
      input.agent.handoffBindings,
    ),
  });
  const invalidProvenance = handoff.resolvedBindings.filter((binding) => !binding.provenanceValid);
  const unresolvedRequired = handoff.resolvedBindings.filter((binding) => binding.binding.required && !binding.resolved);
  if (invalidProvenance.length > 0 || unresolvedRequired.length > 0) {
    throw new ConnectorActionPayloadError(
      `Typed handoff provenance does not satisfy ${contract.toolRef}`,
      {
        contract,
        validationErrors: [
          ...invalidProvenance.map((item) => ({ path: item.binding.targetPath, keyword: "provenance", message: "Binding provenance is invalid." })),
          ...unresolvedRequired.map((item) => ({ path: item.binding.targetPath, keyword: "required_source", message: "Required binding source is unavailable." })),
        ],
        attempts: 0,
      },
    );
  }
  if (contract.readiness.unresolvedRequirements.length > 0) {
    throw new ConnectorActionPayloadError(
      `Connector readiness contract is unresolved for ${contract.toolRef}`,
      {
        contract,
        validationErrors: contract.readiness.unresolvedRequirements.map((message) => ({
          path: "/",
          keyword: "unresolved_requirement",
          message,
        })),
        attempts: 0,
      },
    );
  }
  const payload = normalizeConnectorPayloadForSchema(handoff.value, contract.readiness.effectiveInputSchema);
  const validation = validateConnectorReadiness(contract.readiness, payload);
  if (!validation.valid) {
    throw new ConnectorActionPayloadError(
      `Typed handoff does not satisfy ${contract.toolRef}`,
      { contract, validationErrors: validation.errors, attempts: 0 },
    );
  }
  const compiled = {
    payload,
    validation,
    attempts: 0,
    model: "typed_handoff",
    handoffResolution: handoff.resolvedBindings,
  };
  return {
    contract,
    ...compiled,
    payload: compiled.payload,
  };
}

function connectorStepOutput(input: {
  message: string;
  result?: unknown;
  prepared?: Record<string, unknown>;
  payloadHash?: string;
  specHash?: string;
}) {
  return {
    text: input.message,
    data: sanitizeConnectorDetails({
      ...(input.prepared ?? {}),
      ...(input.result ? { result: input.result } : {}),
      ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
      ...(input.specHash ? { specHash: input.specHash } : {}),
    }),
  };
}

async function failConnectorActionStep(input: {
  command: CommandRow;
  attemptId: string;
  message: string;
  details: Record<string, unknown>;
  toolkit: string;
  actionSlug: string;
}) {
  const safeDetails = asObject(sanitizeConnectorDetails(input.details));
  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'failed', output_json = $2::jsonb, error_json = $3::jsonb, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [
      input.attemptId,
      JSON.stringify(connectorStepOutput({ message: input.message, prepared: safeDetails })),
      JSON.stringify({ message: input.message, connector: safeDetails }),
    ],
  );
  await pool.query(
    `UPDATE loop_engine_runs SET status = 'failed', error_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status <> 'cancelled'`,
    [input.command.run_id, JSON.stringify({ message: input.message, connector: safeDetails })],
  );
  await insertEvent({
    tenantId: input.command.tenant_id,
    userId: input.command.user_id,
    runId: input.command.run_id,
    stepAttemptId: input.attemptId,
    eventType: "connector_action_failed",
    payload: { toolkit: input.toolkit, actionSlug: input.actionSlug, message: input.message },
  });
}

function connectorPayloadPreparationDetails(prepared: Awaited<ReturnType<typeof prepareConnectorActionPayload>>) {
  return {
    toolRef: prepared.contract.toolRef,
    toolkit: prepared.contract.toolkit,
    actionSlug: prepared.contract.actionSlug,
    toolkitVersion: prepared.contract.toolkitVersion,
    contractSource: prepared.contract.source,
    inputSchema: prepared.contract.inputSchema,
    outputSchema: prepared.contract.outputSchema,
    payload: sanitizeConnectorDetails(prepared.payload),
    payloadCompilation: {
      attempts: prepared.attempts,
      model: prepared.model,
      validation: prepared.validation,
      ...("handoffResolution" in prepared ? { handoffResolution: prepared.handoffResolution } : {}),
    },
  };
}

function outputValidationForResult(
  contract: { outputSchema: Record<string, unknown> },
  result: { output?: Record<string, unknown>; rawResponse?: Record<string, unknown>; actionOutputData?: unknown; ok?: boolean },
) {
  return validateConnectorActionOutput(
    contract,
    resolveConnectorOutputForValidation(contract, result),
  );
}

function connectorActionFailureMessage(error: unknown): string {
  if (error instanceof ConnectorActionPayloadError) {
    const fields = error.details.validationErrors.map((item) => item.path).filter(Boolean);
    return fields.length > 0
      ? `${error.message}. Missing or invalid action inputs: ${[...new Set(fields)].join(", ")}`
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isConnectorActionPreSendGate(gatePayload: Record<string, unknown>): boolean {
  return gatePayload.kind === "connector_action";
}

function summarizeConnectorActionPayload(payload: Record<string, unknown>) {
  const sanitized = sanitizeConnectorDetails(payload);
  const serialized = JSON.stringify(sanitized);
  return {
    fields: Object.keys(payload),
    preview: serialized.length > 1_200 ? `${serialized.slice(0, 1_200)}[truncated]` : serialized,
  };
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|rate limit|temporarily unavailable|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

async function insertEvent(input: {
  tenantId: string;
  userId: string;
  runId: string;
  stepAttemptId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO loop_engine_events
     (tenant_id, user_id, run_id, step_attempt_id, event_type, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [input.tenantId, input.userId, input.runId, input.stepAttemptId ?? null, input.eventType, JSON.stringify(input.payload ?? {})],
  );
}

async function enqueueCommand(input: {
  tenantId: string;
  userId: string;
  runId: string;
  stepAttemptId?: string | null;
  commandType: CommandRow["command_type"];
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  notBefore?: Date;
}) {
  await pool.query(
    `INSERT INTO loop_engine_commands
     (tenant_id, user_id, run_id, step_attempt_id, command_type, idempotency_key, payload_json, not_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      input.tenantId,
      input.userId,
      input.runId,
      input.stepAttemptId ?? null,
      input.commandType,
      input.idempotencyKey,
      JSON.stringify(input.payload ?? {}),
      input.notBefore ?? new Date(),
    ],
  );
}

async function startLoopRun(input: {
  auth: AuthContext;
  workflowId: string;
  inputs?: Record<string, string>;
  queuedEvent?: Record<string, unknown>;
}) {
  const { auth, workflowId } = input;
  const workflowResult = await pool.query<{ id: string; title: string; metadata_json: unknown }>(
    `SELECT id, title, metadata_json FROM workflows
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'active'
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId],
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) throw new Error("Loop workflow not found");
  const metadata = asObject(workflow.metadata_json);
  const definition = runtimeDefinitionSchema.parse(metadata.loopDefinition);
  const runId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO loop_engine_runs
       (id, tenant_id, user_id, workflow_id, status, definition_snapshot, context_json)
       VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, $6::jsonb)`,
      [runId, auth.tenantId, auth.userId, workflowId, JSON.stringify(definition), JSON.stringify({ inputs: input.inputs ?? {}, approvedMemories: [], approvedSources: {}, operatorRevisions: {} })],
    );
    await client.query(
      `INSERT INTO loop_engine_commands
       (tenant_id, user_id, run_id, command_type, idempotency_key)
       VALUES ($1, $2, $3, 'start_run', $4)`,
      [auth.tenantId, auth.userId, runId, `run:${runId}:start`],
    );
    await client.query(
      `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, event_type, payload_json)
       VALUES ($1, $2, $3, 'run_queued', $4::jsonb)`,
      [auth.tenantId, auth.userId, runId, JSON.stringify({ workflowId, workflowTitle: workflow.title, ...(input.queuedEvent ?? {}) })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getLoopRuntimeProjection(auth, runId);
}

export async function startManualLoopRun(auth: AuthContext, workflowId: string) {
  return startLoopRun({ auth, workflowId });
}

export async function startWebhookLoopRun(
  auth: AuthContext,
  workflowId: string,
  event: { id: string; type: string; triggerSlug: string; data: Record<string, unknown> },
) {
  return startLoopRun({
    auth,
    workflowId,
    inputs: {
      trigger_payload: JSON.stringify(event.data),
      trigger_event_id: event.id,
      trigger_type: event.type,
      trigger_slug: event.triggerSlug,
    },
    queuedEvent: { source: "connector_webhook", triggerEventId: event.id, triggerSlug: event.triggerSlug },
  });
}

async function createAttempt(input: {
  tenantId: string;
  userId: string;
  runId: string;
  stepIndex: number;
  agent: LoopRunAgent;
  attempt: number;
  inputJson?: Record<string, unknown>;
}) {
  const id = randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO loop_engine_step_attempts
     (id, tenant_id, user_id, run_id, step_index, agent_id, agent_snapshot, attempt, status, input_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'queued', $9::jsonb)
     ON CONFLICT (run_id, step_index, attempt)
     DO UPDATE SET updated_at = loop_engine_step_attempts.updated_at
     RETURNING id`,
    [
      id,
      input.tenantId,
      input.userId,
      input.runId,
      input.stepIndex,
      input.agent.id,
      JSON.stringify(input.agent),
      input.attempt,
      JSON.stringify(input.inputJson ?? {}),
    ],
  );
  return result.rows[0]!.id;
}

async function handleStartRun(command: CommandRow) {
  const result = await pool.query<{ definition_snapshot: unknown; status: string }>(
    `SELECT definition_snapshot, status FROM loop_engine_runs WHERE id = $1 LIMIT 1`,
    [command.run_id],
  );
  const row = result.rows[0];
  if (!row || row.status !== "queued") return;
  const definition = runtimeDefinitionSchema.parse(row.definition_snapshot);
  const firstAgent = definition.agentGraph!.children[0]!;
  const attemptId = await createAttempt({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepIndex: 0,
    agent: firstAgent,
    attempt: 1,
  });
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'running', current_step_index = 0, started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [command.run_id],
  );
  await enqueueCommand({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepAttemptId: attemptId,
    commandType: "execute_step",
    idempotencyKey: `attempt:${attemptId}:execute`,
  });
  await insertEvent({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    eventType: "run_started",
  });
}

async function createInteraction(input: {
  command: CommandRow;
  attemptId: string;
  gateType: OperatorInteractionKind;
  question: string;
  payload: Record<string, unknown>;
}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO loop_engine_interactions
     (id, tenant_id, user_id, run_id, step_attempt_id, interaction_kind, question, payload_json, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      id,
      input.command.tenant_id,
      input.command.user_id,
      input.command.run_id,
      input.attemptId,
      input.gateType,
      input.question,
      JSON.stringify(input.payload),
      `attempt:${input.attemptId}:interaction:${input.gateType}`,
    ],
  );
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'waiting_for_interaction', updated_at = NOW() WHERE id = $1`,
    [input.attemptId],
  );
  await pool.query(
    `UPDATE loop_engine_runs SET status = 'waiting_for_interaction', updated_at = NOW() WHERE id = $1`,
    [input.command.run_id],
  );
  await insertEvent({
    tenantId: input.command.tenant_id,
    userId: input.command.user_id,
    runId: input.command.run_id,
    stepAttemptId: input.attemptId,
    eventType: "interaction_waiting",
    payload: { interactionKind: input.gateType, question: input.question },
  });
}

async function openRequirementCheckpoint(input: {
  command: CommandRow;
  attemptId: string;
  stepIndex: number;
  agent: LoopRunAgent;
  definition: RuntimeDefinition;
  context: RuntimeContext;
  when: InputRequirementWhen;
}): Promise<boolean> {
  const unsatisfied = evaluateExecutionBlockingAt(input.definition, input.context, input.when)
    .filter((row) => {
      if (!isTypedOperatorWorkflow(input.definition)) return true;
      return Boolean(findOperatorInteraction(
        input.definition.operatorInteractionPlan,
        "collect_input",
        (item) => item.requiredValueKey === row.requirement.key && item.consumingNodeId === input.agent.id,
      ));
    });
  if (unsatisfied.length === 0) return false;

  const requirements = unsatisfied.map((row) => row.requirement);
  const plannedInteractions = requirements.flatMap((requirement) => {
    const interaction = requirePlannedInteraction(
      input.definition,
      "collect_input",
      (item) => item.requiredValueKey === requirement.key && item.consumingNodeId === input.agent.id,
    );
    return interaction ? [interaction] : [];
  });
  const items = requirements.map((requirement) => ({
    id: `required:${requirement.key}`,
    kind: "collect_input" as const,
    requiredValueKey: requirement.key,
    consumingNodeId: input.agent.id,
    surface: requirement.surface,
    timing: requirement.when,
    valueType: requirement.surface === "input.contacts_csv" ? "array" : "string",
    label: requirement.label ?? requirement.key,
    description: requirement.description ?? `Provide ${requirement.label ?? requirement.key} to continue.`,
    required: requirement.required,
  }));
  const question = items.length === 1
    ? items[0]!.description
    : `Provide ${items.map((item) => item.label).join(", ")} to continue.`;
  await createInteraction({
    command: input.command,
    attemptId: input.attemptId,
    gateType: "collect_input",
    question,
    payload: {
      when: input.when,
      agentId: input.agent.id,
      stepIndex: input.stepIndex,
      operatorInteraction: {
        kind: "collect_input",
        interactionIds: plannedInteractions.map((item) => item.id),
        items: items.map((item) => ({ ...item, satisfied: false })),
      },
    },
  });
  await pool.query(
    `UPDATE loop_engine_step_attempts SET output_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [input.attemptId, JSON.stringify({ text: question, data: { when: input.when, requiredValues: items } })],
  );
  return true;
}

async function openConnectorConnectionCheckpoint(input: {
  command: CommandRow;
  attemptId: string;
  stepIndex: number;
  agent: LoopRunAgent;
  definition: RuntimeDefinition;
  toolkit: string;
  actionSlug: string;
  toolRef: string;
}): Promise<boolean> {
  const auth = {
    tenantId: input.command.tenant_id,
    userId: input.command.user_id,
    authMode: "internal" as const,
    plan: "pro" as const,
  };
  const connected = new Set(connectedAppToolkits(await listConnectorAccounts(auth).catch(() => [])));
  if (connected.has(input.toolkit.toLowerCase())) return false;
  const interaction = requirePlannedInteraction(
    input.definition,
    "connect_connector",
    (item) => item.actionNodeId === input.agent.id && item.contractRef === input.toolRef,
  );
  const question = `Connect ${input.toolkit} to continue ${input.actionSlug}.`;
  await createInteraction({
    command: input.command,
    attemptId: input.attemptId,
    gateType: "connect_connector",
    question,
    payload: {
      when: "before_step",
      agentId: input.agent.id,
      stepIndex: input.stepIndex,
      connectorSetup: {
        provider: "composio",
        toolkit: input.toolkit,
        actionSlug: input.actionSlug,
        toolRef: input.toolRef,
      },
      operatorInteraction: {
        kind: "connect_connector",
        interactionId: interaction?.id ?? randomUUID(),
        actionNodeId: input.agent.id,
        contractRef: input.toolRef,
        toolkit: input.toolkit,
        actionSlug: input.actionSlug,
        connected: false,
      },
    },
  });
  await pool.query(
    `UPDATE loop_engine_step_attempts SET output_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [input.attemptId, JSON.stringify({
      text: `Waiting for ${input.toolkit} connection.`,
      data: { toolkit: input.toolkit, actionSlug: input.actionSlug, toolRef: input.toolRef },
    })],
  );
  return true;
}

async function openCurationReviewCheckpoint(input: {
  command: CommandRow;
  attemptId: string;
  stepIndex: number;
  agent: LoopRunAgent;
  gateType: "memory_confirmation" | "source_confirmation";
  question: string;
  output: Record<string, unknown>;
  resultData: Record<string, unknown>;
}): Promise<void> {
  const basePayload = {
    ...gatePayloadForResult("review_artifact", input.agent.id, input.stepIndex, input.output, input.resultData),
    gateType: input.gateType,
  };
  await createInteraction({
    command: input.command,
    attemptId: input.attemptId,
    gateType: "review_artifact",
    question: input.question,
    payload: {
      ...basePayload,
      operatorInteraction: {
        kind: "review_artifact",
        interactionId: `review:${input.agent.outputArtifactId ?? `${input.agent.id}_output`}`,
        artifactId: input.agent.outputArtifactId ?? `${input.agent.id}_output`,
        rendererRef: null,
        editable: input.gateType === "source_confirmation",
        producerNodeId: input.agent.id,
        outputText: typeof input.output.text === "string" ? input.output.text : "",
      },
    },
  });
}

function gatePayloadForResult(
  gateType: OperatorInteractionKind,
  agentId: string,
  stepIndex: number,
  output: Record<string, unknown>,
  resultData: Record<string, unknown>,
) {
  const items = (Array.isArray(resultData.sources) ? resultData.sources : [])
    .map((row) => {
      const item = asObject(row);
      const id = typeof item.id === "string" ? item.id : "";
      const excerpt = typeof item.text === "string" ? item.text : typeof item.excerpt === "string" ? item.excerpt : "";
      return id && excerpt
        ? {
            id,
            excerpt,
            include: true,
            ...(typeof item.score === "number" ? { score: item.score } : {}),
            ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
            ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
            ...(typeof item.evidenceRole === "string" ? { evidenceRole: item.evidenceRole } : {}),
            ...(asObject(item.metadata) ? { metadata: asObject(item.metadata) } : {}),
          }
        : null;
    })
    .filter((row): row is { id: string; excerpt: string; include: boolean } & Record<string, unknown> => row !== null);
  return {
    agentId,
    stepIndex,
    result: output,
    ...(items.length > 0 ? { items } : {}),
  };
}

async function promoteCanvasArtifactToStructuredOutput(
  db: QueryExecutor,
  input: {
    runId: string;
    canvasArtifactKey: string;
    structuredArtifactKey: string;
  },
) {
  const canvasRow = await db.query<{
    tenant_id: string;
    user_id: string;
    body: string;
    data_json: unknown;
    step_attempt_id: string | null;
  }>(
    `SELECT tenant_id, user_id, body, data_json, step_attempt_id
     FROM loop_engine_artifacts
     WHERE run_id = $1 AND artifact_key = $2 AND kind = 'canvas_email' AND invalidated_at IS NULL
     ORDER BY version DESC
     LIMIT 1`,
    [input.runId, input.canvasArtifactKey],
  );
  const row = canvasRow.rows[0];
  if (!row) return;
  const data = asObject(row.data_json);
  const emailTemplate = asObject(data.emailTemplate);
  const text = typeof emailTemplate.text === "string" && emailTemplate.text.trim()
    ? emailTemplate.text.trim()
    : typeof emailTemplate.html === "string"
      ? emailTemplate.html
      : row.body;
  if (!text.trim()) return;
  const subject = typeof emailTemplate.subject === "string" && emailTemplate.subject.trim()
    ? emailTemplate.subject.trim()
    : deriveSubjectFromBody(text);
  const structuredOutput = {
    subject,
    body: text,
  };
  const dataJson = JSON.stringify({
    text,
    data: { structuredOutput },
    structuredOutput,
    promotedFromCanvas: input.canvasArtifactKey,
    emailTemplate,
  });

  await db.query(
    `INSERT INTO loop_engine_artifacts
     (tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json)
     SELECT $1, $2, $3, $4, $5,
            COALESCE(MAX(version), 0) + 1, 'structured_output', $6, $7::jsonb
     FROM loop_engine_artifacts WHERE run_id = $3 AND artifact_key = $5`,
    [
      row.tenant_id,
      row.user_id,
      input.runId,
      row.step_attempt_id,
      input.structuredArtifactKey,
      text,
      dataJson,
    ],
  );
}

function isAffirmativeGateInput(value: Record<string, unknown>) {
  const raw = typeof value.value === "string"
    ? value.value
    : typeof value.text === "string"
      ? value.text
      : "";
  return /\b(yes|yep|yeah|approve|approved|go ahead|looks good|proceed|continue|ship|use it|ok|okay)\b/i.test(raw.trim());
}

async function persistArtifact(input: {
  command: CommandRow;
  attemptId: string;
  artifactKey: string;
  kind: string;
  body: string;
  data: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO loop_engine_artifacts
     (tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json)
     SELECT $1, $2, $3, $4, $5,
            COALESCE(MAX(version), 0) + 1, $6, $7, $8::jsonb
     FROM loop_engine_artifacts WHERE run_id = $3 AND artifact_key = $5`,
    [
      input.command.tenant_id,
      input.command.user_id,
      input.command.run_id,
      input.attemptId,
      input.artifactKey,
      input.kind,
      input.body,
      JSON.stringify(input.data),
    ],
  );
}

type QueryExecutor = Pick<typeof pool, "query">;

function canvasPreviewArtifactKeys(artifactKey: string) {
  const keys = new Set([artifactKey]);
  keys.add(artifactKey.replace(/:canvas\.preview$/, ":canvas.email"));
  return [...keys];
}

async function markCanvasArtifactPreview(
  db: QueryExecutor,
  input: {
    runId: string;
    artifactKey: string;
  },
) {
  const previewState = JSON.stringify({ canvas_state: "preview" });
  for (const artifactKey of canvasPreviewArtifactKeys(input.artifactKey)) {
    await db.query(
      `UPDATE loop_engine_artifacts
       SET data_json = data_json || $1::jsonb
       WHERE run_id = $2 AND artifact_key = $3 AND kind IN ('canvas_email', 'canvas_preview') AND invalidated_at IS NULL`,
      [previewState, input.runId, artifactKey],
    );
  }
}

async function queueNextStep(command: CommandRow, definition: RuntimeDefinition, currentStep: number) {
  const nextIndex = currentStep + 1;
  const nextAgent = definition.agentGraph!.children[nextIndex];
  if (!nextAgent) {
    await enqueueCommand({
      tenantId: command.tenant_id,
      userId: command.user_id,
      runId: command.run_id,
      commandType: "finalize_run",
      idempotencyKey: `run:${command.run_id}:finalize`,
    });
    return;
  }
  const attemptId = await createAttempt({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepIndex: nextIndex,
    agent: nextAgent,
    attempt: 1,
  });
  await pool.query(
    `UPDATE loop_engine_runs SET status = 'running', current_step_index = $2, updated_at = NOW() WHERE id = $1`,
    [command.run_id, nextIndex],
  );
  await enqueueCommand({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepAttemptId: attemptId,
    commandType: "execute_step",
    idempotencyKey: `attempt:${attemptId}:execute`,
  });
}

async function resolveRunUserProfile(input: {
  tenantId: string;
  userId: string;
  definition: RuntimeDefinition;
  context: RuntimeContext;
  runId: string;
}): Promise<RuntimeContext> {
  const rawCached = input.context.userProfile ?? input.definition.builderMeta?.workflowUserProfile ?? null;
  const cached = rawCached ? sanitizeWorkflowUserProfile(rawCached) : null;
  if (cached) {
    if (!input.context.userProfile || cached.profileText !== input.context.userProfile.profileText) {
      const nextContext = runtimeContextSchema.parse({ ...input.context, userProfile: cached });
      await pool.query(
        `UPDATE loop_engine_runs SET context_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [input.runId, JSON.stringify(nextContext)],
      );
      return nextContext;
    }
    return input.context;
  }
  const contextWithoutStaleProfile = input.context.userProfile
    ? runtimeContextSchema.parse({ ...input.context, userProfile: undefined })
    : input.context;
  const loaded = await loadWorkflowUserProfile({
    tenantId: input.tenantId,
    userId: input.userId,
    authMode: "internal",
    plan: "pro",
  }).catch(() => null);
  if (!loaded) {
    if (contextWithoutStaleProfile !== input.context) {
      await pool.query(
        `UPDATE loop_engine_runs SET context_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [input.runId, JSON.stringify(contextWithoutStaleProfile)],
      );
    }
    return contextWithoutStaleProfile;
  }
  const nextContext = runtimeContextSchema.parse({ ...contextWithoutStaleProfile, userProfile: loaded });
  await pool.query(
    `UPDATE loop_engine_runs SET context_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [input.runId, JSON.stringify(nextContext)],
  );
  return nextContext;
}

async function handleExecuteStep(command: CommandRow) {
  if (!command.step_attempt_id) throw new Error("execute_step command has no attempt");
  const result = await pool.query<{
    run_status: string;
    definition_snapshot: unknown;
    context_json: unknown;
    workflow_id: string;
    workflow_title: string;
    attempt_status: string;
    step_index: number;
    agent_snapshot: unknown;
    attempt: number;
  }>(
    `SELECT r.status AS run_status, r.definition_snapshot, r.context_json, r.workflow_id,
            w.title AS workflow_title, a.status AS attempt_status, a.step_index, a.agent_snapshot, a.attempt
     FROM loop_engine_step_attempts a
     JOIN loop_engine_runs r ON r.id = a.run_id
     JOIN workflows w ON w.id = r.workflow_id
     WHERE a.id = $1 LIMIT 1`,
    [command.step_attempt_id],
  );
  const row = result.rows[0];
  if (!row || row.run_status === "cancelled" || row.attempt_status !== "queued") return;
  const definition = runtimeDefinitionSchema.parse(row.definition_snapshot);
  let context = runtimeContextSchema.parse(row.context_json);
  context = await resolveRunUserProfile({
    tenantId: command.tenant_id,
    userId: command.user_id,
    definition,
    context,
    runId: command.run_id,
  });
  const agent = loopRunAgentSchema.parse(row.agent_snapshot);

  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'running', lease_owner = $2, lease_expires_at = NOW() + INTERVAL '60 seconds',
         heartbeat_at = NOW(), started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [command.step_attempt_id, workerId],
  );

  const artifactRows = await pool.query<{
    artifact_key: string;
    kind: string;
    body: string;
    data_json: unknown;
    step_index: number;
    agent_id: string;
    created_at: string;
    version: number;
  }>(
    `SELECT a.artifact_key, a.kind, a.body, a.data_json, s.step_index, s.agent_id, a.created_at, a.version
     FROM loop_engine_artifacts a
     JOIN loop_engine_step_attempts s ON s.id = a.step_attempt_id
     WHERE a.run_id = $1
       AND a.invalidated_at IS NULL
       AND a.kind NOT IN ('canvas_email', 'canvas_preview')
       AND s.step_index < $2
     ORDER BY a.created_at ASC, a.version ASC, a.id ASC`,
    [command.run_id, row.step_index],
  );
  const latestArtifactRows = selectLatestArtifactsByKey(artifactRows.rows);
  const priorOutputs = buildPriorOutputIndex({
    artifacts: latestArtifactRows.map((artifact) => {
      const structuredOutput = extractStructuredOutputFromArtifact(artifact.data_json, artifact.body);
      return {
        artifact_key: artifact.artifact_key,
        agent_id: artifact.agent_id,
        envelope: {
          artifactId: artifact.artifact_key,
          kind: artifact.kind,
          stepIndex: artifact.step_index,
          body: compactArtifactBody(artifact.body),
          data: compactArtifactData(artifact.data_json),
          // Preserve the small structured output un-truncated so connector bindings
          // (e.g. gmail /subject, /body) resolve even when data_json is compacted.
          ...(structuredOutput ? { structuredOutput } : {}),
        },
      };
    }),
    children: definition.agentGraph?.children ?? [],
  });
  const agentHandoff = {
    ...buildAgentHandoff(agent, runMemoryFromContext(context), priorOutputs, {
      userProfile: context.userProfile ?? definition.builderMeta?.workflowUserProfile ?? null,
    }),
    ...(agent.handoffBindings.length > 0
      ? resolveAgentHandoffBindings({
        agent,
        priorOutputs,
        operatorInputs: resolvedRuntimeInputs(definition, context),
        stableConfig: asObject(agent.tools[0]?.config),
      }).value
      : {}),
  };
  const priorComments = latestArtifactRows.map((artifact) => ({
    author: artifact.artifact_key,
    body: compactArtifactBody(artifact.body),
  }));

  if (isTypedOperatorWorkflow(definition)) {
    if (await openRequirementCheckpoint({
      command,
      attemptId: command.step_attempt_id,
      stepIndex: row.step_index,
      agent,
      definition,
      context,
      when: "run_start",
    })) return;
    if (await openRequirementCheckpoint({
      command,
      attemptId: command.step_attempt_id,
      stepIndex: row.step_index,
      agent,
      definition,
      context,
      when: "before_step",
    })) return;
  }

  if (agent.tools.some((tool) => tool.ref === "internal.operator_input")) {
    if (await openRequirementCheckpoint({
      command,
      attemptId: command.step_attempt_id,
      stepIndex: row.step_index,
      agent,
      definition,
      context,
      when: "before_send",
    })) return;
    const requirements = collectRequirements(definition)
      .filter((requirement) => requirement.when === "before_send" && isInputSurface(requirement.surface));
    const structuredOutput = Object.fromEntries(requirements.map((requirement) => [
      requirement.key,
      readRequirementValue(requirement, context),
    ]));
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'succeeded', output_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [command.step_attempt_id, JSON.stringify({ text: "Operator inputs collected.", data: { structuredOutput } })],
    );
    await persistArtifact({
      command,
      attemptId: command.step_attempt_id,
      artifactKey: agent.outputArtifactId ?? `${agent.id}_output`,
      kind: "structured_output",
      body: JSON.stringify(structuredOutput),
      data: { structuredOutput },
    });
    await queueNextStep(command, definition, row.step_index);
    return;
  }

  const connectorAction = approvedConnectorAction(definition, agent);
  if (connectorAction) {
    if (await openConnectorConnectionCheckpoint({
      command,
      attemptId: command.step_attempt_id,
      stepIndex: row.step_index,
      agent,
      definition,
      toolkit: connectorAction.toolkit,
      actionSlug: connectorAction.actionSlug,
      toolRef: connectorAction.assignment.ref,
    })) {
      return;
    }
    const assignmentConfig = asObject(connectorAction.assignment.config);
    if (connectorAction.requiresApproval && await openRequirementCheckpoint({
      command,
      attemptId: command.step_attempt_id,
      stepIndex: row.step_index,
      agent,
      definition,
      context,
      when: "before_send",
    })) {
      return;
    }
    let prepared: Awaited<ReturnType<typeof prepareConnectorActionPayload>>;
    try {
      prepared = await prepareConnectorActionPayload({
        agent,
        assignmentConfig,
        priorOutputs,
        definition,
        context,
        toolRef: connectorAction.assignment.ref,
      });
    } catch (error) {
      if (!(error instanceof ConnectorActionPayloadError)) throw error;
      await failConnectorActionStep({
        command,
        attemptId: command.step_attempt_id,
        message: `Compiled connector bindings could not produce a valid payload: ${connectorActionFailureMessage(error)}`,
        details: error.details,
        toolkit: connectorAction.toolkit,
        actionSlug: connectorAction.actionSlug,
      });
      return;
    }
    const payload = prepared.payload;
    const preparationDetails = connectorPayloadPreparationDetails(prepared);
    if (!connectorAction.requiresApproval) {
      const payloadHash = sha256Json(payload);
      const idempotencyKey = `run:${command.run_id}:step:${row.step_index}:read:${payloadHash}`;
      const result = await executeApprovedComposioAction({
        auth: {
          tenantId: command.tenant_id,
          userId: command.user_id,
          authMode: "internal",
          plan: "pro",
        },
        toolkit: connectorAction.toolkit,
        actionSlug: connectorAction.actionSlug,
        connectorAccountId: selectedConnectorAccountId(definition.buildContract, connectorAction.toolkit),
        payload,
        toolkitVersion: prepared.contract.toolkitVersion,
        idempotencyKey,
      });
      if (!result.ok) {
        await failConnectorActionStep({
          command,
          attemptId: command.step_attempt_id,
          message: result.error ?? `Connector action failed: ${connectorAction.toolkit}/${connectorAction.actionSlug}`,
          details: { result, ...preparationDetails, payloadHash },
          toolkit: connectorAction.toolkit,
          actionSlug: connectorAction.actionSlug,
        });
        return;
      }
      const outputValidation = outputValidationForResult(prepared.contract, result);
      if (!outputValidation.valid) {
        const message = `Connector output failed schema validation: ${outputValidation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`;
        await markConnectorActionEventFailed({
          auth: { tenantId: command.tenant_id, userId: command.user_id, authMode: "internal", plan: "pro" },
          idempotencyKey,
          error: message,
          details: { outputValidation, rawResponse: result.rawResponse ?? result.output },
        });
        await failConnectorActionStep({
          command,
          attemptId: command.step_attempt_id,
          message,
          details: { result, outputValidation, ...preparationDetails, payloadHash },
          toolkit: connectorAction.toolkit,
          actionSlug: connectorAction.actionSlug,
        });
        return;
      }
      await persistArtifact({
        command,
        attemptId: command.step_attempt_id,
        artifactKey: agent.outputArtifactId ?? `${agent.id}_connector_read`,
        kind: "connector_action_result",
        body: `Connector read completed: ${connectorAction.toolkit}/${connectorAction.actionSlug}`,
        data: asObject(sanitizeConnectorDetails({ result, outputValidation, ...preparationDetails })),
      });
      await pool.query(
        `UPDATE loop_engine_step_attempts
         SET status = 'succeeded', output_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [command.step_attempt_id, JSON.stringify(connectorStepOutput({
          message: `Connector read completed: ${connectorAction.toolkit}/${connectorAction.actionSlug}`,
          result: { ...result, outputValidation },
          prepared: preparationDetails,
          payloadHash,
        }))],
      );
      await insertEvent({
        tenantId: command.tenant_id,
        userId: command.user_id,
        runId: command.run_id,
        stepAttemptId: command.step_attempt_id,
        eventType: "connector_action_completed",
        payload: { toolkit: connectorAction.toolkit, actionSlug: connectorAction.actionSlug, readOnly: true },
      });
      await queueNextStep(command, definition, row.step_index);
      return;
    }
    const specSnapshot = definition.builderMeta?.noSlopSpec ?? null;
    const payloadHash = sha256Json(payload);
    const specHash = sha256Json(specSnapshot);
    const confirmInteraction = requirePlannedInteraction(
      definition,
      "confirm_action",
      (item) => item.actionNodeId === agent.id && item.contractRef === connectorAction.assignment.ref,
    );
    await createInteraction({
      command,
      attemptId: command.step_attempt_id,
      gateType: "confirm_action",
      question: agent.gate?.question ?? `Approve ${getLoopTool(connectorAction.assignment.ref)?.label ?? connectorAction.actionSlug}?`,
      payload: {
        kind: "connector_action",
        provider: "composio",
        toolkit: connectorAction.toolkit,
        actionSlug: connectorAction.actionSlug,
        toolRef: connectorAction.assignment.ref,
        actionRisk: connectorAction.policy.risk,
        delivery: definition.delivery ?? { provider: "none" },
        payload,
        payloadHash,
        specHash,
        noSlopSpecId: specSnapshot?.id ?? null,
        summary: summarizeConnectorActionPayload(payload),
        grillMeChecklist: specSnapshot?.specJson?.guardrails ?? [],
        contract: prepared.contract,
        payloadCompilation: preparationDetails.payloadCompilation,
        ...(confirmInteraction ? {
          operatorInteraction: {
            kind: "confirm_action",
            interactionId: confirmInteraction.id,
            actionNodeId: confirmInteraction.actionNodeId,
            contractRef: confirmInteraction.contractRef,
            effect: confirmInteraction.effect,
            sanitizedPayload: asObject(sanitizeConnectorDetails(payload)),
            payloadHash,
            validation: { valid: true, errors: [] },
          },
        } : {}),
      },
    });
    await pool.query(
      `UPDATE loop_engine_step_attempts SET output_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [command.step_attempt_id, JSON.stringify(connectorStepOutput({
        message: "Waiting for pre-send approval.",
        prepared: preparationDetails,
        payloadHash,
        specHash,
      }))],
    );
    return;
  }

  const agentResult = await runLoopAgent({
    auth: {
      tenantId: command.tenant_id,
      userId: command.user_id,
      authMode: "internal",
      plan: "pro",
    },
    goal: definition.goal,
    agent,
    assignedTools: agent.tools,
    draftPolicy: definition.draftPolicy,
    priorComments,
    agentHandoff,
    runId: command.run_id,
    workflowId: row.workflow_id,
    workflowTitle: row.workflow_title,
    definition,
  });
  const goalEval = await evaluateAgentGoal({
    agent,
    result: agentResult,
    definition,
    runMemory: runMemoryFromContext(context),
  });
  const output = { text: agentResult.text, data: agentResult.data, goalEval };
  if (agentResult.structuredOutput) {
    output.data = { ...output.data, structuredOutput: agentResult.structuredOutput };
  }

  if (goalEval.status === "fail") {
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'failed', output_json = $2::jsonb, error_json = $3::jsonb, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [command.step_attempt_id, JSON.stringify(output), JSON.stringify({ message: goalEval.reason })],
    );
    if (row.attempt < 3) {
      const retryId = await createAttempt({
        tenantId: command.tenant_id,
        userId: command.user_id,
        runId: command.run_id,
        stepIndex: row.step_index,
        agent,
        attempt: row.attempt + 1,
      });
      await enqueueCommand({
        tenantId: command.tenant_id,
        userId: command.user_id,
        runId: command.run_id,
        stepAttemptId: retryId,
        commandType: "retry_step",
        idempotencyKey: `attempt:${retryId}:retry`,
        notBefore: new Date(Date.now() + RETRY_DELAYS_MS[Math.min(row.attempt - 1, RETRY_DELAYS_MS.length - 1)]),
      });
      return;
    }
    await pool.query(
      `UPDATE loop_engine_runs SET status = 'blocked', error_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [command.run_id, JSON.stringify({ message: goalEval.reason, code: "goal_eval_failed" })],
    );
    return;
  }

  await pool.query(
    `UPDATE loop_engine_step_attempts SET output_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [command.step_attempt_id, JSON.stringify(output)],
  );
  await persistArtifact({
    command,
    attemptId: command.step_attempt_id,
    artifactKey: agent.outputArtifactId ?? `${agent.id}_output`,
    kind: "structured_output",
    body: agentResult.text,
    data: {
      ...output,
      artifactEnvelope: {
        contract: agent.outputContract,
        visibility: contractVisibility(agent.outputContract),
        renderer: contractRenderer(agent.outputContract),
        value: agentResult.structuredOutput ?? agentResult.text,
      },
    },
  });
  const declaredRenderer = contractRenderer(agent.outputContract);
  const canvasArtifactKey = declaredRenderer
    ? `${agent.outputArtifactId ?? `${agent.id}_output`}:${declaredRenderer}`
    : null;
  if (declaredRenderer && canvasArtifactKey) {
    const renderedValue = agentResult.structuredOutput
      ? JSON.stringify(agentResult.structuredOutput)
      : agentResult.text;
    const rendered = renderArtifact(declaredRenderer, contractMediaType(agent.outputContract), renderedValue);
    await persistArtifact({
      command,
      attemptId: command.step_attempt_id,
      artifactKey: canvasArtifactKey,
      kind: rendered.kind,
      body: rendered.body,
      data: { renderer: declaredRenderer, ...rendered.data },
    });
    if (rendered.marksPreview) {
      await markCanvasArtifactPreview(pool, { runId: command.run_id, artifactKey: canvasArtifactKey });
    }
  }

  const plannedReviewInteraction = findOperatorInteraction(
    definition.operatorInteractionPlan,
    "review_artifact",
    (item) => item.producerNodeId === agent.id && item.artifactId === agent.outputArtifactId,
  );
  if (goalEval.status === "needs_input") {
    if (goalEval.gateType === "memory_confirmation" || goalEval.gateType === "source_confirmation") {
      await openCurationReviewCheckpoint({
        command,
        attemptId: command.step_attempt_id,
        stepIndex: row.step_index,
        agent,
        gateType: goalEval.gateType,
        question: goalEval.reason,
        output,
        resultData: agentResult.data,
      });
      return;
    }
    if (!plannedReviewInteraction) {
      throw new Error(`Agent ${agent.id} requested an undeclared operator interaction.`);
    }
  }
  if (plannedReviewInteraction) {
    const gateType: OperatorInteractionKind = "review_artifact";
    const basePayload = {
      ...gatePayloadForResult(gateType, agent.id, row.step_index, output, agentResult.data),
      ...(canvasArtifactKey ? { renderTarget: declaredRenderer, canvasArtifactKey } : {}),
    };
    await createInteraction({
      command,
      attemptId: command.step_attempt_id,
      gateType,
      question: `Review ${plannedReviewInteraction.artifactId}.`,
      payload: {
        ...basePayload,
        operatorInteraction: {
          kind: "review_artifact",
          interactionId: plannedReviewInteraction.id,
          artifactId: plannedReviewInteraction.artifactId,
          rendererRef: plannedReviewInteraction.rendererRef,
          editable: plannedReviewInteraction.editable,
          producerNodeId: plannedReviewInteraction.producerNodeId,
          outputText: agentResult.text,
        },
      },
    });
    return;
  }

  await pool.query(
    `UPDATE loop_engine_step_attempts
     SET status = 'succeeded', finished_at = NOW(), lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [command.step_attempt_id],
  );
  await insertEvent({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepAttemptId: command.step_attempt_id,
    eventType: "step_succeeded",
    payload: { agentId: agent.id, stepIndex: row.step_index },
  });
  await queueNextStep(command, definition, row.step_index);
}

async function handleContinueAfterGate(command: CommandRow) {
  const payload = asObject(command.payload_json);
  const interactionId = typeof payload.interactionId === "string" ? payload.interactionId : null;
  if (!interactionId) throw new Error("continue_after_interaction command has no gate");
  const result = await pool.query<{
    interaction_kind: OperatorInteractionKind;
    status: string;
    payload_json: unknown;
    step_attempt_id: string;
    step_index: number;
    attempt: number;
    agent_snapshot: unknown;
    definition_snapshot: unknown;
    context_json: unknown;
  }>(
    `SELECT g.interaction_kind, g.status, g.payload_json, g.step_attempt_id, a.step_index, a.attempt,
            a.agent_snapshot, r.definition_snapshot, r.context_json
     FROM loop_engine_interactions g
     JOIN loop_engine_step_attempts a ON a.id = g.step_attempt_id
     JOIN loop_engine_runs r ON r.id = g.run_id
     WHERE g.id = $1 AND g.run_id = $2 LIMIT 1`,
    [interactionId, command.run_id],
  );
  const row = result.rows[0];
  if (!row) return;
  const definition = runtimeDefinitionSchema.parse(row.definition_snapshot);
  const context = runtimeContextSchema.parse(row.context_json);
  const agent = loopRunAgentSchema.parse(row.agent_snapshot);
  const gatePayload = asObject(row.payload_json);
  if (row.interaction_kind === "confirm_action") {
    if (row.status !== "approved") return;
    const payload = asObject(gatePayload.payload);
    const payloadHash = typeof gatePayload.payloadHash === "string" ? gatePayload.payloadHash : "";
    const specHash = typeof gatePayload.specHash === "string" ? gatePayload.specHash : "";
    if (!payloadHash || payloadHash !== sha256Json(payload)) {
      throw new Error("Approved connector action payload hash does not match current payload");
    }
    if (specHash !== sha256Json(definition.builderMeta?.noSlopSpec ?? null)) {
      throw new Error("Approved connector action spec hash does not match current workflow spec");
    }
    const connectorAction = approvedConnectorAction(definition, agent);
    if (!connectorAction) throw new Error("Approved connector action is no longer allowed by the workflow policy");
    const contract = asObject(gatePayload.contract);
    const idempotencyKey = `run:${command.run_id}:step:${row.step_index}:action:${payloadHash}`;
    try {
      const result = await executeApprovedComposioAction({
        auth: {
          tenantId: command.tenant_id,
          userId: command.user_id,
          authMode: "internal",
          plan: "pro",
        },
        toolkit: connectorAction.toolkit,
        actionSlug: connectorAction.actionSlug,
        connectorAccountId: selectedConnectorAccountId(definition.buildContract, connectorAction.toolkit),
        payload,
        toolkitVersion: typeof contract.toolkitVersion === "string" ? contract.toolkitVersion : undefined,
        idempotencyKey,
      });
      if (!result.ok) {
        await failConnectorActionStep({
          command,
          attemptId: row.step_attempt_id,
          message: result.error ?? `Connector action failed: ${connectorAction.toolkit}/${connectorAction.actionSlug}`,
          details: {
            toolRef: connectorAction.assignment.ref,
            toolkitVersion: contract.toolkitVersion,
            payload,
            payloadCompilation: gatePayload.payloadCompilation,
            result,
            payloadHash,
            specHash,
          },
          toolkit: connectorAction.toolkit,
          actionSlug: connectorAction.actionSlug,
        });
        return;
      }
      const outputValidation = outputValidationForResult({
        outputSchema: asObject(contract.outputSchema),
      }, result);
      if (!outputValidation.valid) {
        const message = `Connector output failed schema validation: ${outputValidation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`;
        await markConnectorActionEventFailed({
          auth: { tenantId: command.tenant_id, userId: command.user_id, authMode: "internal", plan: "pro" },
          idempotencyKey,
          error: message,
          details: { outputValidation, rawResponse: result.rawResponse ?? result.output },
        });
        await failConnectorActionStep({
          command,
          attemptId: row.step_attempt_id,
          message,
          details: { result, outputValidation, payload, payloadCompilation: gatePayload.payloadCompilation, payloadHash, specHash },
          toolkit: connectorAction.toolkit,
          actionSlug: connectorAction.actionSlug,
        });
        return;
      }
      const details = asObject(sanitizeConnectorDetails({
        toolRef: connectorAction.assignment.ref,
        toolkit: connectorAction.toolkit,
        actionSlug: connectorAction.actionSlug,
        toolkitVersion: contract.toolkitVersion,
        payload,
        payloadCompilation: gatePayload.payloadCompilation,
        result,
        outputValidation,
        payloadHash,
        specHash,
      }));
      await persistArtifact({
        command,
        attemptId: row.step_attempt_id,
        artifactKey: agent.outputArtifactId ?? `${agent.id}_connector_action`,
        kind: "connector_action_result",
        body: result.ok
          ? `Connector action completed: ${connectorAction.toolkit}/${connectorAction.actionSlug}`
          : `Connector action failed: ${connectorAction.toolkit}/${connectorAction.actionSlug}`,
        data: details,
      });
      await pool.query(
        `UPDATE loop_engine_step_attempts
         SET status = 'succeeded', output_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'waiting_for_interaction'`,
        [row.step_attempt_id, JSON.stringify(connectorStepOutput({
          message: `Connector action completed: ${connectorAction.toolkit}/${connectorAction.actionSlug}`,
          prepared: asObject(details),
          payloadHash,
          specHash,
        }))],
      );
      await insertEvent({
        tenantId: command.tenant_id,
        userId: command.user_id,
        runId: command.run_id,
        stepAttemptId: row.step_attempt_id,
        eventType: "connector_action_completed",
        payload: { toolkit: connectorAction.toolkit, actionSlug: connectorAction.actionSlug, payloadHash, replayed: result.replayed ?? false },
      });
      await queueNextStep(command, definition, row.step_index);
    } catch (error) {
      const message = connectorActionFailureMessage(error);
      await failConnectorActionStep({
        command,
        attemptId: row.step_attempt_id,
        message,
        details: {
          toolRef: connectorAction.assignment.ref,
          payload,
          payloadCompilation: gatePayload.payloadCompilation,
          payloadHash,
          specHash,
        },
        toolkit: connectorAction.toolkit,
        actionSlug: connectorAction.actionSlug,
      });
    }
    return;
  }
  const activeInteraction = activeOperatorInteractionSchema.safeParse(gatePayload.operatorInteraction);
  if (!activeInteraction.success) throw new Error("Interaction is missing typed operator state.");
  const continuation = activeInteraction.data.kind === "collect_input" || activeInteraction.data.kind === "connect_connector"
    ? "retry_step"
    : "complete_step";
  if (continuation === "retry_step") {
    await pool.query(
      `UPDATE loop_engine_step_attempts SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'waiting_for_interaction'`,
      [row.step_attempt_id],
    );
    const retryId = await createAttempt({
      tenantId: command.tenant_id,
      userId: command.user_id,
      runId: command.run_id,
      stepIndex: row.step_index,
      agent,
      attempt: row.attempt + 1,
    });
    await pool.query(
      `UPDATE loop_engine_runs SET status = 'running', current_step_index = $2, updated_at = NOW() WHERE id = $1`,
      [command.run_id, row.step_index],
    );
    await enqueueCommand({
      tenantId: command.tenant_id,
      userId: command.user_id,
      runId: command.run_id,
      stepAttemptId: retryId,
      commandType: "execute_step",
      idempotencyKey: `attempt:${retryId}:execute`,
    });
    return;
  }
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'succeeded', finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'waiting_for_interaction'`,
    [row.step_attempt_id],
  );
  await queueNextStep(command, definition, row.step_index);
}

async function handleFinalizeRun(command: CommandRow) {
  const pending = await pool.query(
    `SELECT id FROM loop_engine_interactions WHERE run_id = $1 AND status = 'pending' LIMIT 1`,
    [command.run_id],
  );
  if (pending.rows[0]) throw new Error("Cannot finalize a run with a pending gate");
  const reviewedArtifacts = await pool.query<{ canvas_artifact_key: string | null }>(
    `SELECT DISTINCT payload_json->>'canvasArtifactKey' AS canvas_artifact_key
     FROM loop_engine_interactions
     WHERE run_id = $1
       AND status = 'approved'
       AND payload_json ? 'canvasArtifactKey'`,
    [command.run_id],
  );
  for (const row of reviewedArtifacts.rows) {
    if (row.canvas_artifact_key) {
      await markCanvasArtifactPreview(pool, {
        runId: command.run_id,
        artifactKey: row.canvas_artifact_key,
      });
    }
  }
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'succeeded', finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status IN ('running', 'waiting_for_interaction')`,
    [command.run_id],
  );
  await insertEvent({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    eventType: "run_succeeded",
  });

  try {
    const runRow = await pool.query<{
      workflow_id: string;
      context_json: unknown;
      title: string;
      workspace_id: string | null;
    }>(
      `SELECT r.workflow_id, r.context_json, w.title, w.workspace_id
       FROM loop_engine_runs r
       JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = $1
       LIMIT 1`,
      [command.run_id],
    );
    const row = runRow.rows[0];
    if (row?.workspace_id) {
      const context = runtimeContextSchema.parse(asObject(row.context_json));
      const artifactRows = await pool.query<{ body: string | null }>(
        `SELECT body
         FROM loop_engine_artifacts
         WHERE run_id = $1
           AND body IS NOT NULL
           AND invalidated_at IS NULL
         ORDER BY created_at DESC
         LIMIT 2`,
        [command.run_id],
      );
      const auth: AuthContext = {
        tenantId: command.tenant_id,
        userId: command.user_id,
        authMode: "internal",
        plan: "free",
        workspaceId: row.workspace_id,
      };
      await persistLoopRunWorkspaceMemory(auth, {
        workflowId: row.workflow_id,
        runId: command.run_id,
        workflowTitle: row.title,
        approvedMemories: context.approvedMemories,
        artifactTexts: artifactRows.rows
          .map((artifact) => artifact.body ?? "")
          .filter((text) => text.trim().length > 0),
      });
    }
  } catch {
    // Inter-loop memory persistence must not block run finalization.
  }
}

async function handleRetryStep(command: CommandRow) {
  if (!command.step_attempt_id) throw new Error("retry_step command has no attempt");
  await pool.query(
    `UPDATE loop_engine_runs SET status = 'running', updated_at = NOW() WHERE id = $1 AND status <> 'cancelled'`,
    [command.run_id],
  );
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'queued', updated_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [command.step_attempt_id],
  );
  await enqueueCommand({
    tenantId: command.tenant_id,
    userId: command.user_id,
    runId: command.run_id,
    stepAttemptId: command.step_attempt_id,
    commandType: "execute_step",
    idempotencyKey: `attempt:${command.step_attempt_id}:execute`,
  });
}

async function processCommand(command: CommandRow) {
  if (command.command_type === "start_run") return handleStartRun(command);
  if (command.command_type === "execute_step") return handleExecuteStep(command);
  if (command.command_type === "continue_after_interaction") return handleContinueAfterGate(command);
  if (command.command_type === "finalize_run") return handleFinalizeRun(command);
  return handleRetryStep(command);
}

async function claimCommand(): Promise<CommandRow | null> {
  const result = await pool.query<CommandRow>(
    `WITH candidate AS (
       SELECT id FROM loop_engine_commands
       WHERE status = 'pending' AND not_before <= NOW()
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE loop_engine_commands c
     SET status = 'processing', attempts = attempts + 1, lease_owner = $1,
         lease_expires_at = NOW() + INTERVAL '60 seconds', updated_at = NOW()
     FROM candidate
     WHERE c.id = candidate.id
     RETURNING c.*`,
    [workerId],
  );
  return result.rows[0] ?? null;
}

export async function dispatchLoopRuntimeCommands(limit = 10) {
  await pool.query(
    `UPDATE loop_engine_step_attempts a
     SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
     FROM loop_engine_commands c
     WHERE c.step_attempt_id = a.id
       AND c.command_type IN ('execute_step', 'retry_step')
       AND c.status = 'processing'
       AND c.lease_expires_at < NOW()
       AND a.status = 'running'`,
  );
  await pool.query(
    `UPDATE loop_engine_commands
     SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
     WHERE status = 'processing' AND lease_expires_at < NOW()`,
  );
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const command = await claimCommand();
    if (!command) break;
    try {
      await processCommand(command);
      await pool.query(
        `UPDATE loop_engine_commands
         SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $1`,
        [command.id],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retry = isRetryableError(error) && command.attempts < command.max_attempts;
      await pool.query(
        `UPDATE loop_engine_commands
         SET status = $2, last_error = $3, lease_owner = NULL, lease_expires_at = NULL,
             not_before = CASE WHEN $2 = 'pending' THEN NOW() + INTERVAL '10 seconds' ELSE not_before END,
             updated_at = NOW()
         WHERE id = $1`,
        [command.id, retry ? "pending" : "failed", message],
      );
      if (retry && command.step_attempt_id) {
        await pool.query(
          `UPDATE loop_engine_step_attempts
           SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
           WHERE id = $1 AND status = 'running'`,
          [command.step_attempt_id],
        );
      }
      if (!retry) {
        if (command.step_attempt_id) {
          await pool.query(
            `UPDATE loop_engine_step_attempts
             SET status = 'failed', error_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND status IN ('queued', 'running')`,
            [command.step_attempt_id, JSON.stringify({ message, commandId: command.id })],
          );
        }
        await pool.query(
          `UPDATE loop_engine_runs SET status = 'failed', error_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status <> 'cancelled'`,
          [command.run_id, JSON.stringify({ message, commandId: command.id })],
        );
      }
    }
  }
  return { processed };
}

export async function getLoopRuntimeProjection(auth: AuthContext, runId: string) {
  const runResult = await pool.query(
    `SELECT r.*, w.title AS workflow_title
     FROM loop_engine_runs r JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1 AND r.tenant_id = $2 AND r.user_id = $3 LIMIT 1`,
    [runId, auth.tenantId, auth.userId],
  );
  const run = runResult.rows[0];
  if (!run) throw new Error("Loop run not found");
  const [steps, interactions, artifacts, events] = await Promise.all([
    pool.query(`SELECT * FROM loop_engine_step_attempts WHERE run_id = $1 ORDER BY step_index, attempt`, [runId]),
    pool.query(`SELECT * FROM loop_engine_interactions WHERE run_id = $1 ORDER BY created_at`, [runId]),
    pool.query(`SELECT * FROM loop_engine_artifacts WHERE run_id = $1 ORDER BY created_at`, [runId]),
    pool.query(`SELECT * FROM loop_engine_events WHERE run_id = $1 ORDER BY created_at, id`, [runId]),
  ]);
  const operatorView = projectOperatorView({
    status: run.status,
    interactions: interactions.rows,
  });
  return {
    ...run,
    definition: run.definition_snapshot,
    context: run.context_json,
    steps: steps.rows,
    interactions: interactions.rows,
    artifacts: artifacts.rows,
    events: events.rows,
    operatorView,
  };
}

export async function listLoopRuntimeRuns(auth: AuthContext, workflowId: string) {
  const result = await pool.query(
    `SELECT id, workflow_id, status, current_step_index, error_json, started_at, finished_at, created_at, updated_at
     FROM loop_engine_runs
     WHERE workflow_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY created_at DESC LIMIT 50`,
    [workflowId, auth.tenantId, auth.userId],
  );
  return result.rows;
}

export async function executeLoopRuntimeInteractionCommand(input: {
  auth: AuthContext;
  runId: string;
  interactionId: string;
  decision: "approve" | "input" | "reject";
  value: Record<string, unknown>;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const gateResult = await client.query<{
      id: string;
      status: string;
      interaction_kind: OperatorInteractionKind;
      decision_json: unknown;
      payload_json: unknown;
      definition_snapshot: unknown;
      context_json: unknown;
      tenant_id: string;
      user_id: string;
    }>(
      `SELECT g.id, g.status, g.interaction_kind, g.decision_json, g.payload_json, r.definition_snapshot, r.context_json, r.tenant_id, r.user_id
       FROM loop_engine_interactions g JOIN loop_engine_runs r ON r.id = g.run_id
       WHERE g.id = $1 AND g.run_id = $2 AND r.tenant_id = $3 AND r.user_id = $4
       FOR UPDATE`,
      [input.interactionId, input.runId, input.auth.tenantId, input.auth.userId],
    );
    const gate = gateResult.rows[0];
    if (!gate) throw new Error("Loop gate not found");
    if (gate.status !== "pending") {
      await client.query("COMMIT");
      return { runId: input.runId, interactionId: input.interactionId, status: gate.status, decision: gate.decision_json };
    }
    const gatePayload = asObject(gate.payload_json);
    const activeInteraction = activeOperatorInteractionSchema.safeParse(gatePayload.operatorInteraction);
    if (activeInteraction.success) {
      const allowed = activeInteraction.data.kind === "collect_input" || activeInteraction.data.kind === "connect_connector"
        ? new Set(["input"])
        : new Set(["approve", "reject"]);
      if (!allowed.has(input.decision)) {
        throw new Error(`Operator command ${input.decision} is not allowed for ${activeInteraction.data.kind}.`);
      }
    }
    const decision = input.decision;
    if (decision === "reject") {
      await client.query(
        `UPDATE loop_engine_interactions SET status = 'rejected', decision_json = $2::jsonb, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [input.interactionId, JSON.stringify(input.value)],
      );
      await client.query(
        `UPDATE loop_engine_runs SET status = 'blocked', error_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [input.runId, JSON.stringify({ message: "Interaction rejected", interactionId: input.interactionId })],
      );
      await client.query(
        `UPDATE loop_engine_step_attempts
         SET status = 'failed', error_json = $2::jsonb, finished_at = NOW(), updated_at = NOW()
         WHERE id = (SELECT step_attempt_id FROM loop_engine_interactions WHERE id = $1)
           AND status = 'waiting_for_interaction'`,
        [input.interactionId, JSON.stringify({ message: "Interaction rejected", interactionId: input.interactionId })],
      );
      await client.query("COMMIT");
      return { runId: input.runId, interactionId: input.interactionId, status: "rejected" };
    }
    const definition = runtimeDefinitionSchema.parse(gate.definition_snapshot);
    const currentContext = runtimeContextSchema.parse(gate.context_json);
    let deliveryRecipients = currentContext.deliveryRecipients;
    if (deliveryRecipients?.contacts.length && !deliveryRecipients.documentRef) {
      const docRefs = await stashContactListAsDocument({
        auth: input.auth,
        contacts: deliveryRecipients.contacts,
        titleHint: definition.goal || definition.builderMeta?.noSlopSpec?.title,
        runId: input.runId,
      });
      deliveryRecipients = buildDeliveryRecipientsPatch({
        contacts: deliveryRecipients.contacts,
        source: deliveryRecipients.source ?? "uploaded",
        audienceId: deliveryRecipients.audienceId,
        documentRef: docRefs.documentRef,
        lotRef: docRefs.lotRef,
      });
    }
    const nextContext = runtimeContextSchema.parse({
      inputs: currentContext.inputs,
      approvedMemories: currentContext.approvedMemories,
      approvedSources: currentContext.approvedSources,
      operatorRevisions: currentContext.operatorRevisions,
      deliveryRecipients,
      ...applyGateDecisionToRunMemory({
        gateType: typeof gatePayload.gateType === "string"
          ? gatePayload.gateType as "memory_confirmation" | "source_confirmation" | "pre_send" | "missing_input" | "draft_review"
          : "draft_review",
        decision: input.value,
        definition,
        gateAgentId: typeof gatePayload.agentId === "string" ? gatePayload.agentId : undefined,
      }),
    });
    const status = decision === "input" ? "submitted" : "approved";
    await client.query(
      `UPDATE loop_engine_interactions SET status = $2, decision_json = $3::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [input.interactionId, status, JSON.stringify(input.value)],
    );
    if (decision === "approve") {
      const canvasArtifactKey = typeof gatePayload.canvasArtifactKey === "string" ? gatePayload.canvasArtifactKey : null;
      if (canvasArtifactKey) {
        await markCanvasArtifactPreview(client, {
          runId: input.runId,
          artifactKey: canvasArtifactKey,
        });
        if (gate.interaction_kind === "review_artifact") {
          await promoteCanvasArtifactToStructuredOutput(client, {
            runId: input.runId,
            canvasArtifactKey,
            structuredArtifactKey: canvasArtifactKey.replace(/:canvas\.email$/, ""),
          });
        }
      }
    }
    await client.query(
      `UPDATE loop_engine_runs SET context_json = $2::jsonb, status = 'running', updated_at = NOW() WHERE id = $1`,
      [input.runId, JSON.stringify(nextContext)],
    );
    await client.query(
      `INSERT INTO loop_engine_commands
       (tenant_id, user_id, run_id, command_type, idempotency_key, payload_json)
       VALUES ($1, $2, $3, 'continue_after_interaction', $4, $5::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [gate.tenant_id, gate.user_id, input.runId, `gate:${input.interactionId}:continue`, JSON.stringify({ interactionId: input.interactionId })],
    );
    await client.query("COMMIT");
    return { runId: input.runId, interactionId: input.interactionId, status };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function submitLoopRuntimeInteractionInputs(input: {
  auth: AuthContext;
  runId: string;
  interactionId: string;
  values: Record<string, SurfaceSubmissionValue>;
}) {
  const parsedValues = gateSurfaceSubmissionSchema.parse(input.values);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const gateResult = await client.query<{
      id: string;
      status: string;
      interaction_kind: OperatorInteractionKind;
      payload_json: unknown;
      definition_snapshot: unknown;
      context_json: unknown;
      tenant_id: string;
      user_id: string;
      step_attempt_id: string;
    }>(
      `SELECT g.id, g.status, g.interaction_kind, g.payload_json, r.definition_snapshot, r.context_json, r.tenant_id, r.user_id, g.step_attempt_id
       FROM loop_engine_interactions g JOIN loop_engine_runs r ON r.id = g.run_id
       WHERE g.id = $1 AND g.run_id = $2 AND r.tenant_id = $3 AND r.user_id = $4
       FOR UPDATE`,
      [input.interactionId, input.runId, input.auth.tenantId, input.auth.userId],
    );
    const gate = gateResult.rows[0];
    if (!gate) throw new Error("Loop gate not found");
    if (gate.status !== "pending") {
      await client.query("COMMIT");
      return { runId: input.runId, interactionId: input.interactionId, status: gate.status, satisfied: false };
    }

    const definition = runtimeDefinitionSchema.parse(gate.definition_snapshot);
    const currentContext = runtimeContextSchema.parse(gate.context_json);
    const gatePayload = asObject(gate.payload_json);
    const activeInteraction = activeOperatorInteractionSchema.safeParse(gatePayload.operatorInteraction);
    if (activeInteraction.success
      && activeInteraction.data.kind !== "collect_input"
      && activeInteraction.data.kind !== "connect_connector") {
      throw new Error(`Operator input submission is not allowed for ${activeInteraction.data.kind}.`);
    }
    if (gate.interaction_kind === "confirm_action") {
      let nextContext = applyGateSurfaceSubmission({
        definition,
        context: currentContext,
        values: parsedValues,
      });
      const deliveryRecipients = nextContext.deliveryRecipients;
      if (deliveryRecipients?.contacts.length && !deliveryRecipients.documentRef) {
        const docRefs = await stashContactListAsDocument({
          auth: input.auth,
          contacts: deliveryRecipients.contacts,
          titleHint: definition.goal || definition.builderMeta?.noSlopSpec?.title,
          runId: input.runId,
        });
        nextContext = runtimeContextSchema.parse({
          ...nextContext,
          deliveryRecipients: buildDeliveryRecipientsPatch({
            contacts: deliveryRecipients.contacts,
            source: deliveryRecipients.source ?? "uploaded",
            audienceId: deliveryRecipients.audienceId,
            documentRef: docRefs.documentRef,
            lotRef: docRefs.lotRef,
          }),
        });
      }
      await client.query(
        `UPDATE loop_engine_runs SET context_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [input.runId, JSON.stringify(nextContext)],
      );
      await client.query("COMMIT");
      const recipientCount = nextContext.deliveryRecipients?.recipientCount
        ?? nextContext.deliveryRecipients?.contacts.length
        ?? 0;
      const satisfied = recipientCount > 0 || Boolean(nextContext.deliveryRecipients?.audienceId?.trim());
      return {
        runId: input.runId,
        interactionId: input.interactionId,
        status: "pending",
        satisfied,
      };
    }

    let nextContext = applyGateSurfaceSubmission({
      definition,
      context: currentContext,
      values: parsedValues,
    });

    const deliveryRecipients = nextContext.deliveryRecipients;
    if (deliveryRecipients?.contacts.length && !deliveryRecipients.documentRef) {
      const docRefs = await stashContactListAsDocument({
        auth: input.auth,
        contacts: deliveryRecipients.contacts,
        titleHint: definition.goal || definition.builderMeta?.noSlopSpec?.title,
        runId: input.runId,
      });
      nextContext = runtimeContextSchema.parse({
        ...nextContext,
        deliveryRecipients: buildDeliveryRecipientsPatch({
          contacts: deliveryRecipients.contacts,
          source: deliveryRecipients.source ?? "uploaded",
          audienceId: deliveryRecipients.audienceId,
          documentRef: docRefs.documentRef,
          lotRef: docRefs.lotRef,
        }),
      });
    }

    await client.query(
      `UPDATE loop_engine_runs SET context_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [input.runId, JSON.stringify(nextContext)],
    );

    const plannedKeys = activeInteraction.success && activeInteraction.data.kind === "collect_input"
      ? new Set(activeInteraction.data.items.map((item) => item.requiredValueKey))
      : null;
    const remaining = evaluateExecutionBlockingAt(definition, nextContext, "run_start")
      .filter((row) => !plannedKeys || plannedKeys.has(row.requirement.key));
    if (remaining.length > 0) {
      const updatedPayload = {
        when: gatePayload.when ?? "run_start",
        agentId: typeof gatePayload.agentId === "string" ? gatePayload.agentId : undefined,
        stepIndex: typeof gatePayload.stepIndex === "number" ? gatePayload.stepIndex : undefined,
        operatorInteraction: activeInteraction.success && activeInteraction.data.kind === "collect_input"
          ? {
              ...activeInteraction.data,
              items: activeInteraction.data.items.map((item) => ({
                ...item,
                satisfied: isRequirementSatisfied(
                  collectRequirements(definition).find((requirement) => requirement.key === item.requiredValueKey)!,
                  nextContext,
                  definition,
                ).satisfied,
              })),
            }
          : undefined,
      };
      await client.query(
        `UPDATE loop_engine_interactions SET payload_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [input.interactionId, JSON.stringify(updatedPayload)],
      );
      await client.query("COMMIT");
      return {
        runId: input.runId,
        interactionId: input.interactionId,
        status: "pending",
        satisfied: false,
        pendingKeys: remaining.map((row) => row.requirement.key),
      };
    }

    await client.query(
      `UPDATE loop_engine_interactions SET status = 'submitted', decision_json = $2::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [input.interactionId, JSON.stringify({ values: parsedValues })],
    );
    await client.query(
      `UPDATE loop_engine_runs SET status = 'running', updated_at = NOW() WHERE id = $1`,
      [input.runId],
    );
    await client.query(
      `INSERT INTO loop_engine_commands
       (tenant_id, user_id, run_id, command_type, idempotency_key, payload_json)
       VALUES ($1, $2, $3, 'continue_after_interaction', $4, $5::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [gate.tenant_id, gate.user_id, input.runId, `gate:${input.interactionId}:continue`, JSON.stringify({ interactionId: input.interactionId })],
    );
    await client.query("COMMIT");
    return { runId: input.runId, interactionId: input.interactionId, status: "submitted", satisfied: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function uploadLoopRuntimeInteractionContacts(input: {
  auth: AuthContext;
  runId: string;
  interactionId: string;
  csvText?: string;
  contacts?: LoopContactRow[];
  audienceId?: string;
}) {
  const contacts = input.contacts?.length
    ? input.contacts
    : input.csvText?.trim()
      ? parseContactListCsv(input.csvText)
      : [];
  if (contacts.length === 0 && !input.audienceId?.trim()) {
    throw new Error("Provide csvText, contacts, or audienceId.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const gateResult = await client.query<{
      interaction_kind: OperatorInteractionKind;
      status: string;
      payload_json: unknown;
      context_json: unknown;
      definition_snapshot: unknown;
      workflow_title: string;
    }>(
      `SELECT g.interaction_kind, g.status, g.payload_json, r.context_json, r.definition_snapshot, w.title AS workflow_title
       FROM loop_engine_interactions g
       JOIN loop_engine_runs r ON r.id = g.run_id
       JOIN workflows w ON w.id = r.workflow_id
       WHERE g.id = $1 AND g.run_id = $2 AND r.tenant_id = $3 AND r.user_id = $4
       FOR UPDATE`,
      [input.interactionId, input.runId, input.auth.tenantId, input.auth.userId],
    );
    const gate = gateResult.rows[0];
    if (!gate) throw new Error("Loop gate not found");
    if (gate.interaction_kind !== "collect_input") {
      throw new Error("Contacts can only be uploaded for collect_input interactions.");
    }

    const definition = runtimeDefinitionSchema.parse(gate.definition_snapshot);
    const currentContext = runtimeContextSchema.parse(gate.context_json);
    const docRefs = contacts.length > 0
      ? await stashContactListAsDocument({
          auth: input.auth,
          contacts,
          csvText: input.csvText,
          titleHint: gate.workflow_title || definition.goal,
          runId: input.runId,
        })
      : null;
    const deliveryRecipients = contacts.length > 0
      ? buildDeliveryRecipientsPatch({
          contacts,
          source: "uploaded",
          audienceId: input.audienceId?.trim() || undefined,
          documentRef: docRefs?.documentRef,
          lotRef: docRefs?.lotRef,
        })
      : buildDeliveryRecipientsPatch({
          contacts: currentContext.deliveryRecipients?.contacts ?? [],
          source: "configured",
          audienceId: input.audienceId!.trim(),
        });

    const nextContext = runtimeContextSchema.parse({
      ...currentContext,
      deliveryRecipients,
    });
    await client.query(
      `UPDATE loop_engine_runs SET context_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [input.runId, JSON.stringify(nextContext)],
    );
    await client.query("COMMIT");
    return {
      runId: input.runId,
      interactionId: input.interactionId,
      recipientCount: deliveryRecipients.recipientCount,
      preview: deliveryRecipients.contacts.slice(0, 5),
      audienceId: deliveryRecipients.audienceId ?? null,
      documentRef: deliveryRecipients.documentRef ?? null,
      lotRef: deliveryRecipients.lotRef ?? null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reviseLoopRuntimeInteraction(input: {
  auth: AuthContext;
  runId: string;
  interactionId: string;
  value: Record<string, unknown>;
}) {
  const client = await pool.connect();
  let retryAttemptId: string | null = null;
  let tenantId = "";
  let userId = "";
  let retryAgent: LoopRunAgent | null = null;
  let retryStepIndex = 0;
  let retryAttemptNumber = 0;
  try {
    await client.query("BEGIN");
    const gateResult = await client.query<{
      id: string;
      status: string;
      payload_json: unknown;
      definition_snapshot: unknown;
      context_json: unknown;
      tenant_id: string;
      user_id: string;
      step_attempt_id: string;
      step_index: number;
      attempt: number;
      agent_snapshot: unknown;
    }>(
      `SELECT g.id, g.status, g.payload_json, r.definition_snapshot, r.context_json, r.tenant_id, r.user_id,
              g.step_attempt_id, a.step_index, a.attempt, a.agent_snapshot
       FROM loop_engine_interactions g
       JOIN loop_engine_runs r ON r.id = g.run_id
       JOIN loop_engine_step_attempts a ON a.id = g.step_attempt_id
       WHERE g.id = $1 AND g.run_id = $2 AND r.tenant_id = $3 AND r.user_id = $4
       FOR UPDATE`,
      [input.interactionId, input.runId, input.auth.tenantId, input.auth.userId],
    );
    const gate = gateResult.rows[0];
    if (!gate) throw new Error("Loop gate not found");
    if (gate.status !== "pending") {
      await client.query("COMMIT");
      return { runId: input.runId, interactionId: input.interactionId, status: gate.status };
    }

    const gatePayload = asObject(gate.payload_json);
    const activeInteraction = activeOperatorInteractionSchema.safeParse(gatePayload.operatorInteraction);
    if (activeInteraction.success && activeInteraction.data.kind !== "review_artifact") {
      throw new Error(`Operator revision is not allowed for ${activeInteraction.data.kind}.`);
    }
    const agentId = typeof gatePayload.agentId === "string" ? gatePayload.agentId : "";
    if (!agentId) throw new Error("Interaction payload missing agentId");

    const feedback = typeof input.value.feedback === "string" ? input.value.feedback : undefined;
    const editedText = typeof input.value.editedText === "string" ? input.value.editedText : undefined;
    const revisionPatch = buildOperatorRevisionPatch({ agentId, feedback, editedText });
    const currentContext = runtimeContextSchema.parse(gate.context_json);
    const nextContext = runtimeContextSchema.parse({
      ...currentContext,
      operatorRevisions: {
        ...currentContext.operatorRevisions,
        ...(revisionPatch.operatorRevisions ?? {}),
      },
    });

    await client.query(
      `UPDATE loop_engine_interactions SET status = 'submitted', decision_json = $2::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [input.interactionId, JSON.stringify({ action: "revise", ...input.value })],
    );
    await client.query(
      `UPDATE loop_engine_runs SET context_json = $2::jsonb, status = 'running', current_step_index = $3, updated_at = NOW()
       WHERE id = $1`,
      [input.runId, JSON.stringify(nextContext), gate.step_index],
    );
    await client.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'waiting_for_interaction'`,
      [gate.step_attempt_id],
    );

    tenantId = gate.tenant_id;
    userId = gate.user_id;
    retryAgent = loopRunAgentSchema.parse(gate.agent_snapshot);
    retryStepIndex = gate.step_index;
    retryAttemptNumber = gate.attempt + 1;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (retryAgent) {
    retryAttemptId = await createAttempt({
      tenantId,
      userId,
      runId: input.runId,
      stepIndex: retryStepIndex,
      agent: retryAgent,
      attempt: retryAttemptNumber,
    });
  }

  if (retryAttemptId) {
    await enqueueCommand({
      tenantId,
      userId,
      runId: input.runId,
      stepAttemptId: retryAttemptId,
      commandType: "execute_step",
      idempotencyKey: `attempt:${retryAttemptId}:execute`,
    });
  }

  return { runId: input.runId, interactionId: input.interactionId, status: "submitted", action: "revise" };
}

export async function cancelLoopRuntimeRun(auth: AuthContext, runId: string) {
  const result = await pool.query(
    `UPDATE loop_engine_runs SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status NOT IN ('succeeded', 'failed', 'cancelled')
     RETURNING id, status`,
    [runId, auth.tenantId, auth.userId],
  );
  if (!result.rows[0]) return getLoopRuntimeProjection(auth, runId);
  await pool.query(
    `UPDATE loop_engine_commands SET status = 'cancelled', updated_at = NOW()
     WHERE run_id = $1 AND status IN ('pending', 'processing')`,
    [runId],
  );
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND status IN ('queued', 'running', 'waiting_for_interaction')`,
    [runId],
  );
  return getLoopRuntimeProjection(auth, runId);
}

export async function retryLoopRuntimeStep(auth: AuthContext, runId: string, stepAttemptId: string) {
  const result = await pool.query<{
    tenant_id: string;
    user_id: string;
    step_index: number;
    attempt: number;
    agent_snapshot: unknown;
    step_status: string;
    run_status: string;
  }>(
    `SELECT a.tenant_id, a.user_id, a.step_index, a.attempt, a.agent_snapshot,
            a.status AS step_status, r.status AS run_status
     FROM loop_engine_step_attempts a JOIN loop_engine_runs r ON r.id = a.run_id
     WHERE a.id = $1 AND a.run_id = $2 AND r.tenant_id = $3 AND r.user_id = $4
     LIMIT 1`,
    [stepAttemptId, runId, auth.tenantId, auth.userId],
  );
  const row = result.rows[0];
  const retryable = row && (
    row.step_status === "failed"
    || row.step_status === "cancelled"
    || (row.step_status === "waiting_for_interaction" && ["failed", "blocked", "cancelled"].includes(row.run_status))
  );
  if (!retryable || !row) throw new Error("Retryable step attempt not found");

  await pool.query(
    `UPDATE loop_engine_interactions
     SET status = 'rejected', decision_json = $2::jsonb, completed_at = NOW(), updated_at = NOW()
     WHERE step_attempt_id = $1 AND status = 'pending'`,
    [stepAttemptId, JSON.stringify({ reason: "operator_retry" })],
  );
  if (row.step_status === "waiting_for_interaction") {
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [stepAttemptId],
    );
  }
  await pool.query(
    `UPDATE loop_engine_artifacts SET invalidated_at = NOW()
     WHERE run_id = $1 AND step_attempt_id IN (
       SELECT id FROM loop_engine_step_attempts WHERE run_id = $1 AND step_index >= $2
     ) AND invalidated_at IS NULL`,
    [runId, row.step_index],
  );
  await pool.query(
    `UPDATE loop_engine_step_attempts SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND step_index > $2 AND status IN ('queued', 'running', 'waiting_for_interaction', 'succeeded')`,
    [runId, row.step_index],
  );
  const retryId = await createAttempt({
    tenantId: row.tenant_id,
    userId: row.user_id,
    runId,
    stepIndex: row.step_index,
    agent: loopRunAgentSchema.parse(row.agent_snapshot),
    attempt: row.attempt + 1,
  });
  await pool.query(
    `UPDATE loop_engine_runs
     SET status = 'running', current_step_index = $2, error_json = '{}'::jsonb, finished_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [runId, row.step_index],
  );
  await enqueueCommand({
    tenantId: row.tenant_id,
    userId: row.user_id,
    runId,
    stepAttemptId: retryId,
    commandType: "retry_step",
    idempotencyKey: `attempt:${retryId}:retry`,
  });
  return getLoopRuntimeProjection(auth, runId);
}

export async function saveCanvasEmailArtifact(input: {
  auth: AuthContext;
  runId: string;
  artifactKey: string;
  emailTemplate: Pick<CanvasEmailTemplate, "design" | "html" | "text" | "subject" | "preview"> & {
    finalUse?: boolean;
  };
}) {
  const existing = await pool.query<{
    tenant_id: string;
    user_id: string;
    step_attempt_id: string | null;
  }>(
    `SELECT a.tenant_id, a.user_id, a.step_attempt_id
     FROM loop_engine_artifacts a
     JOIN loop_engine_runs r ON r.id = a.run_id
     WHERE a.run_id = $1
       AND a.artifact_key = $2
       AND a.kind = 'canvas_email'
       AND a.invalidated_at IS NULL
       AND r.tenant_id = $3
       AND r.user_id = $4
     ORDER BY a.version DESC
     LIMIT 1`,
    [input.runId, input.artifactKey, input.auth.tenantId, input.auth.userId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Canvas email artifact not found");
  const emailTemplate: CanvasEmailTemplate = {
    ...input.emailTemplate,
    text: input.emailTemplate.text ?? "",
    subject: input.emailTemplate.subject ?? "Email draft",
    preview: input.emailTemplate.preview ?? input.emailTemplate.subject ?? "Email draft",
    updatedAt: new Date().toISOString(),
    source: "dashboard",
    finalUse: input.emailTemplate.finalUse ?? false,
  };
  await pool.query(
    `INSERT INTO loop_engine_artifacts
     (tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json)
     SELECT $1, $2, $3, $4, $5,
            COALESCE(MAX(version), 0) + 1, 'canvas_email', $6, $7::jsonb
     FROM loop_engine_artifacts WHERE run_id = $3 AND artifact_key = $5`,
    [
      row.tenant_id,
      row.user_id,
      input.runId,
      row.step_attempt_id,
      input.artifactKey,
      emailTemplate.html,
      JSON.stringify({
        renderTarget: "canvas.email",
        emailTemplate,
      }),
    ],
  );
  await insertEvent({
    tenantId: row.tenant_id,
    userId: row.user_id,
    runId: input.runId,
    stepAttemptId: row.step_attempt_id,
    eventType: "canvas_email_saved",
    payload: { artifactKey: input.artifactKey },
  });
  return getLoopRuntimeProjection(input.auth, input.runId);
}

export async function saveAgentOutput(input: {
  auth: AuthContext;
  runId: string;
  stepId: string;
  text: string;
}) {
  const existing = await pool.query<{
    tenant_id: string;
    user_id: string;
    output_json: unknown;
    agent_id: string;
  }>(
    `SELECT a.tenant_id, a.user_id, a.output_json, a.agent_id
     FROM loop_engine_step_attempts a
     JOIN loop_engine_runs r ON r.id = a.run_id
     WHERE a.id = $1 AND a.run_id = $2 AND r.tenant_id = $3 AND r.user_id = $4`,
    [input.stepId, input.runId, input.auth.tenantId, input.auth.userId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Agent output not found");

  // Derive a subject from the first heading/line so downstream email bindings can resolve /subject.
  const body = input.text.trim();
  const subject = deriveSubjectFromBody(body);
  const structuredOutput = { body, subject };

  const output = { ...asObject(row.output_json), text: input.text, data: { structuredOutput }, operatorEdited: true };
  await pool.query(
    `UPDATE loop_engine_step_attempts SET output_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [input.stepId, JSON.stringify(output)],
  );
  await pool.query(
    `UPDATE loop_engine_interactions
     SET payload_json = jsonb_set(payload_json, '{result,text}', to_jsonb($2::text), true), updated_at = NOW()
     WHERE run_id = $1 AND step_attempt_id = $3 AND status = 'pending'`,
    [input.runId, input.text, input.stepId],
  );

  // Look up the original artifact key for this agent so the edit is stored under the same key
  // and buildPriorOutputIndex maps it correctly to downstream bindings.
  const originalArtifact = await pool.query<{ artifact_key: string }>(
    `SELECT artifact_key FROM loop_engine_artifacts
     WHERE run_id = $1 AND step_attempt_id = $2 AND kind = 'structured_output' AND invalidated_at IS NULL
     ORDER BY version DESC LIMIT 1`,
    [input.runId, input.stepId],
  );
  const artifactKey = originalArtifact.rows[0]?.artifact_key ?? `${row.agent_id}:operator_edit`;

  await pool.query(
    `INSERT INTO loop_engine_artifacts
     (tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json)
     SELECT $1, $2, $3, $4, $5,
            COALESCE(MAX(version), 0) + 1, 'structured_output', $6, $7::jsonb
     FROM loop_engine_artifacts WHERE run_id = $3 AND artifact_key = $5`,
    [
      row.tenant_id,
      row.user_id,
      input.runId,
      input.stepId,
      artifactKey,
      input.text,
      JSON.stringify({ text: input.text, data: { structuredOutput }, structuredOutput, operatorEdited: true }),
    ],
  );
  await insertEvent({
    tenantId: row.tenant_id,
    userId: row.user_id,
    runId: input.runId,
    stepAttemptId: input.stepId,
    eventType: "agent_output_saved",
    payload: { agentId: row.agent_id },
  });
  return getLoopRuntimeProjection(input.auth, input.runId);
}

export async function executeOperatorInteractionCommand(input: {
  auth: AuthContext;
  runId: string;
  interactionId: string;
  command: unknown;
}) {
  const command = operatorInteractionCommandSchema.parse(input.command);
  if (command.command === "submit_input") {
    return submitLoopRuntimeInteractionInputs({
      auth: input.auth,
      runId: input.runId,
      interactionId: input.interactionId,
      values: gateSurfaceSubmissionSchema.parse(command.values),
    });
  }
  if (command.command === "revise") {
    return reviseLoopRuntimeInteraction({
      auth: input.auth,
      runId: input.runId,
      interactionId: input.interactionId,
      value: command.value,
    });
  }
  return executeLoopRuntimeInteractionCommand({
    auth: input.auth,
    runId: input.runId,
    interactionId: input.interactionId,
    decision: command.command === "verify_connection" ? "input" : command.command,
    value: command.value,
  });
}

let timer: NodeJS.Timeout | null = null;

export function startLoopRuntimeWorker() {
  if (timer) return;
  timer = setInterval(() => {
    void dispatchLoopRuntimeCommands().catch((error) => {
      console.error("Stable loop runtime dispatch failed:", error);
    });
  }, 1_000);
  timer.unref();
}

export function stopLoopRuntimeWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
