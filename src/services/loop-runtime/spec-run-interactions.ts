import { randomUUID } from "crypto";
import type { UIMessage } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { executeApprovedComposioAction } from "../connectors/composio.js";
import { selectedConnectorAccountId, type AnyLoopBuildContract } from "../loop-engine/build-contract.js";
import { listLoopRunMessages, pruneStepNarrationForStep, replaceLoopRunMessages } from "./run-messages.js";
import { parseLoopDefinitionSnapshot } from "./spec-run-types.js";
import { compileSpecRunPlan } from "./spec-run-plan.js";
import { resolveBuildContract } from "./definition-hydration.js";
import {
  actionRefsForTool,
  storeSpecRunApprovalGrant,
} from "./spec-run-approval-grants.js";
import {
  drainLoopRunCommands,
  enqueueLoopRunCommand,
} from "./spec-run-commands.js";

async function resumeRunAfterApproval(auth: AuthContext, runId: string, workflowId: string, interactionId: string): Promise<void> {
  await pool.query(
    `UPDATE loop_engine_runs SET status = 'running', updated_at = NOW() WHERE id = $1`,
    [runId],
  );
  await enqueueLoopRunCommand({
    auth,
    runId,
    commandType: "continue_after_interaction",
    idempotencyKey: `spec-run:${runId}:continue:${interactionId}`,
    payload: { workflowId, interactionId },
  });
  void drainLoopRunCommands({ auth, workflowId, runId }).catch((error) => {
    console.error("Failed to drain spec run command queue after approval:", error);
  });
}

function shouldResumeViaStream(value?: Record<string, unknown>): boolean {
  return value?.channel === "dashboard";
}

async function finalizeInteractionResume(input: {
  auth: AuthContext;
  runId: string;
  workflowId: string;
  interactionId: string;
  toolKey: string;
  toolOutput: unknown;
  viaStream: boolean;
  pruneStepIndex?: number;
}): Promise<void> {
  if (input.viaStream) {
    let messages = await listLoopRunMessages(input.auth, input.runId);
    if (input.pruneStepIndex !== undefined) {
      messages = pruneStepNarrationForStep(messages, input.pruneStepIndex);
    }
    const patched = patchMessagesWithToolResult(messages, input.toolKey, input.toolOutput);
    await replaceLoopRunMessages(input.auth, input.runId, patched);
    return;
  }
  await resumeRunAfterApproval(input.auth, input.runId, input.workflowId, input.interactionId);
}

export type DeferredWriteToolCall = {
  toolkit: string;
  actionSlug: string;
  actionLabel: string;
  isSendAction: boolean;
  actionRef?: string;
  payload: Record<string, unknown>;
  rationale?: string;
};

export type OperatorViewPayload = {
  interactionId: string | null;
  workspace: {
    title: string;
    subtitle: string;
    stamp: { tag: string; name: string };
  };
  blocks: Array<{
    kind: "collect_input" | "review_artifact" | "confirm_action" | "connect_connector";
    id: string;
    surface?: string;
    required: boolean;
    satisfied: boolean;
    label?: string;
    description?: string;
    props?: Record<string, unknown>;
    data?: unknown;
  }>;
  actions: Array<{
    id: string;
    command: "submit_input" | "approve" | "revise" | "reject" | "verify_connection";
    label: string;
    enabled: boolean;
    disabledReason?: string;
  }>;
  meta?: {
    nextAgentName?: string;
    renderTarget?: string;
    canvasArtifactKey?: string;
    agentOutput?: string;
  };
};

