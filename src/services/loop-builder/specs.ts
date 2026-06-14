import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { ZodError } from "zod";
import { loopBuilderOpenAiChat } from "./openai-chat.js";
import {
  noSlopSpecDraftSchema,
  noSlopSpecSchema,
  noSlopSpecSnapshotSchema,
  noSlopSpecStatusSchema,
  type NoSlopSpec,
  type NoSlopSpecSnapshot,
  type NoSlopSpecStatus,
} from "../loop-engine/spec-contracts.js";
import { loopIntentContextSchema, type LoopIntentContext } from "../loop-engine/intent-context.js";
import { normalizeProviderIdentity } from "../loop-engine/spec-required-connectors.js";
import { listComposioToolkits } from "../connectors/composio.js";

export type LoopSpecView = {
  id: string;
  slug: string;
  title: string;
  status: NoSlopSpecStatus;
  version: number;
  sourcePrompt: string;
  intentContext?: LoopIntentContext;
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
  intent_context_json?: unknown;
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

export function renderSpecMarkdown(spec: NoSlopSpec): string {
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

  lines.push("", "## Delivery");
  if (spec.delivery.provider === "none") {
    lines.push("Dashboard only — no outbound delivery.");
  } else {
    lines.push(`Provider: ${spec.delivery.provider}`);
    lines.push(`Description: ${spec.delivery.description}`);
  }

  const hasConnectorActions = spec.connectorPolicy.allowedReadActions.length > 0
    || spec.connectorPolicy.allowedWriteActions.length > 0;
  if (hasConnectorActions || spec.delivery.provider !== "none") {
    lines.push("", "## Connector Policy");
    if (spec.connectorPolicy.allowedWriteActions.length === 0 && spec.delivery.provider !== "none") {
      lines.push("- Send actions are bound from Connected Apps when the spec is approved.");
    }
    for (const action of spec.connectorPolicy.allowedReadActions) {
      lines.push(`- Read action: ${action.toolkit}/${action.actionSlug} (${action.risk})`);
    }
    for (const action of spec.connectorPolicy.allowedWriteActions) {
      lines.push(`- Write action: ${action.toolkit}/${action.actionSlug} (${action.risk}, pre-send approval required)`);
    }
  }

  return lines.join("\n");
}

export function renderIntentContextMarkdown(intentContext?: LoopIntentContext): string {
  if (!intentContext) return "";
  const lines = ["## Intent Decisions And Assumptions"];
  for (const decision of intentContext.decisions) {
    lines.push(`- ${decision.question} ${decision.answer} (${decision.source === "user" ? "answered" : "assumed"})`);
  }
  for (const assumption of intentContext.assumptions) lines.push(`- Assumption: ${assumption}`);
  return lines.join("\n");
}

export function specSemanticIssues(spec: NoSlopSpec, expectedProvider = ""): string[] {
  const expectedIdentity = normalizeProviderIdentity(expectedProvider);
  if (!expectedIdentity || normalizeProviderIdentity(spec.delivery.provider) === expectedIdentity) return [];
  return [
    `delivery.provider must preserve the explicitly requested available provider ${expectedProvider}; received ${spec.delivery.provider}.`,
  ];
}

function providerMentionPattern(value: string): RegExp | null {
  const words = value.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(`\\b${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^a-z0-9]+")}\\b`, "i");
}

async function explicitAvailableProvider(intent: string): Promise<string> {
  const toolkits = await listComposioToolkits().catch(() => []);
  const matches = toolkits.filter((toolkit) =>
    [toolkit.slug, toolkit.name].some((value) => providerMentionPattern(value)?.test(intent)));
  return matches.length === 1 ? matches[0]!.slug : "";
}

export function normalizeBehavioralSpec(spec: NoSlopSpec): NoSlopSpec {
  return spec;
}

function normalizeGeneratedSpec(input: NoSlopSpec): NoSlopSpec {
  const provider = input.delivery.provider?.trim() || "none";
  const connectorPolicy = input.connectorPolicy ?? undefined;

  return noSlopSpecDraftSchema.parse({
    ...input,
    schedule: {
      ...input.schedule,
      ...(input.schedule.timezone?.trim() ? { timezone: input.schedule.timezone.trim() } : {}),
    },
    delivery: {
      ...input.delivery,
      provider,
    },
    successCriteria: input.successCriteria,
    failureModes: input.failureModes,
    inputRequirements: input.inputRequirements ?? [],
    connectorPolicy,
  });
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toIsoTimestamp(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function hydrateLoopSpecJson(
  auth: AuthContext,
  rawSpec: unknown,
  options?: { mode?: "draft" | "approved"; intent?: string; validateSemantics?: boolean },
): Promise<NoSlopSpec> {
  const mode = options?.mode ?? "approved";
  const normalized = normalizeSpecJson(rawSpec);
  const schema = mode === "draft" ? noSlopSpecDraftSchema : noSlopSpecSchema;
  const parsed = schema.parse(normalized);
  if (mode === "approved" && options?.validateSemantics) {
    const semanticIssues = specSemanticIssues(parsed, await explicitAvailableProvider(options.intent ?? ""));
    if (semanticIssues.length > 0) {
      throw new Error(`Spec contains implementation details that cannot be approved: ${semanticIssues.join("; ")}`);
    }
  }
  return parsed;
}

async function mapSpecRow(
  auth: AuthContext,
  row: LoopSpecRow,
  options?: { persistRepair?: boolean },
): Promise<LoopSpecView> {
  const intentContext = row.intent_context_json
    ? loopIntentContextSchema.parse(row.intent_context_json)
    : undefined;
  const specJson = await hydrateLoopSpecJson(auth, row.spec_json, {
    mode: row.status === "approved" ? "approved" : "draft",
    intent: intentContext?.resolvedIntent ?? row.source_prompt,
  });
  if (options?.persistRepair) {
    const repaired = JSON.stringify(specJson);
    const stored = typeof row.spec_json === "string" ? row.spec_json : JSON.stringify(row.spec_json);
    const rendered = renderSpecMarkdown(specJson);
    if (repaired !== stored || rendered !== row.body_markdown) {
      await pool.query(
        `UPDATE loop_specs
         SET spec_json = $4::jsonb, body_markdown = $5, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [row.id, auth.tenantId, auth.userId, repaired, rendered],
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
    ...(intentContext ? { intentContext } : {}),
    bodyMarkdown: renderSpecMarkdown(specJson),
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
    ...(row.intent_context_json ? { intentContext: loopIntentContextSchema.parse(row.intent_context_json) } : {}),
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
    "Agents describe outcome-producing responsibilities only. Do not create agents whose job is collecting runtime inputs, preparing approval checkpoints, or presenting send packages.",
    "Keep implementation details out of agent goals, guardrails, doneWhen, and failureModes. Never mention tool refs, tool names, connector actions, review surfaces, or confirmation surfaces there.",
    "Tools are capabilities, not storage destinations. Never say work is saved, stored, or written to a search/retrieval tool.",
    "delivery.provider MUST be \"none\" unless the user explicitly names a delivery channel or connected app.",
    "Default to delivery.provider none unless the user explicitly asks the loop to send, post, publish, create, update, or delete through a connected app.",
    "Do not invent connector action inputs. Exact required inputs are resolved from the selected action schema at runtime.",
    "If outbound delivery is requested, describe the desired delivery behavior in delivery.description and set delivery.provider to the requested provider name when known.",
    "An explicitly named available provider is authoritative. Preserve that provider in delivery.provider; never substitute a different provider.",
    "Connector bindings are system-owned. Always leave connectorPolicy.allowedReadActions and connectorPolicy.allowedWriteActions empty.",
    "Declare inputRequirements for runtime checkpoints only — never block build-time generation.",
    "inputRequirements[].surface MUST be one of: input.text, input.markdown, input.contacts_csv, input.audience_id, input.file, review.draft, review.email, confirm.send. Never invent types like input.boolean.",
    "Use the user's requested input names and surfaces. Do not translate connector fields into recipient or audience aliases.",
    "Declare run_start content inputs only when the user explicitly requests or provides content that must be collected at runtime.",
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
      delivery: { provider: "none", description: "Dashboard only; no outbound delivery." },
      connectorPolicy: {
        allowedReadActions: [],
        allowedWriteActions: [],
      },
      inputRequirements: [],
    }, null, 2),
  ].join("\n");
}

const SPEC_GENERATION_MAX_RETRIES = 2;

class SpecSemanticError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("; "));
  }
}

function formatSpecValidationIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}

function parsePreparedSpecJson(prepared: unknown): NoSlopSpec {
  return normalizeGeneratedSpec(noSlopSpecDraftSchema.parse(prepared));
}

function stripModelExecutionBindings(rawSpec: unknown): unknown {
  const root = readObject(rawSpec);
  const connectorPolicy = readObject(root.connectorPolicy);
  const delivery = readObject(root.delivery);
  const provider = typeof delivery.provider === "string" ? delivery.provider.trim() : "none";
  return {
    ...root,
    delivery: {
      ...delivery,
      provider: provider || "none",
    },
    connectorPolicy: {
      ...connectorPolicy,
      allowedReadActions: [],
      allowedWriteActions: [],
    },
  };
}

export async function prepareGeneratedLoopSpec(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  rawSpec: unknown;
}): Promise<NoSlopSpec> {
  const expectedProvider = await explicitAvailableProvider(
    [input.prompt, input.intentContext?.resolvedIntent].filter(Boolean).join("\n"),
  );
  const behavioralSpec = normalizeBehavioralSpec(noSlopSpecDraftSchema.parse(input.rawSpec));
  const semanticIssues = specSemanticIssues(behavioralSpec, expectedProvider);
  if (semanticIssues.length > 0) throw new SpecSemanticError(semanticIssues);
  return parsePreparedSpecJson(stripModelExecutionBindings(behavioralSpec));
}

async function generateSpecJson(input: {
  auth: AuthContext;
  prompt: string;
  intentContext?: LoopIntentContext;
  feedback?: string;
  currentSpec?: LoopSpecView;
}): Promise<NoSlopSpec> {
  let validationFixes: string[] = [];
  let lastError: unknown = null;
  const expectedProvider = await explicitAvailableProvider(
    [input.prompt, input.intentContext?.resolvedIntent].filter(Boolean).join("\n"),
  );

  for (let attempt = 0; attempt <= SPEC_GENERATION_MAX_RETRIES; attempt += 1) {
    const sections = [
      `User loop request:\n${input.prompt}`,
      input.intentContext ? `Resolved intent decisions (authoritative over conflicting raw request wording):\n${input.intentContext.resolvedIntent}` : null,
      input.currentSpec ? `Current spec markdown:\n${input.currentSpec.bodyMarkdown}` : null,
      input.feedback ? `Requested refinement:\n${input.feedback}` : null,
      expectedProvider ? `Explicitly requested available provider (must be preserved exactly in delivery.provider):\n${expectedProvider}` : null,
      validationFixes.length > 0
        ? `Required fixes from schema validation (address all):\n${validationFixes.map((fix) => `- ${fix}`).join("\n")}`
        : null,
    ].filter(Boolean).join("\n\n");

    try {
      const response = await loopBuilderOpenAiChat({
        responseFormat: "json_object",
        temperature: 0.2,
        maxTokens: 2500,
        reasoningEffort: process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT ?? "minimal" as any,
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

      const behavioralSpec = normalizeBehavioralSpec(noSlopSpecDraftSchema.parse(rawSpec));
      const semanticIssues = specSemanticIssues(behavioralSpec, expectedProvider);
      if (semanticIssues.length > 0) throw new SpecSemanticError(semanticIssues);
      const withoutBindings = stripModelExecutionBindings(behavioralSpec);
      return parsePreparedSpecJson(withoutBindings);
    } catch (error) {
      lastError = error;
      if (error instanceof ZodError && attempt < SPEC_GENERATION_MAX_RETRIES) {
        validationFixes = formatSpecValidationIssues(error);
        continue;
      }
      if (error instanceof SpecSemanticError && attempt < SPEC_GENERATION_MAX_RETRIES) {
        validationFixes = error.issues;
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
  intentContext?: LoopIntentContext;
}): Promise<LoopSpecView> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const intentContext = input.intentContext ? loopIntentContextSchema.parse(input.intentContext) : undefined;
  const specJson = await generateSpecJson({ auth: input.auth, prompt, intentContext });
  return persistGeneratedLoopSpec({ auth: input.auth, prompt, intentContext, specJson });
}

export async function persistGeneratedLoopSpec(input: {
  auth: AuthContext;
  prompt: string;
  intentContext?: LoopIntentContext;
  specJson: NoSlopSpec;
}): Promise<LoopSpecView> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const intentContext = input.intentContext ? loopIntentContextSchema.parse(input.intentContext) : undefined;
  const specJson = parsePreparedSpecJson(input.specJson);
  const title = titleFromPurpose(specJson.purpose);
  const slug = slugify(title);
  const bodyMarkdown = renderSpecMarkdown(specJson);

  const result = await pool.query<LoopSpecRow>(
    `INSERT INTO loop_specs
       (tenant_id, user_id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json)
     VALUES ($1, $2, $3, $4, 'draft', 1, $5, $6, $7::jsonb, $8::jsonb)
     RETURNING id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json,
       approved_at, approved_by_user_id, created_at, updated_at`,
    [
      input.auth.tenantId,
      input.auth.userId,
      `${slug}-${Date.now().toString(36)}`,
      title,
      prompt,
      bodyMarkdown,
      JSON.stringify(specJson),
      intentContext ? JSON.stringify(intentContext) : null,
    ],
  );
  return mapSpecRow(input.auth, result.rows[0]);
}

export async function listLoopSpecs(auth: AuthContext): Promise<LoopSpecView[]> {
  const result = await pool.query<LoopSpecRow>(
    `SELECT id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json,
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
    `SELECT id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json,
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
    intentContext: current.intentContext,
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
     RETURNING id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json,
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
  const rawSpec = normalizeSpecJson(input.specJson ?? current.specJson);
  const parsedSpec = await hydrateLoopSpecJson(input.auth, rawSpec, {
    intent: current.intentContext?.resolvedIntent ?? current.sourcePrompt,
    validateSemantics: true,
  });
  const bodyMarkdown = renderSpecMarkdown(parsedSpec);

  const result = await pool.query<LoopSpecRow>(
    `UPDATE loop_specs
     SET status = 'approved',
         body_markdown = $4,
         spec_json = $5::jsonb,
         approved_at = NOW(),
         approved_by_user_id = $3,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'draft'
     RETURNING id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json,
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
    ...(spec.intentContext ? { intentContext: spec.intentContext } : {}),
    approvedAt: spec.approvedAt,
  });
}
