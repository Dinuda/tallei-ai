import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { reportLoopBuilderProgress } from "./progress.js";
import { enrichSpecAgentsWithPersonas } from "./agent-persona-enrichment.js";
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
import {
  loopBuildContractSchema,
  selectedArtifactContract,
  selectedExternalDataToolkits,
  selectedGroundingSources,
  selectedLoopTrigger,
  selectedOutputReviewGatesMode,
  selectedReviewPolicy,
  selectedStableInputs,
  type LoopBuildContract,
} from "../loop-engine/build-contract.js";
import { normalizeProviderIdentity } from "../loop-engine/spec-required-connectors.js";
import { listComposioToolkits } from "../connectors/composio.js";
import { validateAgentToolAssignments } from "./spec-available-tools.js";
import type { ToolContract } from "../tool-spec/types.js";
import { availableToolsForSpecDraft, type SpecAvailableTool } from "./spec-available-tools.js";
import { parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";
import {
  catalogInputContract,
  defaultHandoffBinding,
  deliveryOutputContract,
  draftOutputContract,
  evidenceOutputContract,
} from "../loop-runtime/agent-contract-catalog.js";

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
    if (agent.tools.length > 0) {
      lines.push(`- Tools: ${agent.tools.join(", ")}`);
    }
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

  if (spec.delivery.provider !== "none") {
    lines.push("", "## Connector Policy");
    lines.push("- Runtime actions are bound from the approved Connected Apps configuration.");
    lines.push("- Mutating delivery actions require the configured operator approval before execution.");
  }

  if (spec.buildContract) {
    lines.push("", "## Approved Build Contract");
    for (const requirement of spec.buildContract.requirements) {
      lines.push(`- ${requirement.kind}: ${requirement.status}${requirement.provenance ? ` (${requirement.provenance.source})` : ""}`);
      for (const warning of requirement.warnings) lines.push(`- Warning: ${warning}`);
    }
    const groundingSources = selectedGroundingSources(spec.buildContract);
    const externalToolkits = selectedExternalDataToolkits(spec.buildContract);
    if (groundingSources.length > 0 || externalToolkits.length > 0) {
      lines.push("", "## Grounding Sources");
      for (const source of groundingSources) {
        if (source.type === "tallei_memory") lines.push("- Tallei internal memory");
        else if (source.type === "workspace_memory") lines.push("- Workspace memory (includes inter-loop history)");
        else if (source.type === "knowledge_base") lines.push(`- Knowledge base: ${source.id}`);
        else if (source.type === "google_doc") lines.push(`- Google Doc knowledge base: ${source.id}`);
      }
      for (const toolkit of externalToolkits) {
        lines.push(`- External product/user data: composio.${toolkit}.search`);
      }
    }
  }

  return lines.join("\n");
}

export async function compileEnrichedRuntimeSpecSnapshot(input: {
  auth: AuthContext;
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
}): Promise<NoSlopSpecSnapshot> {
  const snapshot = compileRuntimeSpecSnapshot({
    prompt: input.prompt,
    intentContext: input.intentContext,
    buildContract: input.buildContract,
    discoveredToolContracts: input.discoveredToolContracts,
  });
  const enrichedSpecJson = await enrichSpecAgentsWithPersonas({
    auth: input.auth,
    specId: snapshot.id,
    specJson: snapshot.specJson,
  });
  return noSlopSpecSnapshotSchema.parse({
    ...snapshot,
    bodyMarkdown: renderSpecMarkdown(enrichedSpecJson),
    specJson: enrichedSpecJson,
  });
}

