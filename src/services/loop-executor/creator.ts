import { createHash, randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { config } from "../../config/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { nextCronRunAt, validateFiveFieldCron } from "./cron.js";
import { LOOP_DEFINITION_VERSION, loopDefinitionSchema, type LoopDefinition, type LoopWorkflowView } from "./types.js";

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function titleFromTask(task: string): string {
  const normalized = normalizeText(task);
  if (/newsletter/i.test(normalized)) return "Newsletter Loop";
  if (/calendar/i.test(normalized)) return "Calendar Loop";
  if (/brief|summary|digest/i.test(normalized)) return "Recurring Brief Loop";
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

export async function requireLoopAdmin(auth: AuthContext): Promise<void> {
  if (auth.authMode === "internal") return;
  if (config.nodeEnv !== "production" && !config.adminEmail) return;
  if (!config.adminEmail) throw new Error("Loop creator admin email is not configured");

  const result = await pool.query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1 LIMIT 1`,
    [auth.userId]
  );
  const email = result.rows[0]?.email?.trim().toLowerCase();
  if (!email || email !== config.adminEmail.trim().toLowerCase()) {
    throw new Error("Loop creator is admin-only");
  }
}

export function buildLoopDefinition(input: {
  task: string;
  cron: string;
  timezone: string;
  integrations?: string[];
  schedulerTarget?: "internal" | "cloudflare";
}): LoopDefinition {
  const goal = normalizeText(input.task);
  const cron = validateFiveFieldCron(input.cron);
  const integrations = normalizeIntegrationList(input.integrations);
  const newsletterLike = /newsletter|weekly update|product update|publicist|publish/i.test(goal);

  const agents = newsletterLike
    ? [
      {
        id: "topic_researcher",
        name: "Topic Researcher",
        task: `Research and source useful context for this loop: ${goal}`,
        integration: "internal",
        toolPolicy: { allowedTools: ["research_topic" as const], draftBeforeExternalAction: true },
      },
      {
        id: "creative_writer",
        name: "Creative Writer",
        task: `Write the newsletter draft using only the research output and the loop goal: ${goal}`,
        integration: "internal",
        toolPolicy: { allowedTools: ["write_draft" as const], draftBeforeExternalAction: true },
      },
      {
        id: "publicist",
        name: "Publicist",
        task: `Prepare a publication or send plan for approval. Do not publish or send directly: ${goal}`,
        integration: "internal",
        toolPolicy: { allowedTools: ["prepare_publication_plan" as const], draftBeforeExternalAction: true },
      },
    ]
    : [
      {
        id: "researcher",
        name: "Researcher",
        task: `Gather source context for this recurring loop: ${goal}`,
        integration: "internal",
        toolPolicy: { allowedTools: ["research_topic" as const], draftBeforeExternalAction: true },
      },
      {
        id: "producer",
        name: "Producer",
        task: `Produce the requested recurring output from the research: ${goal}`,
        integration: "internal",
        toolPolicy: { allowedTools: ["write_draft" as const], draftBeforeExternalAction: true },
      },
      {
        id: "publisher",
        name: "Publisher",
        task: `Prepare the output for approval and external delivery. Do not commit external actions: ${goal}`,
        integration: "internal",
        toolPolicy: { allowedTools: ["prepare_publication_plan" as const], draftBeforeExternalAction: true },
      },
    ];

  return loopDefinitionSchema.parse({
    definitionVersion: LOOP_DEFINITION_VERSION,
    goal,
    schedule: { cron, timezone: input.timezone.trim() || "UTC" },
    schedulerTarget: input.schedulerTarget ?? config.loopExecutorScheduler,
    integrations,
    ceo: {
      name: "CEO",
      task: `Orchestrate this recurring loop, spawn each specialist once, pass structured output forward, and produce the final result: ${goal}`,
      policy: "Decide and coordinate only. Do not call specialist tools directly. All external actions must become approval drafts.",
    },
    agents,
    draftPolicy: {
      requireDraftBeforeExternalAction: true,
      approvalRequiredFor: ["publish", "send", "external_action"],
    },
  });
}

function mapLoopWorkflowRow(row: {
  id: string;
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
  task: string;
  cron?: string;
  timezone?: string;
  integrations?: string[];
  schedulerTarget?: "internal" | "cloudflare";
}): Promise<LoopWorkflowView> {
  await requireLoopAdmin(input.auth);
  const cron = input.cron ?? "0 9 * * 1";
  const definition = buildLoopDefinition({
    task: input.task,
    cron,
    timezone: input.timezone ?? "UTC",
    integrations: input.integrations,
    schedulerTarget: input.schedulerTarget,
  });

  const workflowId = randomUUID();
  const title = titleFromTask(input.task);
  const fingerprint = createHash("sha256")
    .update(`${LOOP_DEFINITION_VERSION}:${definition.goal}:${definition.schedule.cron}`)
    .digest("hex")
    .slice(0, 24);
  const nextRunAt = nextCronRunAt(definition.schedule.cron).toISOString();

  await pool.query(
    `INSERT INTO workflows
     (id, tenant_id, user_id, title, fingerprint, instruction, schedule_rrule, status, requires_connector, connector_provider, connector_scope_keys, metadata_json, definition_version, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', FALSE, NULL, '[]'::jsonb, $8::jsonb, $9, $10::timestamptz)`,
    [
      workflowId,
      input.auth.tenantId,
      input.auth.userId,
      title,
      fingerprint,
      definition.goal,
      definition.schedule.cron,
      JSON.stringify({
        source: "internal_loop_creator_v1",
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
    status: string;
    schedule_rrule: string;
    next_run_at: string | null;
    last_scheduled_at: string | null;
    metadata_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, title, status, schedule_rrule, next_run_at, last_scheduled_at, metadata_json, created_at, updated_at
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
    status: string;
    schedule_rrule: string;
    next_run_at: string | null;
    last_scheduled_at: string | null;
    metadata_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, title, status, schedule_rrule, next_run_at, last_scheduled_at, metadata_json, created_at, updated_at
     FROM workflows
     WHERE tenant_id = $1
       AND user_id = $2
       AND definition_version = $3
     ORDER BY updated_at DESC
     LIMIT 50`,
    [auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION]
  );
  return result.rows.map(mapLoopWorkflowRow);
}
