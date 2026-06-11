import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { ZodError } from "zod";
import {
  listDeliveryActionCandidates,
  selectBestDeliveryAction,
  type ConnectorDeliveryActionCandidate,
} from "../connectors/composio.js";
import { normalizeDesignCron } from "../loop-executor/cron.js";
import { loopBuilderOpenAiChat } from "./openai-chat.js";
import { scoreConnectorPolicyForDelivery } from "../loop-engine/tool-contract-matcher.js";
import {
  defaultRecipientSourceDescription,
  noSlopSpecDeliveryTargetSchema,
  noSlopSpecDraftSchema,
  noSlopSpecSchema,
  noSlopSpecSnapshotSchema,
  noSlopSpecStatusSchema,
  type NoSlopSpec,
  type NoSlopSpecSnapshot,
  type NoSlopSpecStatus,
} from "../loop-engine/spec-contracts.js";
import { inferInputRequirementsForSpec } from "./intent-templates.js";
import { sanitizeInputRequirementsForDelivery } from "../loop-engine/input-surfaces.js";

export type LoopSpecView = {
  id: string;
  slug: string;
  title: string;
  status: NoSlopSpecStatus;
  version: number;
  sourcePrompt: string;
  bodyMarkdown: string;
  specJson: NoSlopSpec;
  approvedAt: string | null;
  approvedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type LoopSpecRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  version: number;
  source_prompt: string;
  body_markdown: string;
  spec_json: unknown;
  approved_at: string | Date | null;
  approved_by_user_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "loop-spec";
}

function titleFromPurpose(purpose: string): string {
  const normalized = purpose.trim().replace(/\s+/g, " ");
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized || "Loop spec";
}

function renderSpecMarkdown(spec: NoSlopSpec): string {
  const lines = [
    `# ${titleFromPurpose(spec.purpose)}`,
    "",
    "## Purpose",
    spec.purpose,
    "",
    "## Agents",
  ];

  for (const agent of spec.agents) {
    lines.push("", `### ${agent.name}`, `- Goal: ${agent.goal}`);
    for (const guardrail of agent.guardrails) lines.push(`- Guardrail: ${guardrail}`);
    for (const done of agent.doneWhen) lines.push(`- Done when: ${done}`);
    for (const failure of agent.failureModes) lines.push(`- Failure mode: ${failure}`);
  }

  lines.push("", "## Guardrails");
  for (const guardrail of spec.guardrails.length ? spec.guardrails : ["No additional global guardrails."]) {
    lines.push(`- ${guardrail}`);
  }

  lines.push("", "## Success Criteria");
  for (const criterion of spec.successCriteria.length ? spec.successCriteria : ["The loop produces the requested reviewed artifact."]) {
    lines.push(`- ${criterion}`);
  }

  lines.push("", "## Failure Modes");
  for (const failure of spec.failureModes.length ? spec.failureModes : ["If required input is missing, pause for operator input."]) {
    lines.push(`- ${failure}`);
  }

  lines.push(
    "",
    "## Connector Policy",
    `Delivery expectation: ${spec.connectorPolicy.deliveryExpectation}`,
    `Recipient source: ${spec.connectorPolicy.recipientSource.kind}${spec.connectorPolicy.recipientSource.description ? ` — ${spec.connectorPolicy.recipientSource.description}` : ""}`,
  );
  lines.push("", "### Approved Internal Tools");
  lines.push(`- Read tools: ${spec.connectorPolicy.approvedInternalTools.readToolRefs.join(", ")}`);
  lines.push(`- Write tools: ${spec.connectorPolicy.approvedInternalTools.writeToolRefs.join(", ")}`);
  if (spec.connectorPolicy.approvedComposioToolkits.length > 0) {
    lines.push("", "### Approved Composio Toolkits");
    for (const toolkit of spec.connectorPolicy.approvedComposioToolkits) {
      lines.push(`- ${toolkit}`);
    }
  }
  if (spec.connectorPolicy.enabledToolkits.length > 0) {
    lines.push("", "### Enabled Toolkits");
    for (const toolkit of spec.connectorPolicy.enabledToolkits) lines.push(`- ${toolkit}`);
  }
  for (const action of spec.connectorPolicy.allowedReadActions) {
    lines.push(`- Read action: ${action.toolkit}/${action.actionSlug} (${action.risk})`);
  }
  for (const action of spec.connectorPolicy.allowedWriteActions) {
    lines.push(`- Write action: ${action.toolkit}/${action.actionSlug} (${action.risk}, pre-send approval required)`);
  }
  for (const action of spec.connectorPolicy.allowedWriteActions) {
    lines.push(`- Write action: ${action.toolkit}/${action.actionSlug} (${action.risk}, pre-send approval required)`);
  }

  return lines.join("\n");
}