/** Persist an approved runtime snapshot so avatar rows can reference loop_specs(id). */
export async function persistApprovedLoopSpecSnapshot(
  auth: AuthContext,
  snapshot: NoSlopSpecSnapshot,
): Promise<void> {
  const parsed = noSlopSpecSnapshotSchema.parse(snapshot);
  const sourcePrompt = parsed.intentContext?.resolvedIntent?.trim()
    || parsed.specJson.purpose.trim()
    || parsed.title;
  await pool.query(
    `INSERT INTO loop_specs
       (id, tenant_id, user_id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json, approved_at, approved_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'approved', $6, $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz, $12)
     ON CONFLICT (id) DO UPDATE
       SET slug = EXCLUDED.slug,
           title = EXCLUDED.title,
           status = 'approved',
           version = EXCLUDED.version,
           source_prompt = EXCLUDED.source_prompt,
           body_markdown = EXCLUDED.body_markdown,
           spec_json = EXCLUDED.spec_json,
           intent_context_json = EXCLUDED.intent_context_json,
           approved_at = EXCLUDED.approved_at,
           approved_by_user_id = EXCLUDED.approved_by_user_id,
           updated_at = NOW()`,
    [
      parsed.id,
      auth.tenantId,
      auth.userId,
      parsed.slug,
      parsed.title,
      parsed.version,
      sourcePrompt,
      parsed.bodyMarkdown,
      JSON.stringify(parsed.specJson),
      parsed.intentContext ? JSON.stringify(parsed.intentContext) : null,
      parsed.approvedAt,
      auth.userId,
    ],
  );
}

export function compileRuntimeSpecSnapshot(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
}): NoSlopSpecSnapshot {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const intentContext = input.intentContext ? loopIntentContextSchema.parse(input.intentContext) : undefined;
  const buildContract = loopBuildContractSchema.parse(input.buildContract);
  reportLoopBuilderProgress({
    stage: "agent_spawn",
    message: "Building runtime agent contract from approved configuration…",
    status: "running",
  });
  const specJson = normalizeGeneratedSpec(buildRunnerSpecFromBuildContract({
    prompt,
    intentContext,
    buildContract,
    discoveredToolContracts: input.discoveredToolContracts ?? [],
  }));
  const title = titleFromPurpose(specJson.purpose);
  return noSlopSpecSnapshotSchema.parse({
    id: randomUUID(),
    slug: `${slugify(title)}-${Date.now().toString(36)}`,
    version: 1,
    title,
    bodyMarkdown: renderSpecMarkdown(specJson),
    specJson,
    ...(intentContext ? { intentContext } : {}),
    buildContract,
    approvedAt: new Date().toISOString(),
  });
}

