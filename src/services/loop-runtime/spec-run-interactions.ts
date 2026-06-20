import { randomUUID } from "crypto";
import type { UIMessage } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { executeApprovedComposioAction } from "../connectors/composio.js";
import { selectedConnectorAccountId, type LoopBuildContract } from "../loop-engine/build-contract.js";
import { inputSurfaceSchema, type InputSurface } from "../loop-engine/input-surfaces.js";
import { listLoopRunMessages, replaceLoopRunMessages } from "./run-messages.js";
import { parseRunnableSpec } from "./spec-run-types.js";
import { compileSpecRunPlan } from "./spec-run-plan.js";
import { enrichDraftPayload } from "./spec-run-write-payload.js";
import { projectRunContext } from "./build-run-context.js";
import { loadTriggerPayloadForRun } from "./trigger-payload.js";
import {
  actionRefsForTool,
  storeSpecRunApprovalGrant,
} from "./spec-run-approval-grants.js";
import {
  drainLoopRunCommands,
  enqueueLoopRunCommand,
} from "./spec-run-commands.js";

async function loadRunContextForInteraction(input: {
  auth: AuthContext;
  runId: string;
  workflowId: string;
}): Promise<ReturnType<typeof projectRunContext> | null> {
  const specResult = await pool.query<{ metadata_json: unknown; context_json: unknown }>(
    `SELECT w.metadata_json, r.context_json
     FROM loop_engine_runs r
     JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1 AND r.tenant_id = $2 AND r.user_id = $3
     LIMIT 1`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
  const row = specResult.rows[0];
  const spec = parseRunnableSpec(row?.metadata_json);
  if (!spec) return null;
  const context = asRecord(row?.context_json);
  const triggerRaw = asRecord(context.trigger);
  const source: "schedule" | "event" | "manual" =
    triggerRaw.source === "schedule" || triggerRaw.source === "event" ? triggerRaw.source : "manual";
  const trigger = {
    source,
    label: typeof triggerRaw.label === "string" ? triggerRaw.label : undefined,
    triggerInstanceId: typeof triggerRaw.triggerInstanceId === "string" ? triggerRaw.triggerInstanceId : undefined,
    eventId: typeof triggerRaw.eventId === "string" ? triggerRaw.eventId : undefined,
  };
  const triggerPayload = await loadTriggerPayloadForRun({
    runId: input.runId,
    triggerInstanceId: trigger.triggerInstanceId,
    externalEventId: trigger.eventId,
  });
  return projectRunContext({
    spec,
    workflowId: input.workflowId,
    trigger,
    triggerPayload,
  });
}

async function tryAutoExecuteDraftAfterReviewApproval(input: {
  auth: AuthContext;
  runId: string;
  workflowId: string;
  interaction: InteractionRow;
}): Promise<{ executed: boolean; output?: unknown; toolKey?: string }> {
  const payload = asRecord(input.interaction.payload_json);
  const gateType = typeof payload.gateType === "string" ? payload.gateType : "";
  if (gateType !== "draft_review") return { executed: false };

  const canvasKey = typeof payload.canvasArtifactKey === "string"
    ? payload.canvasArtifactKey
    : typeof payload.artifactKey === "string"
      ? payload.artifactKey
      : null;
  if (!canvasKey) return { executed: false };

  const artifactResult = await pool.query<{ body: string; data_json: unknown }>(
    `SELECT body, data_json
     FROM loop_engine_artifacts
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3
       AND artifact_key = $4 AND invalidated_at IS NULL
     ORDER BY version DESC
     LIMIT 1`,
    [input.runId, input.auth.tenantId, input.auth.userId, canvasKey],
  );
  const artifact = artifactResult.rows[0];
  if (!artifact) return { executed: false };

  const emailTemplate = asRecord(asRecord(artifact.data_json).emailTemplate);
  const subject = typeof emailTemplate.subject === "string" ? emailTemplate.subject : "";
  const body = typeof emailTemplate.text === "string"
    ? emailTemplate.text
    : typeof emailTemplate.html === "string"
      ? emailTemplate.html
      : artifact.body;
  if (!subject.trim() && !String(body).trim()) return { executed: false };

  const spec = parseRunnableSpec(
    (await pool.query<{ metadata_json: unknown }>(
      `SELECT metadata_json FROM workflows WHERE id = $1 LIMIT 1`,
      [input.workflowId],
    )).rows[0]?.metadata_json,
  );
  if (!spec) return { executed: false };

  const plan = compileSpecRunPlan(spec);
  const stepResult = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM loop_engine_step_attempts WHERE id = $1 LIMIT 1`,
    [input.interaction.step_attempt_id],
  );
  const agent = plan.agents.find((entry) => entry.id === stepResult.rows[0]?.agent_id);

  const isDraftWriteTool = (tool: ReturnType<typeof compileSpecRunPlan>["writeTools"][number]) => {
    const slug = tool.actionSlug.toUpperCase();
    return slug.includes("DRAFT")
      || (slug.includes("CREATE") && (slug.includes("EMAIL") || slug.includes("MAIL")));
  };

  const writeTool = (agent
    ? plan.writeTools.find((tool) => agent.toolRefs.includes(tool.toolRef) && isDraftWriteTool(tool))
    : null)
    ?? plan.writeTools.find((tool) => isDraftWriteTool(tool) && tool.effect !== "irreversible_external");
  if (!writeTool) return { executed: false };

  const runContext = await loadRunContextForInteraction({
    auth: input.auth,
    runId: input.runId,
    workflowId: input.workflowId,
  });
  const draftPayload = enrichDraftPayload(writeTool.actionSlug, {
    subject,
    body,
    is_html: typeof body === "string" && body.includes("<"),
  }, runContext ?? undefined);

  const deferred: DeferredWriteToolCall = {
    toolkit: writeTool.toolkit,
    actionSlug: writeTool.actionSlug,
    actionLabel: writeTool.contract.name,
    isSendAction: writeTool.effect === "irreversible_external",
    actionRef: writeTool.toolRef,
    payload: draftPayload,
  };
  const buildContract = spec.buildContract ?? spec.noSlopSpec.buildContract ?? spec.noSlopSpec.specJson.buildContract;
  const output = await executeDeferredWriteTool({
    auth: input.auth,
    runId: input.runId,
    deferred,
    buildContract,
  });
  return { executed: true, output, toolKey: writeTool.toolKey };
}

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
}): Promise<void> {
  if (input.viaStream) {
    const messages = await listLoopRunMessages(input.auth, input.runId);
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

function gateTypeForDeferred(deferred: DeferredWriteToolCall): "draft_review" | "pre_send" {
  return deferred.isSendAction ? "pre_send" : "draft_review";
}

function buildInteractionPayload(input: {
  interactionId: string;
  toolKey: string;
  deferred: DeferredWriteToolCall;
  agentName: string;
  stepIndex: number;
  canvasArtifactKey: string;
}): Record<string, unknown> {
  const gateType = gateTypeForDeferred(input.deferred);
  const surface = input.deferred.isSendAction ? "confirm.send" : "review.email";
  const surfaces = [{
    key: "draft_email",
    surface,
    required: true,
    satisfied: false,
    label: "Email",
    description: gateType === "pre_send"
      ? "Review the final draft, then approve send."
      : "Review the draft, then save & approve or request changes.",
    props: {
      renderTarget: "canvas.email",
      canvasArtifactKey: input.canvasArtifactKey,
    },
  }];
  return {
    gateType,
    toolKey: input.toolKey,
    deferred: input.deferred,
    agentId: input.toolKey,
    stepIndex: input.stepIndex,
    renderTarget: "canvas.email",
    canvasArtifactKey: input.canvasArtifactKey,
    checkpoint: {
      reason: "review",
      blocking: { agentId: input.toolKey, stepIndex: input.stepIndex },
      surfaces,
    },
    surfaces,
    operatorInteraction: {
      kind: "review_artifact",
      interactionId: input.interactionId,
      artifactId: input.canvasArtifactKey.replace(/:canvas\.email$/, ""),
      rendererRef: "canvas.email",
      editable: gateType === "draft_review",
      producerNodeId: input.toolKey,
      outputText: input.deferred.rationale ?? "",
    },
    result: { text: input.deferred.rationale ?? `${input.agentName} ready for review.` },
  };
}

function stripLeadingSubjectFromBody(subject: string, body: string): string {
  let result = body.trim();
  const subj = subject.trim();
  if (!subj || !result) return result;
  const escaped = subj.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let changed = true;
  while (changed) {
    changed = false;
    const next = result.replace(new RegExp(`^${escaped}(?:\\s*\\n|\\s+|$)`, "i"), "").trim();
    if (next !== result) {
      result = next;
      changed = true;
    }
  }
  return result;
}

function buildEmailArtifactBody(payload: Record<string, unknown>): {
  body: string;
  emailTemplate: Record<string, unknown>;
} {
  const subject = typeof payload.subject === "string" ? payload.subject : "Draft";
  const rawBodyText = typeof payload.body === "string" ? payload.body : "";
  const bodyText = stripLeadingSubjectFromBody(subject, rawBodyText);
  const isHtml = payload.is_html === true || bodyText.includes("<");
  const html = isHtml
    ? bodyText
    : `<html><body>${bodyText.split(/\n{2,}/).map((part) => `<p>${part.replace(/\n/g, "<br/>")}</p>`).join("")}</body></html>`;
  const plainText = isHtml ? bodyText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : bodyText.trim();
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const editorContent = (bodyMatch ? bodyMatch[1] : html).trim();
  const reactEmailSource = JSON.stringify({
    subject,
    previewText: subject,
    greeting: "",
    body: plainText || "Draft content",
    signOff: "",
    agentName: "",
  });
  return {
    body: html,
    emailTemplate: {
      design: { variant: "react-email", designId: "minimal" },
      html,
      text: plainText,
      subject,
      preview: subject,
      reactEmailSource,
      editorContent,
      source: "spec-run",
    },
  };
}

function renderTargetForSurface(surface: InputSurface): string | undefined {
  if (surface === "review.email") return "canvas.email";
  if (surface === "review.preview") return "canvas.preview";
  return undefined;
}

function interactionKindForSurface(surface: InputSurface): InteractionRow["interaction_kind"] {
  if (surface.startsWith("input.")) return "collect_input";
  if (surface === "confirm.send") return "confirm_action";
  return "review_artifact";
}

function gateTypeForSurface(surface: InputSurface): string {
  if (surface.startsWith("input.")) return "missing_input";
  if (surface === "confirm.send") return "pre_send";
  if (surface === "review.sources") return "source_confirmation";
  if (surface === "review.memories") return "memory_confirmation";
  return "draft_review";
}

function operatorTitleForSurface(surface: InputSurface): string {
  if (surface.startsWith("input.")) return "Input required";
  if (surface === "confirm.send") return "Approval required";
  if (surface === "review.sources") return "Source review";
  if (surface === "review.memories") return "Memory review";
  return "Draft review";
}

function artifactBodyFromSurface(surface: InputSurface, artifactData: Record<string, unknown>): {
  body: string;
  dataJson: Record<string, unknown>;
  kind: string;
} {
  if (surface === "review.email") {
    const emailTemplate = asRecord(artifactData.emailTemplate);
    const subject = typeof artifactData.subject === "string"
      ? artifactData.subject
      : typeof emailTemplate.subject === "string"
        ? emailTemplate.subject
        : "Draft";
    const bodyText = typeof artifactData.body === "string"
      ? artifactData.body
      : typeof artifactData.text === "string"
        ? artifactData.text
        : typeof emailTemplate.text === "string"
          ? emailTemplate.text
          : "";
    const html = typeof artifactData.html === "string"
      ? artifactData.html
      : typeof emailTemplate.html === "string"
        ? emailTemplate.html
        : `<html><body><p>${bodyText.replace(/\n/g, "<br/>")}</p></body></html>`;
    return {
      body: html,
      kind: "canvas_email",
      dataJson: {
        renderTarget: "canvas.email",
        emailTemplate: {
          design: asRecord(emailTemplate.design),
          html,
          text: bodyText,
          subject,
          preview: typeof emailTemplate.preview === "string" ? emailTemplate.preview : subject,
          source: "spec-run",
        },
        data: artifactData,
      },
    };
  }
  return {
    body: typeof artifactData.text === "string"
      ? artifactData.text
      : typeof artifactData.body === "string"
        ? artifactData.body
        : JSON.stringify(artifactData, null, 2),
    kind: surface === "review.preview" ? "preview" : "markdown",
    dataJson: {
      renderTarget: renderTargetForSurface(surface) ?? surface,
      data: artifactData,
    },
  };
}

export async function createSpecRunInputInteraction(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  agentId: string;
  agentName: string;
  stepIndex: number;
  surface: InputSurface;
  key: string;
  label?: string;
  description?: string;
}): Promise<string> {
  const surface = inputSurfaceSchema.parse(input.surface);
  if (!surface.startsWith("input.")) throw new Error(`Input interaction requires input.* surface, got ${surface}`);
  const interactionId = randomUUID();
  const question = input.description ?? input.label ?? "Provide the required input.";
  const block = {
    kind: "collect_input" as const,
    id: input.key,
    surface,
    required: true,
    satisfied: false,
    label: input.label ?? input.key,
    description: input.description ?? question,
  };
  const payload = {
    gateType: "missing_input",
    agentId: input.agentId,
    stepIndex: input.stepIndex,
    key: input.key,
    surface,
    workspace: {
      title: operatorTitleForSurface(surface),
      subtitle: question,
      stamp: { tag: "Input", name: input.agentName },
    },
    blocks: [block],
    actions: [
      { id: "submit", command: "submit_input", label: "Submit input", enabled: true },
      { id: "reject", command: "reject", label: "Reject", enabled: true },
    ],
    meta: { nextAgentName: input.agentName },
  };

  await pool.query(
    `INSERT INTO loop_engine_interactions
       (id, tenant_id, user_id, run_id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'collect_input', 'pending', $6, $7::jsonb, '{}'::jsonb, $8, NOW(), NOW())`,
    [
      interactionId,
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId,
      question,
      JSON.stringify(payload),
      `spec-run:${input.runId}:${input.stepAttemptId}:input:${input.key}`,
    ],
  );
  return interactionId;
}

export async function createSpecRunReviewInteraction(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  agentId: string;
  agentName: string;
  stepIndex: number;
  surface: InputSurface;
  artifactKey: string;
  artifactData: Record<string, unknown>;
  rationale?: string;
}): Promise<string> {
  const surface = inputSurfaceSchema.parse(input.surface);
  if (!surface.startsWith("review.") && surface !== "confirm.send") {
    throw new Error(`Review interaction requires review.* or confirm.send surface, got ${surface}`);
  }
  const interactionId = randomUUID();
  const question = input.rationale?.trim() || "Review the agent output, then approve or request changes.";
  const renderTarget = renderTargetForSurface(surface);
  const block = {
    kind: "review_artifact" as const,
    id: input.artifactKey,
    surface,
    required: true,
    satisfied: false,
    label: "Review",
    description: question,
    props: {
      ...(renderTarget ? { renderTarget } : {}),
      canvasArtifactKey: input.artifactKey,
    },
    data: {
      ...input.artifactData,
      agentOutput: input.rationale,
    },
  };
  const payload = {
    gateType: gateTypeForSurface(surface),
    toolKey: "requestReview",
    agentId: input.agentId,
    stepIndex: input.stepIndex,
    surface,
    artifactKey: input.artifactKey,
    canvasArtifactKey: input.artifactKey,
    workspace: {
      title: operatorTitleForSurface(surface),
      subtitle: question,
      stamp: { tag: surface === "confirm.send" ? "Approve" : "Review", name: input.agentName },
    },
    blocks: [block],
    actions: [
      { id: "approve", command: "approve", label: surface === "confirm.send" ? "Approve" : "Save & Approve", enabled: true },
      { id: "revise", command: "revise", label: "Request changes", enabled: true },
      { id: "reject", command: "reject", label: "Reject", enabled: true },
    ],
    meta: {
      canvasArtifactKey: input.artifactKey,
      renderTarget,
      agentOutput: input.rationale,
      nextAgentName: input.agentName,
    },
  };

  const artifact = artifactBodyFromSurface(surface, input.artifactData);
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
      input.artifactKey,
      artifact.kind,
      artifact.body,
      JSON.stringify(artifact.dataJson),
    ],
  );
  await pool.query(
    `INSERT INTO loop_engine_interactions
       (id, tenant_id, user_id, run_id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8::jsonb, '{}'::jsonb, $9, NOW(), NOW())`,
    [
      interactionId,
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId,
      interactionKindForSurface(surface),
      question,
      JSON.stringify(payload),
      `spec-run:${input.runId}:${input.stepAttemptId}:review:${input.artifactKey}`,
    ],
  );
  return interactionId;
}

export async function createSpecRunApprovalInteraction(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  agentId: string;
  agentName: string;
  stepIndex: number;
  toolKey: string;
  deferred: DeferredWriteToolCall;
  artifactKey?: string;
}): Promise<string> {
  const interactionId = await createSpecRunReviewInteraction({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    agentId: input.agentId,
    agentName: input.agentName,
    stepIndex: input.stepIndex,
    surface: input.deferred.isSendAction ? "confirm.send" : "review.preview",
    artifactKey: input.artifactKey ?? `${input.toolKey}:approval`,
    artifactData: {
      actionRef: input.deferred.actionRef ?? `${input.deferred.toolkit}.${input.deferred.actionSlug}`,
      payload: input.deferred.payload,
      rationale: input.deferred.rationale,
    },
    rationale: input.deferred.rationale ?? `Approve ${input.deferred.actionLabel}.`,
  });
  await pool.query(
    `UPDATE loop_engine_interactions
     SET payload_json = payload_json || $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [
      interactionId,
      JSON.stringify({
        toolKey: input.toolKey,
        deferred: input.deferred,
      }),
    ],
  );
  return interactionId;
}

