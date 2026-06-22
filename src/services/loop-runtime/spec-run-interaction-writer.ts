import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { inputSurfaceSchema, type InputSurface } from "../loop-engine/input-surfaces.js";

export type DeferredWriteToolCall = {
  toolkit: string;
  actionSlug: string;
  actionLabel: string;
  isSendAction: boolean;
  actionRef?: string;
  payload: Record<string, unknown>;
  rationale?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function renderTargetForSurface(surface: InputSurface): string | undefined {
  if (surface === "review.email") return "canvas.email";
  if (surface === "review.preview") return "canvas.preview";
  return undefined;
}

function interactionKindForSurface(surface: InputSurface): "collect_input" | "review_artifact" | "confirm_action" {
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

function approvalLabel(actionLabel: string): string {
  const trimmed = actionLabel.trim();
  return trimmed ? `Approve ${trimmed}` : "Approve action";
}

async function findInteractionIdByKey(idempotencyKey: string): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM loop_engine_interactions WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey],
  );
  return result.rows[0]?.id ?? null;
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
        renderer: "canvas.email",
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
      ...(renderTargetForSurface(surface) ? { renderer: renderTargetForSurface(surface) } : {}),
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
    blocks: [{
      kind: "collect_input",
      id: input.key,
      surface,
      required: true,
      satisfied: false,
      label: input.label ?? input.key,
      description: input.description ?? question,
    }],
    actions: [
      { id: "submit", command: "submit_input", label: "Submit input", enabled: true },
      { id: "reject", command: "reject", label: "Reject", enabled: true },
    ],
    meta: { nextAgentName: input.agentName },
  };

  const idempotencyKey = `spec-run:${input.runId}:${input.stepAttemptId}:input:${input.key}`;
  const existingId = await findInteractionIdByKey(idempotencyKey);
  if (existingId) return existingId;

  const result = await pool.query<{ id: string }>(
    `INSERT INTO loop_engine_interactions
       (id, tenant_id, user_id, run_id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'collect_input', 'pending', $6, $7::jsonb, '{}'::jsonb, $8, NOW(), NOW())
     ON CONFLICT (idempotency_key) DO UPDATE
       SET updated_at = loop_engine_interactions.updated_at
     RETURNING id`,
    [
      interactionId,
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId,
      question,
      JSON.stringify(payload),
      idempotencyKey,
    ],
  );
  return result.rows[0]?.id ?? interactionId;
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
  configuredGate?: boolean;
  nextAgentName?: string;
}): Promise<string> {
  const surface = inputSurfaceSchema.parse(input.surface);
  if (!surface.startsWith("review.") && surface !== "confirm.send") {
    throw new Error(`Review interaction requires review.* or confirm.send surface, got ${surface}`);
  }
  const interactionId = randomUUID();
  const question = input.rationale?.trim() || "Review the agent output, then approve or request changes.";
  const renderTarget = renderTargetForSurface(surface);
  const payload = {
    gateType: gateTypeForSurface(surface),
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
    blocks: [{
      kind: "review_artifact",
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
    }],
    actions: [
      { id: "approve", command: "approve", label: surface === "confirm.send" ? "Approve" : "Save & Approve", enabled: true },
      { id: "revise", command: "revise", label: "Request changes", enabled: true },
      { id: "reject", command: "reject", label: "Reject", enabled: true },
    ],
    meta: {
      canvasArtifactKey: input.artifactKey,
      renderTarget,
      agentOutput: input.rationale,
      ...(input.nextAgentName ? { nextAgentName: input.nextAgentName } : {}),
      ...(input.configuredGate ? { configuredGate: true } : {}),
    },
    ...(input.configuredGate ? { configuredGate: true } : {}),
  };

  const idempotencyKey = `spec-run:${input.runId}:${input.stepAttemptId}:review:${input.artifactKey}`;
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
  const existingId = await findInteractionIdByKey(idempotencyKey);
  if (existingId) return existingId;

  const result = await pool.query<{ id: string }>(
    `INSERT INTO loop_engine_interactions
       (id, tenant_id, user_id, run_id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8::jsonb, '{}'::jsonb, $9, NOW(), NOW())
     ON CONFLICT (idempotency_key) DO UPDATE
       SET updated_at = loop_engine_interactions.updated_at
     RETURNING id`,
    [
      interactionId,
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId,
      interactionKindForSurface(surface),
      question,
      JSON.stringify(payload),
      idempotencyKey,
    ],
  );
  return result.rows[0]?.id ?? interactionId;
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
  if (!input.deferred.isSendAction) {
    const interactionId = randomUUID();
    const actionLabel = input.deferred.actionLabel.trim() || "Connector action";
    const question = input.deferred.rationale?.trim() || `Approve ${actionLabel}.`;
    const actionRef = input.deferred.actionRef ?? `${input.deferred.toolkit}.${input.deferred.actionSlug}`;
    const payload = {
      gateType: "action_approval",
      toolKey: input.toolKey,
      agentId: input.agentId,
      stepIndex: input.stepIndex,
      deferred: input.deferred,
      workspace: {
        title: "Action approval",
        subtitle: question,
        stamp: { tag: "Approve", name: input.agentName },
      },
      blocks: [{
        kind: "confirm_action",
        id: input.toolKey,
        required: true,
        satisfied: false,
        label: actionLabel,
        description: question,
        data: {
          actionRef,
          payload: input.deferred.payload,
          rationale: input.deferred.rationale,
        },
      }],
      actions: [
        { id: "approve", command: "approve", label: approvalLabel(actionLabel), enabled: true },
        { id: "revise", command: "revise", label: "Request changes", enabled: true },
        { id: "reject", command: "reject", label: "Reject", enabled: true },
      ],
      meta: {
        agentOutput: input.deferred.rationale,
        nextAgentName: input.agentName,
      },
    };

    const idempotencyKey = `spec-run:${input.runId}:${input.stepAttemptId}:approval:${input.toolKey}`;
    const existingId = await findInteractionIdByKey(idempotencyKey);
    if (existingId) return existingId;

    const result = await pool.query<{ id: string }>(
      `INSERT INTO loop_engine_interactions
         (id, tenant_id, user_id, run_id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'confirm_action', 'pending', $6, $7::jsonb, '{}'::jsonb, $8, NOW(), NOW())
       ON CONFLICT (idempotency_key) DO UPDATE
         SET updated_at = loop_engine_interactions.updated_at
       RETURNING id`,
      [
        interactionId,
        input.auth.tenantId,
        input.auth.userId,
        input.runId,
        input.stepAttemptId,
        question,
        JSON.stringify(payload),
        idempotencyKey,
      ],
    );
    return result.rows[0]?.id ?? interactionId;
  }

  const interactionId = await createSpecRunReviewInteraction({
    auth: input.auth,
    runId: input.runId,
    stepAttemptId: input.stepAttemptId,
    agentId: input.agentId,
    agentName: input.agentName,
    stepIndex: input.stepIndex,
    surface: "confirm.send",
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