function renderIntentContextMarkdown(intentContext?: LoopIntentContext): string {
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

function deriveInputRequirements(buildContract: LoopBuildContract): NoSlopSpec["inputRequirements"] {
  const requirements: NoSlopSpec["inputRequirements"] = [];
  for (const [name, value] of Object.entries(selectedStableInputs(buildContract))) {
    requirements.push({
      key: name,
      surface: "input.text",
      label: name.replace(/_/g, " "),
      required: true,
      when: "run_start",
      description: value,
    });
  }
  return requirements;
}

function scheduleDescription(buildContract: LoopBuildContract): { description: string; cron?: string; timezone?: string } {
  const trigger = selectedLoopTrigger(buildContract);
  if (trigger?.mode === "schedule") {
    return {
      description: `Approved schedule: ${trigger.cron} (${trigger.timezone})`,
      cron: trigger.cron,
      timezone: trigger.timezone,
    };
  }
  if (trigger?.mode === "event") {
    return { description: `Event-triggered via ${trigger.toolkit}:${trigger.triggerSlug}` };
  }
  return { description: "Runs on the approved trigger." };
}

function deliveryFromTools(sendTools: SpecAvailableTool[]): NoSlopSpec["delivery"] {
  const sendTool = sendTools[0];
  if (!sendTool) {
    return { provider: "none", description: "Dashboard only; no outbound delivery." };
  }
  const parsed = parseConnectorActionToolRef(sendTool.toolRef);
  const provider = parsed?.toolkit ?? sendTool.toolRef.replace(/^composio\.([^.]+)\.action\..+$/i, "$1");
  return {
    provider,
    description: `Deliver through ${sendTool.name}.`,
  };
}

export function buildRunnerSpecFromBuildContract(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
  feedback?: string;
}): NoSlopSpec {
  const buildContract = input.buildContract;
  const availableTools = availableToolsForSpecDraft(buildContract, input.discoveredToolContracts ?? []);
  const reviewPolicy = selectedReviewPolicy(buildContract) ?? "approve_each_action";
  const outputReviewGates = selectedOutputReviewGatesMode(buildContract);
  const wantsDraftReview = outputReviewGates === "review_drafts" || outputReviewGates === "review_drafts_and_send";
  const wantsPreSend = outputReviewGates === "review_drafts_and_send";
  const artifact = selectedArtifactContract(buildContract);
  const groundingSources = selectedGroundingSources(buildContract);
  const externalSearchToolkits = selectedExternalDataToolkits(buildContract);

  const connectorTools = availableTools.filter((tool) => !tool.toolRef.startsWith("internal."));
  const intakeTools = connectorTools.filter((tool) => tool.effect === "read_external");
  const mutatingTools = connectorTools.filter((tool) => tool.effect === "write_external" || tool.effect === "irreversible_external");

  const searchTools: string[] = [];
  if (groundingSources.some((source) => source.type === "tallei_memory" || source.type === "workspace_memory")) {
    searchTools.push("internal.memory_search");
  }
  for (const toolkit of externalSearchToolkits) {
    const ref = `composio.${toolkit}.search`;
    if (!searchTools.includes(ref)) searchTools.push(ref);
  }

  const intakeToolRefs = [...new Set([
    ...intakeTools.map((tool) => tool.toolRef),
    ...searchTools,
  ])];
  const draftRenderer = artifact?.mode === "supplied_template" ? "canvas.email" : "canvas.preview";
  const draftToolRefs = reviewPolicy === "draft_only" && mutatingTools.length > 0
    ? mutatingTools.map((tool) => tool.toolRef)
    : ["internal.llm_only"];
  const deliveryToolRefs = reviewPolicy === "draft_only"
    ? []
    : mutatingTools.map((tool) => tool.toolRef);

  const purposeBase = input.intentContext?.resolvedIntent?.trim() || input.prompt.trim();
  const purpose = input.feedback?.trim()
    ? `${purposeBase}\n\nRefinement: ${input.feedback.trim()}`
    : purposeBase;

  const agents: NoSlopSpec["agents"] = [];
  const agentIds: string[] = [];

  if (intakeToolRefs.length > 0) {
    const name = "Context Specialist";
    const agentId = "context_specialist";
    agentIds.push(agentId);
    agents.push({
      name,
      goal: "Gather trigger context, search connected sources, and produce structured evidence for downstream agents.",
      tools: intakeToolRefs,
      guardrails: ["Use only approved read and search tools.", "Do not draft or send outbound messages."],
      doneWhen: ["Structured evidence is ready for the next agent."],
      doneCriteria: ["Evidence matches the intake output contract."],
      failureModes: ["Pause for operator input when required context is missing."],
      inputContract: catalogInputContract("Trigger payload and stable configuration."),
      outputContract: evidenceOutputContract(),
      handoffBindings: [],
      artifactRole: "source_evidence",
    });
  }

  const draftAgentId = "draft_specialist";
  const priorAgentId = agentIds.at(-1);
  agentIds.push(draftAgentId);
  agents.push({
    name: "Draft Specialist",
    goal: artifact?.structure?.trim()
      ? `Produce the approved artifact: ${artifact.structure.trim()}`
      : "Produce the operator-reviewable draft defined by the output contract.",
    tools: draftToolRefs,
    guardrails: ["Use finalizeAgent output that matches the declared output contract.", "Do not send or publish directly unless this agent owns delivery tools."],
    doneWhen: ["Draft output matches the declared contract, or status is no_action_required when upstream evidence has no actionable item."],
    doneCriteria: ["Output is ready for operator review or downstream delivery, unless status is no_action_required."],
    failureModes: ["Pause when required upstream evidence is missing."],
    inputContract: catalogInputContract(priorAgentId ? "Evidence from the prior agent." : "Trigger payload and stable configuration."),
    outputContract: draftOutputContract(draftRenderer),
    handoffBindings: priorAgentId ? [defaultHandoffBinding(priorAgentId)] : [],
    artifactRole: draftRenderer === "canvas.email" ? "draft_body" : "final_preview",
    ...(wantsDraftReview ? {
      gate: {
        type: draftRenderer === "canvas.email" ? "draft_review" as const : "preview_review" as const,
        question: draftRenderer === "canvas.email"
          ? "Review the email draft before continuing."
          : "Review the draft before continuing.",
      },
    } : {}),
  });

  if (deliveryToolRefs.length > 0) {
    const name = "Delivery Specialist";
    const agentId = "delivery_specialist";
    const priorDeliveryAgentId = agentIds.at(-1);
    agentIds.push(agentId);
    agents.push({
      name,
      goal: "Deliver the approved output from upstream. Use requestGate type=action before any mutating connector action.",
      tools: deliveryToolRefs,
      guardrails: ["Use requestGate type=action before any mutating external action.", "Do not execute mutating connector actions without operator approval."],
      doneWhen: ["Delivery package is ready for operator confirmation."],
      doneCriteria: ["Delivery output matches the declared contract."],
      failureModes: ["Pause when upstream draft or approval is missing."],
      inputContract: catalogInputContract(priorDeliveryAgentId ? "Approved draft from the prior agent." : "Trigger payload and stable configuration."),
      outputContract: deliveryOutputContract(),
      handoffBindings: priorDeliveryAgentId ? [defaultHandoffBinding(priorDeliveryAgentId)] : [],
      artifactRole: "delivery",
      ...(wantsPreSend ? {
        gate: {
          type: "pre_send" as const,
          question: "Confirm delivery before sending.",
        },
      } : {}),
    });
  }

  const schedule = scheduleDescription(buildContract);
  const outcome = input.intentContext?.analysis.normalizedIntent.outcome ?? purpose;

  return noSlopSpecDraftSchema.parse({
    purpose,
    agents,
    guardrails: [
      "Use finalizeAgent for structured step output; do not narrate tool calls in prose.",
      "Mutating external actions require operator approval gates.",
    ],
    successCriteria: [outcome],
    failureModes: [
      "Pause for operator input when required context is missing.",
      "Do not proceed after a failed connector probe or missing approval.",
    ],
    schedule,
    delivery: deliveryFromTools(reviewPolicy === "draft_only" ? [] : availableTools.filter((tool) =>
      tool.effect === "write_external" || tool.effect === "irreversible_external",
    )),
    connectorPolicy: {
      allowedReadActions: [],
      allowedWriteActions: [],
    },
    inputRequirements: deriveInputRequirements(buildContract),
  });
}