function resolveSubscriberRecipientSource(
  recipientSource: { kind: string; description?: string },
  needsSubscriberRecipients: boolean,
): { kind: "none" | "configured" | "uploaded" | "operator_input"; description?: string } {
  if (!needsSubscriberRecipients) {
    return recipientSource as { kind: "none" | "configured" | "uploaded" | "operator_input"; description?: string };
  }
  const kind = recipientSource.kind === "none" ? "uploaded" : recipientSource.kind;
  const description = recipientSource.description?.trim()
    || defaultRecipientSourceDescription(kind);
  return { kind: kind as "configured" | "uploaded" | "operator_input", description };
}

function normalizeGeneratedSpec(input: NoSlopSpec, prompt: string): NoSlopSpec {
  const target = input.delivery.target ?? "none";
  const connectorPolicy = input.connectorPolicy ?? undefined;
  const recipientSource = connectorPolicy?.recipientSource ?? { kind: "none" as const };
  const needsSubscriberRecipients = target === "subscriber_list";
  const defaultFailureModes = needsSubscriberRecipients
    ? ["Pause at pre_send for operator contact upload when no recipients are configured."]
    : [];
  const defaultSuccessCriteria = needsSubscriberRecipients
    ? ["Delivery completes only after operator confirms recipients."]
    : [];

  return noSlopSpecDraftSchema.parse({
    ...input,
    schedule: {
      ...input.schedule,
      ...(input.schedule.cron ? { cron: normalizeDesignCron(input.schedule.cron, prompt) } : {}),
      timezone: input.schedule.timezone?.trim() || "UTC",
    },
    delivery: {
      ...input.delivery,
      target,
    },
    successCriteria: input.successCriteria.length > 0 ? input.successCriteria : defaultSuccessCriteria,
    failureModes: input.failureModes.length > 0 ? input.failureModes : defaultFailureModes,
    inputRequirements: sanitizeInputRequirementsForDelivery(
      input.inputRequirements?.length
        ? input.inputRequirements
        : inferInputRequirementsForSpec(input, prompt),
      target,
    ),
    connectorPolicy: connectorPolicy
      ? {
          ...connectorPolicy,
          recipientSource: resolveSubscriberRecipientSource(recipientSource, needsSubscriberRecipients),
        }
      : undefined,
  });
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function actionPolicyFromCandidate(candidate: ConnectorDeliveryActionCandidate) {
  return {
    toolkit: candidate.toolkit,
    actionSlug: candidate.actionSlug,
    risk: "send" as const,
    description: `${candidate.name}: ${candidate.description || candidate.reason}`,
    requiresPreSendApproval: true,
  };
}

function scoreRawWriteAction(action: unknown, target: NoSlopSpec["delivery"]["target"]): number {
  const row = readObject(action);
  const toolkit = typeof row.toolkit === "string" ? row.toolkit : "";
  const actionSlug = typeof row.actionSlug === "string" ? row.actionSlug : "";
  const description = typeof row.description === "string" ? row.description : "";
  const risk = typeof row.risk === "string" ? row.risk : "";
  if (!toolkit || !actionSlug) return 0;
  return scoreConnectorPolicyForDelivery({ toolkit, actionSlug, description, risk }, target);
}

function deliveryCapableWriteActions(rawSpec: unknown, target: NoSlopSpec["delivery"]["target"]): unknown[] {
  const connectorPolicy = readObject(readObject(rawSpec).connectorPolicy);
  const existingWriteActions = Array.isArray(connectorPolicy.allowedWriteActions)
    ? connectorPolicy.allowedWriteActions
    : [];
  return existingWriteActions.filter((action) => scoreRawWriteAction(action, target) > 0);
}

/** Strip contact/draft/non-send write policies and inject a connected delivery candidate when needed. */
export function prepareLoopSpecJsonForValidation(
  rawSpec: unknown,
  candidate: ConnectorDeliveryActionCandidate | null,
): unknown {
  const root = readObject(rawSpec);
  const delivery = readObject(root.delivery);
  const parsedTarget = noSlopSpecDeliveryTargetSchema.safeParse(delivery.target ?? "none");
  const target = parsedTarget.success ? parsedTarget.data : "none";
  if (target === "none") return rawSpec;

  const connectorPolicy = readObject(root.connectorPolicy);
  const existingWriteActions = Array.isArray(connectorPolicy.allowedWriteActions)
    ? connectorPolicy.allowedWriteActions
    : [];
  const capable = deliveryCapableWriteActions(rawSpec, target);
  let prepared: Record<string, unknown> = capable.length === existingWriteActions.length
    ? root
    : {
        ...root,
        connectorPolicy: {
          ...connectorPolicy,
          allowedWriteActions: capable,
        },
      };

  const existingBest = capable.reduce<number>((max, action) => Math.max(max, scoreRawWriteAction(action, target)), 0);
  if (candidate && (capable.length === 0 || existingBest < candidate.score)) {
    prepared = readObject(applyDeliveryCandidateToRawSpec(prepared, candidate));
  }

  return prepared;
}

function applyDeliveryCandidateToRawSpec(rawSpec: unknown, candidate: ConnectorDeliveryActionCandidate | null): unknown {
  if (!candidate) return rawSpec;
  const root = readObject(rawSpec);
  const delivery = readObject(root.delivery);
  const parsedTarget = noSlopSpecDeliveryTargetSchema.safeParse(delivery.target ?? "none");
  const target = parsedTarget.success ? parsedTarget.data : "none";
  if (target === "none") return rawSpec;

  const connectorPolicy = readObject(root.connectorPolicy);
  const capable = deliveryCapableWriteActions(rawSpec, target);
  const existingBest = capable.reduce<number>((max, action) => Math.max(max, scoreRawWriteAction(action, target)), 0);
  if (capable.length > 0 && existingBest >= candidate.score) return rawSpec;

  return {
    ...root,
    connectorPolicy: {
      ...connectorPolicy,
      enabledToolkits: [...new Set([
        ...(Array.isArray(connectorPolicy.enabledToolkits) ? connectorPolicy.enabledToolkits.filter((v): v is string => typeof v === "string") : []),
        candidate.toolkit,
      ])],
      allowedWriteActions: [actionPolicyFromCandidate(candidate)],
      recipientSource: (() => {
        const kind = readObject(connectorPolicy.recipientSource).kind;
        const resolvedKind = typeof kind === "string" && kind !== "none"
          ? kind
          : target === "subscriber_list"
            ? "uploaded"
            : "operator_input";
        const existingDescription = typeof readObject(connectorPolicy.recipientSource).description === "string"
          ? readObject(connectorPolicy.recipientSource).description as string
          : undefined;
        return {
          kind: resolvedKind,
          description: existingDescription?.trim() || defaultRecipientSourceDescription(resolvedKind),
        };
      })(),
      deliveryExpectation: connectorPolicy.deliveryExpectation ?? `Send via ${candidate.toolkit}/${candidate.actionSlug} after per-run approval.`,
    },
  };
}

async function bestDeliveryCandidateForRawSpec(auth: AuthContext, rawSpec: unknown): Promise<ConnectorDeliveryActionCandidate | null> {
  const delivery = readObject(readObject(rawSpec).delivery);
  const parsedTarget = noSlopSpecDeliveryTargetSchema.safeParse(delivery.target ?? "none");
  if (!parsedTarget.success || parsedTarget.data === "none") return null;
  return selectBestDeliveryAction({ auth, target: parsedTarget.data });
}

function toIsoTimestamp(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function hydrateLoopSpecJson(
  auth: AuthContext,
  rawSpec: unknown,
  options?: { mode?: "draft" | "approved" },
): Promise<NoSlopSpec> {
  const mode = options?.mode ?? "approved";
  const normalized = normalizeSpecJson(rawSpec);
  const candidate = await bestDeliveryCandidateForRawSpec(auth, normalized);
  const prepared = prepareLoopSpecJsonForValidation(normalized, candidate);
  const parsedTarget = noSlopSpecDeliveryTargetSchema.safeParse(readObject(readObject(prepared).delivery).target ?? "none");
  if (
    mode === "approved"
    && parsedTarget.success
    && parsedTarget.data !== "none"
    && deliveryCapableWriteActions(prepared, parsedTarget.data).length === 0
  ) {
    throw new Error(
      "Outbound delivery requires a connected send app (e.g. Resend under Connected Apps). "
      + "Connect your provider under Connected Apps, then re-draft or refine the spec.",
    );
  }
  const schema = mode === "draft" ? noSlopSpecDraftSchema : noSlopSpecSchema;
  return schema.parse(prepared);
}

async function mapSpecRow(
  auth: AuthContext,
  row: LoopSpecRow,
  options?: { persistRepair?: boolean },
): Promise<LoopSpecView> {
  const specJson = await hydrateLoopSpecJson(auth, row.spec_json, {
    mode: row.status === "approved" ? "approved" : "draft",
  });
  if (options?.persistRepair && row.status === "approved") {
    const repaired = JSON.stringify(specJson);
    const stored = typeof row.spec_json === "string" ? row.spec_json : JSON.stringify(row.spec_json);
    if (repaired !== stored) {
      await pool.query(
        `UPDATE loop_specs
         SET spec_json = $4::jsonb, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [row.id, auth.tenantId, auth.userId, repaired],
      );
    }
  }

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: noSlopSpecStatusSchema.parse(row.status),
    version: row.version,
    sourcePrompt: row.source_prompt,
    bodyMarkdown: row.body_markdown,
    specJson,
    approvedAt: toIsoTimestamp(row.approved_at),
    approvedByUserId: row.approved_by_user_id,
    createdAt: toIsoTimestamp(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoTimestamp(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/** Synchronous mapper for unit tests with already-valid spec JSON. */
export function mapLoopSpecRowForTest(row: LoopSpecRow): LoopSpecView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: noSlopSpecStatusSchema.parse(row.status),
    version: row.version,
    sourcePrompt: row.source_prompt,
    bodyMarkdown: row.body_markdown,
    specJson: noSlopSpecSchema.parse(row.spec_json),
    approvedAt: toIsoTimestamp(row.approved_at),
    approvedByUserId: row.approved_by_user_id,
    createdAt: toIsoTimestamp(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoTimestamp(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function normalizeSpecJson(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (!trimmed) return input;
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

function specSystemPrompt(): string {
  return [
    "You draft human-reviewed no-slop specs for recurring Tallei agent loops.",
    "Return JSON only. Do not return markdown.",
    "The spec is the behavioral source of truth a user approves before agents are generated.",
    "Write precise goals, guardrails, success criteria, and failure modes.",
    "delivery.target MUST be exactly one of: subscriber_list, team_email, operator, none. Never use connected_app or other invented values — use subscriber_list for newsletter/broadcast via Connected Apps.",
    "Default to delivery.target none unless the user explicitly asks the loop to send, post, publish, create, update, or delete through a connected app.",
    "Do not require full delivery configuration in the draft spec. Recipients, audience IDs, and final send approval are collected at runtime by specialist agents and pre_send gates — not as upfront user inputs.",
    "If outbound delivery is requested, describe the intent in delivery.description. connectorPolicy.allowedWriteActions may be omitted in drafts; they are bound from Connected Apps at approve/generate. Never let agents invent recipients.",
    "For subscriber_list delivery, set recipientSource.kind to uploaded, configured, or operator_input with a short description of how recipients arrive at pre_send.",
    "Include failureModes: Pause at pre_send for operator contact upload when no recipients are configured.",
    "Include successCriteria: Delivery completes only after operator confirms recipients.",
    "Declare inputRequirements for runtime checkpoints only — never block build-time generation.",
    "inputRequirements[].surface MUST be one of: input.text, input.markdown, input.contacts_csv, input.audience_id, input.file, review.draft, review.email, confirm.send. Never invent types like input.boolean.",
    "Use canonical keys only: sprint_notes (run_start, team_email ONLY), recipients (before_send upload), audience_id (before_send configured), confirm_send (before_send approval). Never use recipients_upload or pre_send_confirm.",
    "Internal sync / team email ONLY: { key: sprint_notes, surface: input.markdown, when: run_start }.",
    "Newsletter / research / subscriber_list workflows: NO run_start content inputs — agents gather content via web_search and memory_search. Runtime inputs are before_send only (audience_id, recipients, confirm_send).",
    "Subscriber send: recipients or audience_id with when: before_send aligned to recipientSource.kind.",
    "When Connected Apps external-effect candidates are listed, choose only actions whose skills/resources/effects match the requested workflow. Do not infer hidden capabilities from provider names.",
    "Use a 5-field cron only when cadence is clear; otherwise describe the schedule in schedule.description and omit schedule.cron entirely.",
    "schedule.timezone must be a valid IANA timezone such as UTC when provided; omit schedule.timezone if unknown (defaults to UTC).",
    "STRICT JSON: never use empty strings for optional fields. Omit optional keys entirely instead of setting them to \"\".",
    "Required string fields (purpose, schedule.description, agent.name, agent.goal) must be non-empty.",
    "",
    "JSON shape:",
    JSON.stringify({
      purpose: "One sentence describing the recurring outcome.",
      agents: [
        {
          name: "Research Agent",
          goal: "Concrete success condition.",
          guardrails: ["Constraint this agent must obey."],
          doneWhen: ["Observable completion condition."],
          failureModes: ["When to pause or stop."],
        },
      ],
      guardrails: ["Global behavioral constraint."],
      successCriteria: ["End-to-end success criterion."],
      failureModes: ["End-to-end failure mode."],
      schedule: { description: "Weekly on Friday morning", cron: "0 9 * * 5", timezone: "UTC" },
      delivery: { target: "none", description: "Dashboard only; no outbound delivery." },
      connectorPolicy: {
        enabledToolkits: [],
        approvedInternalTools: {
          readToolRefs: ["internal.web_search", "internal.memory_search"],
          writeToolRefs: ["internal.llm_only"],
        },
        approvedComposioToolkits: [],
        allowedReadActions: [],
        allowedWriteActions: [],
        recipientSource: { kind: "none" },
        deliveryExpectation: "No outbound delivery.",
      },
      inputRequirements: [],
    }, null, 2),
  ].join("\n");
}

const SPEC_GENERATION_MAX_RETRIES = 2;

function formatSpecValidationIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}

function parsePreparedSpecJson(prepared: unknown, prompt: string): NoSlopSpec {
  return normalizeGeneratedSpec(noSlopSpecDraftSchema.parse(prepared), prompt);
}

async function generateSpecJson(input: {
  auth: AuthContext;
  prompt: string;
  feedback?: string;
  currentSpec?: LoopSpecView;
}): Promise<NoSlopSpec> {
  const [subscriberCandidates, teamCandidates] = await Promise.all([
    listDeliveryActionCandidates({ auth: input.auth, target: "subscriber_list" }).catch(() => []),
    listDeliveryActionCandidates({ auth: input.auth, target: "team_email" }).catch(() => []),
  ]);
  const candidateBlock = [
    "Connected Apps external-effect action candidates:",
    ...[...subscriberCandidates, ...teamCandidates]
      .slice(0, 12)
      .map((candidate) => `- ${candidate.toolRef} (${candidate.reason}, score ${candidate.score})`),
    subscriberCandidates.length === 0 && teamCandidates.length === 0
      ? "- none discovered; default delivery.target to none until a matching external-effect app is connected under Connected Apps"
      : "",
  ].filter(Boolean).join("\n");

  let validationFixes: string[] = [];
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= SPEC_GENERATION_MAX_RETRIES; attempt += 1) {
    const sections = [
      `User loop request:\n${input.prompt}`,
      input.currentSpec ? `Current spec markdown:\n${input.currentSpec.bodyMarkdown}` : null,
      input.feedback ? `Requested refinement:\n${input.feedback}` : null,
      candidateBlock,
      validationFixes.length > 0
        ? `Required fixes from schema validation (address all):\n${validationFixes.map((fix) => `- ${fix}`).join("\n")}`
        : null,
    ].filter(Boolean).join("\n\n");

    try {
      const response = await loopBuilderOpenAiChat({
        responseFormat: "json_object",
        temperature: 0.2,
        maxTokens: 2500,
        reasoningEffort: "minimal",
        messages: [
          { role: "system", content: specSystemPrompt() },
          { role: "user", content: sections },
        ],
      });

      let rawSpec: unknown;
      try {
        rawSpec = JSON.parse(response.text);
      } catch (parseError) {
        throw new Error(`Failed to parse spec LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}\n\nResponse text (first 500 chars):\n${response.text.slice(0, 500)}`);
      }

      const candidate = await bestDeliveryCandidateForRawSpec(input.auth, rawSpec);
      const prepared = prepareLoopSpecJsonForValidation(rawSpec, candidate);
      return parsePreparedSpecJson(prepared, input.prompt);
    } catch (error) {
      lastError = error;
      if (error instanceof ZodError && attempt < SPEC_GENERATION_MAX_RETRIES) {
        validationFixes = formatSpecValidationIssues(error);
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Spec generation failed");
}

export async function draftLoopSpec(input: {
  auth: AuthContext;
  prompt: string;
}): Promise<LoopSpecView> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const specJson = await generateSpecJson({ auth: input.auth, prompt });
  const title = titleFromPurpose(specJson.purpose);
  const slug = slugify(title);
  const bodyMarkdown = renderSpecMarkdown(specJson);

  const result = await pool.query<LoopSpecRow>(
    `INSERT INTO loop_specs
       (tenant_id, user_id, slug, title, status, version, source_prompt, body_markdown, spec_json)
     VALUES ($1, $2, $3, $4, 'draft', 1, $5, $6, $7::jsonb)
     RETURNING id, slug, title, status, version, source_prompt, body_markdown, spec_json,
       approved_at, approved_by_user_id, created_at, updated_at`,
    [
      input.auth.tenantId,
      input.auth.userId,
      `${slug}-${Date.now().toString(36)}`,
      title,
      prompt,
      bodyMarkdown,
      JSON.stringify(specJson),
    ],
  );
  return mapSpecRow(input.auth, result.rows[0]);
}

export async function listLoopSpecs(auth: AuthContext): Promise<LoopSpecView[]> {
  const result = await pool.query<LoopSpecRow>(
    `SELECT id, slug, title, status, version, source_prompt, body_markdown, spec_json,
       approved_at, approved_by_user_id, created_at, updated_at
     FROM loop_specs
     WHERE tenant_id = $1 AND user_id = $2 AND status <> 'archived'
     ORDER BY updated_at DESC
     LIMIT 100`,
    [auth.tenantId, auth.userId],
  );
  return Promise.all(result.rows.map((row) => mapSpecRow(auth, row)));
}

export async function getLoopSpec(auth: AuthContext, specId: string): Promise<LoopSpecView | null> {
  const result = await pool.query<LoopSpecRow>(
    `SELECT id, slug, title, status, version, source_prompt, body_markdown, spec_json,
       approved_at, approved_by_user_id, created_at, updated_at
     FROM loop_specs
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [specId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ? mapSpecRow(auth, result.rows[0], { persistRepair: true }) : null;
}

export async function refineLoopSpec(input: {
  auth: AuthContext;
  specId: string;
  feedback: string;
}): Promise<LoopSpecView> {
  const current = await getLoopSpec(input.auth, input.specId);
  if (!current || current.status === "archived") throw new Error("Loop spec not found");
  if (current.status === "approved") throw new Error("Approved loop specs cannot be refined");
  const feedback = input.feedback.trim();
  if (!feedback) throw new Error("Feedback is required");
  const specJson = await generateSpecJson({
    auth: input.auth,
    prompt: current.sourcePrompt,
    feedback,
    currentSpec: current,
  });
  const title = titleFromPurpose(specJson.purpose);
  const bodyMarkdown = renderSpecMarkdown(specJson);
  const result = await pool.query<LoopSpecRow>(
    `UPDATE loop_specs
     SET title = $4,
         body_markdown = $5,
         spec_json = $6::jsonb,
         version = version + 1,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'draft'
     RETURNING id, slug, title, status, version, source_prompt, body_markdown, spec_json,
       approved_at, approved_by_user_id, created_at, updated_at`,
    [input.specId, input.auth.tenantId, input.auth.userId, title, bodyMarkdown, JSON.stringify(specJson)],
  );
  if (!result.rows[0]) throw new Error("Loop spec not found or not editable");
  return mapSpecRow(input.auth, result.rows[0]);
}

export async function approveLoopSpec(input: {
  auth: AuthContext;
  specId: string;
  bodyMarkdown?: string;
  specJson?: unknown;
}): Promise<LoopSpecView> {
  const current = await getLoopSpec(input.auth, input.specId);
  if (!current || current.status === "archived") throw new Error("Loop spec not found");
  if (current.status === "approved") return current;
  const bodyMarkdown = input.bodyMarkdown?.trim() || current.bodyMarkdown;
  if (!bodyMarkdown) throw new Error("Spec markdown is required");
  const rawSpec = normalizeSpecJson(input.specJson ?? current.specJson);
  const parsedSpec = await hydrateLoopSpecJson(input.auth, rawSpec);

  const result = await pool.query<LoopSpecRow>(
    `UPDATE loop_specs
     SET status = 'approved',
         body_markdown = $4,
         spec_json = $5::jsonb,
         approved_at = NOW(),
         approved_by_user_id = $3,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'draft'
     RETURNING id, slug, title, status, version, source_prompt, body_markdown, spec_json,
       approved_at, approved_by_user_id, created_at, updated_at`,
    [input.specId, input.auth.tenantId, input.auth.userId, bodyMarkdown, JSON.stringify(parsedSpec)],
  );
  if (!result.rows[0]) throw new Error("Loop spec not found or not approvable");
  return mapSpecRow(input.auth, result.rows[0]);
}

export async function archiveLoopSpec(auth: AuthContext, specId: string): Promise<void> {
  await pool.query(
    `UPDATE loop_specs
     SET status = 'archived', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [specId, auth.tenantId, auth.userId],
  );
}

export function approvedSpecSnapshot(spec: LoopSpecView): NoSlopSpecSnapshot {
  if (spec.status !== "approved" || !spec.approvedAt) {
    throw new Error("Loop spec must be approved before generation");
  }
  return noSlopSpecSnapshotSchema.parse({
    id: spec.id,
    slug: spec.slug,
    version: spec.version,
    title: spec.title,
    bodyMarkdown: spec.bodyMarkdown,
    specJson: spec.specJson,
    approvedAt: spec.approvedAt,
  });
}