type InteractionRow = {
  id: string;
  run_id: string;
  step_attempt_id: string;
  interaction_kind: string;
  status: string;
  question: string;
  payload_json: unknown;
  decision_json: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function fallbackActionRefs(deferred: DeferredWriteToolCall, toolKey: string): string[] {
  return uniqueStrings([
    toolKey,
    deferred.actionRef,
    `${deferred.toolkit}.${deferred.actionSlug}`,
    deferred.actionSlug,
  ]);
}

export function mapInteractionKindForUi(row: InteractionRow): string {
  const payload = asRecord(row.payload_json);
  if (typeof payload.gateType === "string") return payload.gateType;
  const surface = typeof payload.surface === "string" ? payload.surface.trim() : "";
  if (surface === "confirm.send") return "pre_send";
  if (surface.startsWith("input.")) return "missing_input";
  if (surface === "review.sources") return "source_confirmation";
  if (surface === "review.memories") return "memory_confirmation";
  if (row.interaction_kind === "collect_input") return "missing_input";
  if (row.interaction_kind === "confirm_action") return "pre_send";
  if (row.interaction_kind === "review_artifact") return "draft_review";
  return "draft_review";
}

export function buildOperatorViewFromInteraction(
  interaction: InteractionRow,
  stepSnapshot?: { name?: string },
): OperatorViewPayload | null {
  if (interaction.status !== "pending") return null;
  const payload = asRecord(interaction.payload_json);
  const explicitBlocks = Array.isArray(payload.blocks)
    ? payload.blocks.filter((block): block is OperatorViewPayload["blocks"][number] =>
        Boolean(block && typeof block === "object" && !Array.isArray(block)))
    : [];
  const explicitActions = Array.isArray(payload.actions)
    ? payload.actions.filter((action): action is OperatorViewPayload["actions"][number] =>
        Boolean(action && typeof action === "object" && !Array.isArray(action)))
    : [];
  const workspace = asRecord(payload.workspace);
  if (explicitBlocks.length > 0 && workspace.title && workspace.subtitle) {
    const stamp = asRecord(workspace.stamp);
    return {
      interactionId: interaction.id,
      workspace: {
        title: String(workspace.title),
        subtitle: String(workspace.subtitle),
        stamp: {
          tag: typeof stamp.tag === "string" ? stamp.tag : "Review",
          name: typeof stamp.name === "string" ? stamp.name : stepSnapshot?.name ?? "Agent",
        },
      },
      blocks: explicitBlocks,
      actions: explicitActions.length > 0
        ? explicitActions
        : [
            { id: "approve", command: "approve", label: "Approve", enabled: true },
            { id: "revise", command: "revise", label: "Request changes", enabled: true },
            { id: "reject", command: "reject", label: "Reject", enabled: true },
          ],
      meta: asRecord(payload.meta) as OperatorViewPayload["meta"],
    };
  }
  const deferred = asRecord(payload.deferred) as Partial<DeferredWriteToolCall>;
  const gateType = mapInteractionKindForUi(interaction);
  const explicitCanvasArtifactKey = typeof payload.canvasArtifactKey === "string"
    ? payload.canvasArtifactKey
    : undefined;
  const renderTarget = typeof payload.renderTarget === "string"
    ? payload.renderTarget
    : explicitCanvasArtifactKey?.includes("canvas.email")
      ? "canvas.email"
      : undefined;
  const payloadSurface = typeof payload.surface === "string" ? payload.surface.trim() : "";
  const surface = payloadSurface.startsWith("review.")
    || payloadSurface === "confirm.send"
    || payloadSurface.startsWith("input.")
    ? payloadSurface as OperatorViewPayload["blocks"][number]["surface"]
    : gateType === "pre_send"
      ? "confirm.send"
      : renderTarget === "canvas.email"
        ? "review.email"
        : "review.preview";
  const agentName = stepSnapshot?.name ?? (typeof payload.agentId === "string" ? payload.agentId : "Agent");
  const fallbackWorkspace = asRecord(payload.workspace);
  const workspaceTitle = typeof fallbackWorkspace.title === "string"
    ? fallbackWorkspace.title
    : gateType === "pre_send"
      ? "Send approval"
      : renderTarget === "canvas.email"
        ? "Draft review"
        : "Review";
  const workspaceSubtitle = typeof fallbackWorkspace.subtitle === "string"
    ? fallbackWorkspace.subtitle
    : interaction.question;
  const workspaceStamp = asRecord(fallbackWorkspace.stamp);
  const blockProps = explicitCanvasArtifactKey
    ? {
      ...(renderTarget ? { renderTarget } : {}),
      canvasArtifactKey: explicitCanvasArtifactKey,
    }
    : undefined;

  return {
    interactionId: interaction.id,
    workspace: {
      title: workspaceTitle,
      subtitle: workspaceSubtitle,
      stamp: {
        tag: typeof workspaceStamp.tag === "string"
          ? workspaceStamp.tag
          : gateType === "pre_send"
            ? "Send"
            : "Review",
        name: typeof workspaceStamp.name === "string" ? workspaceStamp.name : deferred.actionLabel ?? agentName,
      },
    },
    blocks: [{
      kind: "review_artifact",
      id: renderTarget === "canvas.email" ? "draft_email" : "review_output",
      surface,
      required: true,
      satisfied: false,
      label: renderTarget === "canvas.email" ? "Email" : "Review",
      description: interaction.question,
      ...(blockProps ? { props: blockProps } : {}),
      data: deferred.payload ?? {},
    }],
    actions: [
      {
        id: "approve",
        command: "approve",
        label: gateType === "pre_send"
          ? "Approve & send"
          : renderTarget === "canvas.email"
            ? "Save & Approve"
            : "Approve",
        enabled: true,
      },
      { id: "revise", command: "revise", label: "Request changes", enabled: true },
      { id: "reject", command: "reject", label: "Reject", enabled: true },
    ],
    meta: {
      agentOutput: deferred.rationale,
      nextAgentName: agentName,
      ...(explicitCanvasArtifactKey ? { canvasArtifactKey: explicitCanvasArtifactKey } : {}),
      ...(renderTarget ? { renderTarget } : {}),
    },
  };
}

export function patchMessagesWithToolResult(
  messages: UIMessage[],
  toolKey: string,
  output: unknown,
): UIMessage[] {
  const next = structuredClone(messages) as UIMessage[];
  for (let messageIndex = next.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = next[messageIndex];
    if (message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex] as Record<string, unknown>;
      const partType = typeof part.type === "string" ? part.type : "";
      if (partType !== `tool-${toolKey}` && partType !== "dynamic-tool") continue;
      if (partType === "dynamic-tool" && part.toolName !== toolKey) continue;
      if (part.state === "output-available") return next;
      part.state = "output-available";
      part.output = output;
      if ("errorText" in part) delete part.errorText;
      return next;
    }
  }

  const toolCallId = randomUUID();
  next.push({
    id: randomUUID(),
    role: "assistant",
    parts: [{
      type: `tool-${toolKey}`,
      toolCallId,
      state: "output-available",
      input: {},
      output,
    } as UIMessage["parts"][number]],
  });
  return next;
}