export function specAtomicityIssues(spec: Pick<NoSlopSpec, "agents">): string[] {
  const issues: string[] = [];
  for (const agent of spec.agents) {
    const tools = agent.tools ?? [];
    const hasLlmOnly = tools.includes("internal.llm_only");
    const hasConnectorTool = tools.some((tool) => tool.startsWith("composio."));
    if (hasLlmOnly && hasConnectorTool) {
      issues.push(
        `${agent.name} mixes connector tools with internal.llm_only; split read/action work from synthesis before runtime execution.`,
      );
    }
  }
  return issues;
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

async function hydrateLoopSpecJson(
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

export async function draftLoopSpec(input: {
  auth: AuthContext;
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
}): Promise<LoopSpecView> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const intentContext = input.intentContext ? loopIntentContextSchema.parse(input.intentContext) : undefined;
  const buildContract = loopBuildContractSchema.parse(input.buildContract);
  reportLoopBuilderProgress({
    stage: "agent_spawn",
    message: "Building runner contract from approved configuration…",
    status: "running",
  });
  const specJson = buildRunnerSpecFromBuildContract({
    prompt,
    intentContext,
    buildContract,
    discoveredToolContracts: input.discoveredToolContracts ?? [],
  });
  return persistGeneratedLoopSpec({ auth: input.auth, prompt, intentContext, specJson, buildContract });
}

async function persistGeneratedLoopSpec(input: {
  auth: AuthContext;
  prompt: string;
  intentContext?: LoopIntentContext;
  specJson: NoSlopSpec;
  buildContract?: LoopBuildContract;
}): Promise<LoopSpecView> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const intentContext = input.intentContext ? loopIntentContextSchema.parse(input.intentContext) : undefined;
  const specJson = normalizeGeneratedSpec(noSlopSpecDraftSchema.parse({
    ...input.specJson,
    ...(input.buildContract ? { buildContract: input.buildContract } : {}),
  }));
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
  const inserted = result.rows[0];
  if (!inserted) throw new Error("Failed to persist loop spec");

  const enrichedSpecJson = await enrichSpecAgentsWithPersonas({
    auth: input.auth,
    specId: inserted.id,
    specJson,
  });
  const enrichedBodyMarkdown = renderSpecMarkdown(enrichedSpecJson);
  const enrichedResult = await pool.query<LoopSpecRow>(
    `UPDATE loop_specs
     SET body_markdown = $4, spec_json = $5::jsonb, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     RETURNING id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json,
       approved_at, approved_by_user_id, created_at, updated_at`,
    [inserted.id, input.auth.tenantId, input.auth.userId, enrichedBodyMarkdown, JSON.stringify(enrichedSpecJson)],
  );
  return mapSpecRow(input.auth, enrichedResult.rows[0] ?? inserted);
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
  discoveredToolContracts?: ToolContract[];
}): Promise<LoopSpecView> {
  const current = await getLoopSpec(input.auth, input.specId);
  if (!current || current.status === "archived") throw new Error("Loop spec not found");
  if (current.status === "approved") throw new Error("Approved loop specs cannot be refined");
  const feedback = input.feedback.trim();
  if (!feedback) throw new Error("Feedback is required");
  if (!current.specJson.buildContract) throw new Error("Loop spec has no build contract to recompile");
  reportLoopBuilderProgress({
    stage: "agent_spawn",
    message: "Rebuilding runner contract from approved configuration…",
    status: "running",
  });
  const specJson = buildRunnerSpecFromBuildContract({
    prompt: current.sourcePrompt,
    intentContext: current.intentContext,
    buildContract: current.specJson.buildContract,
    discoveredToolContracts: input.discoveredToolContracts ?? [],
    feedback,
  });
  const enrichedSpecJson = await enrichSpecAgentsWithPersonas({
    auth: input.auth,
    specId: input.specId,
    specJson,
    previousAgents: current.specJson.agents,
  });
  const title = titleFromPurpose(enrichedSpecJson.purpose);
  const bodyMarkdown = renderSpecMarkdown(enrichedSpecJson);
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
    [input.specId, input.auth.tenantId, input.auth.userId, title, bodyMarkdown, JSON.stringify(enrichedSpecJson)],
  );
  if (!result.rows[0]) throw new Error("Loop spec not found or not editable");
  return mapSpecRow(input.auth, result.rows[0]);
}