export async function createWriteToolApprovalInteraction(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  toolKey: string;
  deferred: DeferredWriteToolCall;
  agentName: string;
  stepIndex: number;
}): Promise<string> {
  const interactionId = randomUUID();
  const canvasArtifactKey = `${input.toolKey}:canvas.email`;
  const payload = buildInteractionPayload({
    interactionId,
    toolKey: input.toolKey,
    deferred: input.deferred,
    agentName: input.agentName,
    stepIndex: input.stepIndex,
    canvasArtifactKey,
  });
  const gateType = gateTypeForDeferred(input.deferred);
  const question = gateType === "pre_send"
    ? "Review the final draft, then approve send."
    : "Review the draft, then save & approve or request changes.";

  await pool.query(
    `INSERT INTO loop_engine_interactions
       (id, tenant_id, user_id, run_id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'review_artifact', 'pending', $6, $7::jsonb, '{}'::jsonb, $8, NOW(), NOW())`,
    [
      interactionId,
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId,
      question,
      JSON.stringify(payload),
      `spec-run:${input.runId}:${input.stepAttemptId}:${input.toolKey}`,
    ],
  );

  const { body, emailTemplate } = buildEmailArtifactBody(input.deferred.payload);
  await pool.query(
    `INSERT INTO loop_engine_artifacts
       (id, tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 'canvas_email', $7, $8::jsonb, NOW())
     ON CONFLICT (run_id, artifact_key, version) DO UPDATE
       SET body = EXCLUDED.body,
           data_json = EXCLUDED.data_json`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId,
      canvasArtifactKey,
      body,
      JSON.stringify({
        renderTarget: "canvas.email",
        emailTemplate,
      }),
    ],
  );

  return interactionId;
}