async function loadInteraction(auth: AuthContext, runId: string, interactionId: string): Promise<InteractionRow> {
  const result = await pool.query<InteractionRow>(
    `SELECT id, run_id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json
     FROM loop_engine_interactions
     WHERE id = $1 AND run_id = $2 AND tenant_id = $3 AND user_id = $4
     LIMIT 1`,
    [interactionId, runId, auth.tenantId, auth.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Interaction not found");
  return row;
}

async function loadRunWorkflowId(auth: AuthContext, runId: string): Promise<string> {
  const result = await pool.query<{ workflow_id: string; metadata_json: unknown }>(
    `SELECT r.workflow_id, w.metadata_json
     FROM loop_engine_runs r
     JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1 AND r.tenant_id = $2 AND r.user_id = $3
     LIMIT 1`,
    [runId, auth.tenantId, auth.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Run not found");
  return row.workflow_id;
}

async function executeDeferredWriteTool(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId?: string;
  toolKey?: string;
  deferred: DeferredWriteToolCall;
  buildContract?: AnyLoopBuildContract | null;
}): Promise<unknown> {
  const idempotencyKey = `spec-run:${input.runId}:${input.stepAttemptId ?? "run"}:${input.toolKey ?? input.deferred.actionSlug}`;
  const result = await executeApprovedComposioAction({
    auth: input.auth,
    toolkit: input.deferred.toolkit,
    actionSlug: input.deferred.actionSlug,
    connectorAccountId: input.buildContract
      ? selectedConnectorAccountId(input.buildContract, input.deferred.toolkit)
      : undefined,
    payload: input.deferred.payload,
    idempotencyKey,
  });
  if (!result.ok) throw new Error(result.error ?? `Action ${input.deferred.actionSlug} failed`);
  return { ok: true, output: result.output };
}

export async function handleSpecRunInteractionCommand(input: {
  auth: AuthContext;
  runId: string;
  interactionId: string;
  command: "approve" | "reject" | "revise" | "submit_input";
  value?: Record<string, unknown>;
}): Promise<{ ok: true; resumeViaStream?: boolean }> {
  const interaction = await loadInteraction(input.auth, input.runId, input.interactionId);
  if (interaction.status !== "pending") {
    throw new Error("This interaction is no longer pending.");
  }

  const resumeViaStream = shouldResumeViaStream(input.value);

  const payload = asRecord(interaction.payload_json);
  const deferredRaw = asRecord(payload.deferred);
  const deferred: DeferredWriteToolCall = {
    toolkit: String(deferredRaw.toolkit ?? ""),
    actionSlug: String(deferredRaw.actionSlug ?? ""),
    actionLabel: String(deferredRaw.actionLabel ?? "External action"),
    isSendAction: deferredRaw.isSendAction === true,
    actionRef: typeof deferredRaw.actionRef === "string" ? deferredRaw.actionRef : undefined,
    payload: asRecord(deferredRaw.payload),
    rationale: typeof deferredRaw.rationale === "string" ? deferredRaw.rationale : undefined,
  };
  const hasDeferredAction = Boolean(deferred.toolkit && deferred.actionSlug);
  const toolKey = typeof payload.toolKey === "string" ? payload.toolKey : "action";
  const workflowId = await loadRunWorkflowId(input.auth, input.runId);
  const definition = parseLoopDefinitionSnapshot(
    (await pool.query<{ definition_snapshot: unknown }>(
      `SELECT definition_snapshot
       FROM loop_engine_runs
       WHERE id = $1 LIMIT 1`,
      [input.runId],
    )).rows[0]?.definition_snapshot,
  );
  const plan = definition ? compileSpecRunPlan(definition) : null;
  const buildContract = definition ? resolveBuildContract(definition) : null;

  const storeApprovalGrant = async (authorizedActionRefs: string[]) => {
    if (!plan) return;
    if (authorizedActionRefs.length === 0) return;
    await storeSpecRunApprovalGrant({
      auth: input.auth,
      runId: input.runId,
      grant: {
        interactionId: interaction.id,
        artifactKey: typeof payload.canvasArtifactKey === "string"
          ? payload.canvasArtifactKey
          : typeof payload.artifactKey === "string"
            ? payload.artifactKey
            : undefined,
        approvedAt: new Date().toISOString(),
        authorizedActionRefs,
        scope: "run",
        stepAttemptId: interaction.step_attempt_id,
      },
    });
  };
  const deferredActionRefs = () => {
    if (!plan || !hasDeferredAction) return [];
    const matchingTool = plan.writeTools.find((tool) =>
      tool.toolKey === toolKey
      || tool.toolRef === deferred.actionRef
      || `${tool.toolkit}.${tool.actionSlug}`.toLowerCase() === `${deferred.toolkit}.${deferred.actionSlug}`.toLowerCase()
      || tool.actionSlug.toLowerCase() === deferred.actionSlug.toLowerCase());
    return matchingTool ? actionRefsForTool(matchingTool) : fallbackActionRefs(deferred, toolKey);
  };

  if (input.command === "reject") {
    const reason = String(input.value?.reason ?? "Rejected by operator.");
    await pool.query(
      `UPDATE loop_engine_interactions
       SET status = 'rejected',
           decision_json = $2::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.id, JSON.stringify({ reason, command: input.command })],
    );
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'failed',
           error_json = $2::jsonb,
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.step_attempt_id, JSON.stringify({ message: reason })],
    );
    await pool.query(
      `UPDATE loop_engine_runs
       SET status = 'failed',
           error_json = $2::jsonb,
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [input.runId, JSON.stringify({ message: reason })],
    );
    return { ok: true };
  }

  if (input.command === "submit_input") {
    const submitted = input.value ?? {};
    await pool.query(
      `UPDATE loop_engine_interactions
       SET status = 'submitted',
           decision_json = $2::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.id, JSON.stringify({ input: submitted, channel: submitted.channel ?? "dashboard" })],
    );
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'queued',
           input_json = input_json || $2::jsonb,
           output_json = '{}'::jsonb,
           error_json = '{}'::jsonb,
           started_at = NULL,
           finished_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [
        interaction.step_attempt_id,
        JSON.stringify({
          operatorInputs: {
            [typeof payload.key === "string" ? payload.key : interaction.id]: submitted,
          },
        }),
      ],
    );
    await pool.query(
      `UPDATE loop_engine_runs
       SET status = 'running', updated_at = NOW()
       WHERE id = $1`,
      [input.runId],
    );
    await finalizeInteractionResume({
      auth: input.auth,
      runId: input.runId,
      workflowId,
      interactionId: interaction.id,
      toolKey: typeof payload.toolKey === "string" ? payload.toolKey : "requestInput",
      toolOutput: { ok: true, submitted: submitted },
      viaStream: resumeViaStream,
    });
    return { ok: true, resumeViaStream: resumeViaStream || undefined };
  }

  if (input.command === "revise") {
    const reason = String(input.value?.feedback ?? "Operator requested changes.");
    await pool.query(
      `UPDATE loop_engine_interactions
       SET status = 'rejected',
           decision_json = $2::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.id, JSON.stringify({ reason, command: input.command, channel: input.value?.channel ?? "dashboard" })],
    );
    await pool.query(
      `UPDATE loop_engine_artifacts
       SET invalidated_at = NOW()
       WHERE step_attempt_id = $1 AND invalidated_at IS NULL`,
      [interaction.step_attempt_id],
    );
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'queued',
           input_json = input_json || $2::jsonb,
           output_json = '{}'::jsonb,
           error_json = '{}'::jsonb,
           started_at = NULL,
           finished_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.step_attempt_id, JSON.stringify({ revision: { reason, interactionId: interaction.id } })],
    );
    await pool.query(
      `UPDATE loop_engine_runs
       SET status = 'running',
           updated_at = NOW()
       WHERE id = $1`,
      [input.runId],
    );
    const stepRow = await pool.query<{ step_index: number }>(
      `SELECT step_index FROM loop_engine_step_attempts WHERE id = $1 LIMIT 1`,
      [interaction.step_attempt_id],
    );
    await finalizeInteractionResume({
      auth: input.auth,
      runId: input.runId,
      workflowId,
      interactionId: interaction.id,
      toolKey: typeof payload.toolKey === "string" ? payload.toolKey : "requestReview",
      toolOutput: { ok: true, revised: true, reason },
      viaStream: resumeViaStream,
      pruneStepIndex: stepRow.rows[0]?.step_index,
    });
    return { ok: true, resumeViaStream: resumeViaStream || undefined };
  }

  if (payload.configuredGate === true && !hasDeferredAction && input.command === "approve") {
    const approvalResult = {
      ok: true,
      approved: true,
      interactionKind: interaction.interaction_kind,
      value: input.value ?? {},
    };
    await pool.query(
      `UPDATE loop_engine_interactions
       SET status = 'approved',
           decision_json = $2::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.id, JSON.stringify({ output: approvalResult, channel: input.value?.channel ?? "dashboard" })],
    );
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'succeeded',
           input_json = input_json || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [
        interaction.step_attempt_id,
        JSON.stringify({
          reviewApproval: {
            approved: true,
            interactionId: interaction.id,
            interactionKind: interaction.interaction_kind,
            value: input.value ?? {},
          },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, step_attempt_id, event_type, payload_json)
       VALUES ($1, $2, $3, $4, 'review_approved', $5::jsonb)`,
      [
        input.auth.tenantId,
        input.auth.userId,
        input.runId,
        interaction.step_attempt_id,
        JSON.stringify({ toolKey, output: approvalResult, configuredGate: true }),
      ],
    );
    await pool.query(
      `UPDATE loop_engine_runs SET status = 'running', updated_at = NOW() WHERE id = $1`,
      [input.runId],
    );
    await finalizeInteractionResume({
      auth: input.auth,
      runId: input.runId,
      workflowId,
      interactionId: interaction.id,
      toolKey,
      toolOutput: approvalResult,
      viaStream: resumeViaStream,
    });
    return { ok: true, resumeViaStream: resumeViaStream || undefined };
  }

  if (hasDeferredAction && !resumeViaStream) {
    const output = await executeDeferredWriteTool({
      auth: input.auth,
      runId: input.runId,
      stepAttemptId: interaction.step_attempt_id,
      toolKey,
      deferred,
      buildContract,
    });
    await storeApprovalGrant(deferredActionRefs());

    await pool.query(
      `UPDATE loop_engine_interactions
       SET status = 'approved',
           decision_json = $2::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.id, JSON.stringify({ output, channel: input.value?.channel ?? "dashboard" })],
    );
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'succeeded',
           output_json = $2::jsonb,
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.step_attempt_id, JSON.stringify({ data: output })],
    );
    await pool.query(
      `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, step_attempt_id, event_type, payload_json)
       VALUES ($1, $2, $3, $4, 'tool_completed', $5::jsonb)`,
      [
        input.auth.tenantId,
        input.auth.userId,
        input.runId,
        interaction.step_attempt_id,
        JSON.stringify({ toolKey, output }),
      ],
    );
    const messages = await listLoopRunMessages(input.auth, input.runId);
    const patchedApproval = patchMessagesWithToolResult(messages, "requestApproval", output);
    const patched = patchMessagesWithToolResult(patchedApproval, toolKey, output);
    await replaceLoopRunMessages(input.auth, input.runId, patched);
  } else if (hasDeferredAction && resumeViaStream) {
    await storeApprovalGrant(deferredActionRefs());
    const approvalResult = {
      ok: true,
      approved: true,
      interactionKind: interaction.interaction_kind,
      value: input.value ?? {},
    };
    await pool.query(
      `UPDATE loop_engine_interactions
       SET status = 'approved',
           decision_json = $2::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.id, JSON.stringify({ output: approvalResult, channel: input.value?.channel ?? "dashboard" })],
    );
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'queued',
           input_json = input_json || $2::jsonb,
           output_json = '{}'::jsonb,
           error_json = '{}'::jsonb,
           started_at = NULL,
           finished_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [
        interaction.step_attempt_id,
        JSON.stringify({
          reviewApproval: {
            approved: true,
            interactionId: interaction.id,
            interactionKind: interaction.interaction_kind,
            value: input.value ?? {},
          },
        }),
      ],
    );
  } else {
    const approvalResult = {
      ok: true,
      approved: true,
      interactionKind: interaction.interaction_kind,
      value: input.value ?? {},
    };
    await pool.query(
      `UPDATE loop_engine_interactions
       SET status = 'approved',
           decision_json = $2::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [interaction.id, JSON.stringify({ output: approvalResult, channel: input.value?.channel ?? "dashboard" })],
    );
    await pool.query(
      `UPDATE loop_engine_step_attempts
       SET status = 'queued',
           input_json = input_json || $2::jsonb,
           output_json = '{}'::jsonb,
           error_json = '{}'::jsonb,
           started_at = NULL,
           finished_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [
        interaction.step_attempt_id,
        JSON.stringify({
          reviewApproval: {
            approved: true,
            interactionId: interaction.id,
            interactionKind: interaction.interaction_kind,
            value: input.value ?? {},
          },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, step_attempt_id, event_type, payload_json)
       VALUES ($1, $2, $3, $4, 'review_approved', $5::jsonb)`,
      [
        input.auth.tenantId,
        input.auth.userId,
        input.runId,
        interaction.step_attempt_id,
        JSON.stringify({ toolKey, output: approvalResult }),
      ],
    );
  }

  await pool.query(
    `UPDATE loop_engine_runs SET status = 'running', updated_at = NOW() WHERE id = $1`,
    [input.runId],
  );
  const approvalResult = {
    ok: true,
    approved: true,
    interactionKind: interaction.interaction_kind,
    value: input.value ?? {},
  };
  await finalizeInteractionResume({
    auth: input.auth,
    runId: input.runId,
    workflowId,
    interactionId: interaction.id,
    toolKey,
    toolOutput: approvalResult,
    viaStream: resumeViaStream,
  });

  return { ok: true, resumeViaStream: resumeViaStream || undefined };
}

export async function loadPendingInteractionForRun(auth: AuthContext, runId: string): Promise<InteractionRow | null> {
  const result = await pool.query<InteractionRow>(
    `SELECT id, run_id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json
     FROM loop_engine_interactions
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [runId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ?? null;
}