export async function approveLoopSpec(input: {
  auth: AuthContext;
  specId: string;
  bodyMarkdown?: string;
  specJson?: unknown;
  discoveredToolContracts?: ToolContract[];
}): Promise<LoopSpecView> {
  const current = await getLoopSpec(input.auth, input.specId);
  if (!current || current.status === "archived") throw new Error("Loop spec not found");
  if (current.status === "approved") return current;
  const rawSpec = normalizeSpecJson(input.specJson ?? current.specJson);
  const preserved = current.specJson.buildContract
    ? {
        ...readObject(rawSpec),
        schedule: current.specJson.schedule,
        buildContract: current.specJson.buildContract,
      }
    : rawSpec;
  const parsedSpec = await hydrateLoopSpecJson(input.auth, preserved, {
    intent: current.intentContext?.resolvedIntent ?? current.sourcePrompt,
    validateSemantics: true,
  });
  const buildContract = parsedSpec.buildContract;
  if (!buildContract) {
    throw new Error("Spec is missing build contract metadata required for approval.");
  }
  const toolIssues = validateAgentToolAssignments(
    parsedSpec,
    buildContract,
    input.discoveredToolContracts ?? [],
  );
  if (toolIssues.length > 0) {
    throw new Error(`Spec has invalid agent tool assignments: ${toolIssues.join("; ")}`);
  }
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
    ...(spec.specJson.buildContract ? { buildContract: spec.specJson.buildContract } : {}),
    approvedAt: spec.approvedAt,
  });
}
