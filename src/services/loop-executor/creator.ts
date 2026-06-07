import { createHash, randomUUID } from "crypto";
import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { config } from "../../config/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { nextCronRunAt, normalizeDesignCron } from "./cron.js";
import { buildPlanFromAgentGraph } from "./plan.js";
import { presetToolRefsForDefinition } from "./presets/registry.js";
import {
  LOOP_DEFINITION_VERSION,
  LOOP_ENGINE_VERSION,
  loopAgentGraphSchema,
  loopDefinitionSchema,
  loopPlanSchema,
  type LoopAgentGraph,
  type LoopDefinition,
  type LoopDeliveryRouting,
  type LoopPlan,
  type LoopWorkflowView,
} from "./types.js";

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function titleFromTask(task: string): string {
  const normalized = normalizeText(task);
  return normalized.length > 70 ? `${normalized.slice(0, 67)}...` : normalized || "Loop Workflow";
}

function normalizeIntegrationList(integrations: string[] | undefined): string[] {
  const values = new Set(["internal"]);
  for (const integration of integrations ?? []) {
    const value = integration.trim().toLowerCase();
    if (value) values.add(value);
  }
  return [...values];
}

export async function requireLoopAdmin(_auth: AuthContext): Promise<void> {
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function parentAgentForGoal(goal: string): LoopAgentGraph["parent"] {
  return {
    id: "parent_agent",
    name: "Parent Agent",
    task: [
      "Own the recurring loop and ensure every run produces a real deliverable.",
      "Coordinate child agents, pass context between them, and gate every external action behind approval.",
      `Goal: ${goal}`,
    ].join(" "),
    policy: [
      "Understand the user's outcome, not just the task label.",
      "Route specialist work to child agents; do not execute child tools directly.",
      "Ground writer tasks in memory voice/style findings.",
      "Use Composio as the connector hub for external app integrations.",
    ].join(" "),
    connectorHub: {
      provider: "composio",
      label: "Composio",
      description: "Connector hub for external app integrations and future tool expansion.",
    },
  };
}

function buildParentAgentGraph(goal: string): LoopAgentGraph {
  return {
    parent: parentAgentForGoal(goal),
    children: [],
  };
}

export function buildLoopDefinition(input: {
  task: string;
  cron: string;
  timezone: string;
  integrations?: string[];
  allowedToolRefs?: string[];
  agentGraph?: LoopAgentGraph;
  plan?: LoopPlan;
  schedulerTarget?: "internal" | "cloudflare";
  presetId?: string;
  deliveryType?: string;
  delivery?: LoopDeliveryRouting;
  inputsRequired?: string[];
  engineVersion?: typeof LOOP_ENGINE_VERSION;
  builderMeta?: LoopDefinition["builderMeta"];
}): LoopDefinition {
  const goal = normalizeText(input.task);
  const cron = normalizeDesignCron(input.cron, input.task);
  const explicitPlan = input.plan ? loopPlanSchema.parse(input.plan) : undefined;
  const resolvedPresetId = input.presetId?.trim() || undefined;

  if (resolvedPresetId && explicitPlan?.stages.some((stage) => stage.kind === "approval_gate")) {
    throw new Error("Cannot combine presetId with a plan containing approval_gate stages; use an approval_handoff agent in agentGraph instead");
  }

  const allowedIntegrations = normalizeIntegrationList(input.integrations ?? explicitPlan?.allowedIntegrations);
  const agentGraph = input.agentGraph
    ? loopAgentGraphSchema.parse(input.agentGraph)
    : buildParentAgentGraph(goal);
  const derivedPlan = !explicitPlan
    && agentGraph.children.length > 0
    && !resolvedPresetId
    && !input.builderMeta
    ? buildPlanFromAgentGraph(goal, agentGraph, allowedIntegrations)
    : undefined;
  const plan = explicitPlan ?? derivedPlan;
  const resolvedAllowedToolRefs = input.allowedToolRefs?.length
    ? input.allowedToolRefs
    : uniqueStrings([
        ...(plan?.allowedToolRefs ?? []),
        ...agentGraph.children.flatMap((child) => child.tools.map((tool) => tool.ref)),
      ]);
  const definitionDraft = {
    definitionVersion: LOOP_DEFINITION_VERSION,
    goal,
    schedule: { cron, timezone: input.timezone.trim() || "UTC" },
    schedulerTarget: input.schedulerTarget ?? config.loopExecutorScheduler,
    allowedIntegrations,
    ...(resolvedAllowedToolRefs.length > 0 ? { allowedToolRefs: resolvedAllowedToolRefs } : {}),
    ceo: {
      name: agentGraph.parent.name,
      task: agentGraph.parent.task,
      policy: agentGraph.parent.policy,
    },
    draftPolicy: {
      requireDraftBeforeExternalAction: true,
      approvalRequiredFor: ["publish", "send", "external_action"],
    },
    ...(input.deliveryType?.trim() ? { deliveryType: input.deliveryType.trim() } : {}),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.inputsRequired?.length ? { inputsRequired: input.inputsRequired } : {}),
    ...(input.engineVersion ? { engineVersion: input.engineVersion } : {}),
    agentGraph,
    ...(plan ? { plan } : {}),
    ...(resolvedPresetId ? { presetId: resolvedPresetId } : {}),
    ...(input.builderMeta ? { builderMeta: input.builderMeta } : {}),
  } satisfies Partial<LoopDefinition>;
  const presetToolRefs = presetToolRefsForDefinition(definitionDraft as LoopDefinition);
  const finalAllowedToolRefs = presetToolRefs.length > 0
    ? [...new Set([...resolvedAllowedToolRefs, ...presetToolRefs])]
    : resolvedAllowedToolRefs;

  return loopDefinitionSchema.parse({
    definitionVersion: LOOP_DEFINITION_VERSION,
    goal,
    schedule: { cron, timezone: input.timezone.trim() || "UTC" },
    schedulerTarget: input.schedulerTarget ?? config.loopExecutorScheduler,
    allowedIntegrations,
    ...(finalAllowedToolRefs.length > 0 ? { allowedToolRefs: finalAllowedToolRefs } : {}),
    ceo: {
      name: agentGraph.parent.name,
      task: agentGraph.parent.task,
      policy: agentGraph.parent.policy,
    },
    draftPolicy: {
      requireDraftBeforeExternalAction: true,
      approvalRequiredFor: ["publish", "send", "external_action"],
    },
    ...(input.deliveryType?.trim() ? { deliveryType: input.deliveryType.trim() } : {}),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.inputsRequired?.length ? { inputsRequired: input.inputsRequired } : {}),
    ...(input.engineVersion ? { engineVersion: input.engineVersion } : {}),
    agentGraph,
    ...(plan ? { plan } : {}),
    ...(resolvedPresetId ? { presetId: resolvedPresetId } : {}),
    ...(input.builderMeta ? { builderMeta: input.builderMeta } : {}),
  });
}