export function mapInteractionKindForUi(row: InteractionRow): string {
  const payload = asRecord(row.payload_json);
  if (typeof payload.gateType === "string") return payload.gateType;
  if (row.interaction_kind === "collect_input") return "missing_input";
  if (row.interaction_kind === "confirm_action") return "pre_send";
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
  const surface = gateType === "pre_send" ? "confirm.send" : "review.email";
  const canvasArtifactKey = typeof payload.canvasArtifactKey === "string"
    ? payload.canvasArtifactKey
    : `${payload.toolKey ?? "draft"}:canvas.email`;
  const agentName = stepSnapshot?.name ?? (typeof payload.agentId === "string" ? payload.agentId : "Agent");

  return {
    interactionId: interaction.id,
    workspace: {
      title: gateType === "pre_send" ? "Send approval" : "Draft review",
      subtitle: interaction.question,
      stamp: {
        tag: gateType === "pre_send" ? "Send" : "Review",
        name: deferred.actionLabel ?? agentName,
      },
    },
    blocks: [{
      kind: "review_artifact",
      id: "draft_email",
      surface,
      required: true,
      satisfied: false,
      label: "Email",
      description: interaction.question,
      props: {
        renderTarget: "canvas.email",
        canvasArtifactKey,
      },
      data: deferred.payload ?? {},
    }],
    actions: [
      { id: "approve", command: "approve", label: gateType === "pre_send" ? "Approve & send" : "Save & Approve", enabled: true },
      { id: "revise", command: "revise", label: "Request changes", enabled: true },
      { id: "reject", command: "reject", label: "Reject", enabled: true },
    ],
    meta: {
      canvasArtifactKey,
      agentOutput: deferred.rationale,
      nextAgentName: agentName,
      renderTarget: "canvas.email",
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
  buildContract?: LoopBuildContract | null;
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
  const spec = parseRunnableSpec(
    (await pool.query<{ metadata_json: unknown }>(
      `SELECT w.metadata_json
       FROM workflows w
       JOIN loop_engine_runs r ON r.workflow_id = w.id
       WHERE r.id = $1 LIMIT 1`,
      [input.runId],
    )).rows[0]?.metadata_json,
  );
  const plan = spec ? compileSpecRunPlan(spec) : null;
  const buildContract = spec?.buildContract ?? spec?.noSlopSpec.buildContract ?? spec?.noSlopSpec.specJson.buildContract;

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
    await finalizeInteractionResume({
      auth: input.auth,
      runId: input.runId,
      workflowId,
      interactionId: interaction.id,
      toolKey: typeof payload.toolKey === "string" ? payload.toolKey : "requestReview",
      toolOutput: { ok: true, revised: true, reason },
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
    const patched = patchMessagesWithToolResult(messages, toolKey, output);
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
    const autoDraft = resumeViaStream
      ? { executed: false as const }
      : await tryAutoExecuteDraftAfterReviewApproval({
      auth: input.auth,
      runId: input.runId,
      workflowId,
      interaction,
    });

    if (autoDraft.executed) {
      const output = autoDraft.output;
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
        [interaction.step_attempt_id, JSON.stringify({ data: output, text: "Draft saved to your connector." })],
      );
      await pool.query(
        `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, step_attempt_id, event_type, payload_json)
         VALUES ($1, $2, $3, $4, 'tool_completed', $5::jsonb)`,
        [
          input.auth.tenantId,
          input.auth.userId,
          input.runId,
          interaction.step_attempt_id,
          JSON.stringify({ toolKey: autoDraft.toolKey ?? toolKey, output }),
        ],
      );
    } else {
      // Non-deferred review approval (requestReview gate): the agent paused to show a draft
      // and now needs to continue executing connector actions without another review gate.
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