export function buildLoopDefinitionFromCeoDesign(input: {
  goal: string;
  design: {
    agentGraph: LoopAgentGraph;
    schedule: { cron: string; timezone: string };
    deliveryType?: string;
    presetId?: string;
    builderMeta?: LoopDefinition["builderMeta"];
  };
  delivery?: LoopDeliveryRouting;
  inputsRequired?: string[];
  engineVersion?: typeof LOOP_ENGINE_VERSION;
}): LoopDefinition {
  const allowedToolRefs = uniqueStrings(
    input.design.agentGraph.children.flatMap((child) => child.tools.map((tool) => tool.ref)),
  );
  return buildLoopDefinition({
    task: input.goal,
    cron: input.design.schedule.cron,
    timezone: input.design.schedule.timezone,
    agentGraph: input.design.agentGraph,
    allowedToolRefs,
    presetId: input.design.presetId,
    deliveryType: input.design.deliveryType,
    delivery: input.delivery,
    inputsRequired: input.inputsRequired,
    engineVersion: input.engineVersion,
    builderMeta: input.design.builderMeta,
  });
}

function mapLoopWorkflowRow(row: {
  id: string;
  workspace_id: string | null;
  title: string;
  status: string;
  schedule_rrule: string;
  next_run_at: string | null;
  last_scheduled_at: string | null;
  metadata_json: unknown;
  created_at: string;
  updated_at: string;
}): LoopWorkflowView {
  const metadata = row.metadata_json && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
    ? row.metadata_json as Record<string, unknown>
    : {};
  const definition = loopDefinitionSchema.parse(metadata.loopDefinition);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    scheduleRrule: row.schedule_rrule,
    nextRunAt: row.next_run_at,
    lastScheduledAt: row.last_scheduled_at,
    definition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createLoopWorkflow(input: {
  auth: AuthContext;
  task?: string;
  cron?: string;
  timezone?: string;
  integrations?: string[];
  allowedToolRefs?: string[];
  agentGraph?: LoopAgentGraph;
  plan?: LoopPlan;
  schedulerTarget?: "internal" | "cloudflare";
  workspaceId?: string | null;
  presetId?: string;
  deliveryType?: string;
  builderMeta?: LoopDefinition["builderMeta"];
  /** Pre-validated definition from the loop builder — persisted as-is. */
  definition?: LoopDefinition;
  title?: string;
}): Promise<LoopWorkflowView> {
  await requireLoopAdmin(input.auth);
  const definition = input.definition
    ? loopDefinitionSchema.parse(input.definition)
    : buildLoopDefinition({
      task: input.task ?? "",
      cron: input.cron ?? "0 9 * * 1",
      timezone: input.timezone ?? "UTC",
      integrations: input.integrations,
      allowedToolRefs: input.allowedToolRefs,
      agentGraph: input.agentGraph,
      plan: input.plan,
      schedulerTarget: input.schedulerTarget,
      presetId: input.presetId,
      deliveryType: input.deliveryType,
      builderMeta: input.builderMeta,
    });

  const workflowId = randomUUID();
  const title = input.title?.trim() || titleFromTask(definition.goal);
  const fingerprint = createHash("sha256")
    .update(`${LOOP_DEFINITION_VERSION}:${definition.goal}:${definition.schedule.cron}`)
    .digest("hex")
    .slice(0, 24);
  const nextRunAt = nextCronRunAt(definition.schedule.cron).toISOString();

  await pool.query(
    `INSERT INTO workflows
     (id, tenant_id, user_id, workspace_id, title, fingerprint, instruction, schedule_rrule, status, requires_connector, connector_provider, connector_scope_keys, metadata_json, definition_version, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', FALSE, NULL, '[]'::jsonb, $9::jsonb, $10, $11::timestamptz)`,
    [
      workflowId,
      input.auth.tenantId,
      input.auth.userId,
      input.workspaceId ?? null,
      title,
      fingerprint,
      definition.goal,
      definition.schedule.cron,
      JSON.stringify({
        source: "internal_loop_creator_v2",
        loopDefinition: definition,
      }),
      LOOP_DEFINITION_VERSION,
      nextRunAt,
    ]
  );

  const created = await getLoopWorkflow(input.auth, workflowId);
  if (!created) throw new Error("Failed to create loop workflow");
  return created;
}

export async function getLoopWorkflow(auth: AuthContext, workflowId: string): Promise<LoopWorkflowView | null> {
  await requireLoopAdmin(auth);
  const result = await pool.query<{
    id: string;
    title: string;
    workspace_id: string | null;
    status: string;
    schedule_rrule: string;
    next_run_at: string | null;
    last_scheduled_at: string | null;
    metadata_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, workspace_id, title, status, schedule_rrule, next_run_at, last_scheduled_at, metadata_json, created_at, updated_at
     FROM workflows
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND definition_version = $4
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION]
  );
  const row = result.rows[0];
  return row ? mapLoopWorkflowRow(row) : null;
}

export async function listLoopWorkflows(auth: AuthContext): Promise<LoopWorkflowView[]> {
  await requireLoopAdmin(auth);
  const result = await pool.query<{
    id: string;
    title: string;
    workspace_id: string | null;
    status: string;
    schedule_rrule: string;
    next_run_at: string | null;
    last_scheduled_at: string | null;
    metadata_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, workspace_id, title, status, schedule_rrule, next_run_at, last_scheduled_at, metadata_json, created_at, updated_at
     FROM workflows
     WHERE tenant_id = $1
       AND user_id = $2
       AND definition_version = $3
       AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT 50`,
    [auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION]
  );
  return result.rows.map(mapLoopWorkflowRow);
}

export async function deleteLoopWorkflow(auth: AuthContext, workflowId: string): Promise<void> {
  await requireLoopAdmin(auth);
  const result = await pool.query(
    `UPDATE workflows
     SET status = 'archived', updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND definition_version = $4
       AND status = 'active'
     RETURNING id`,
    [workflowId, auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION],
  );
  if (!result.rowCount) {
    throw new Error("Loop workflow not found");
  }
}
