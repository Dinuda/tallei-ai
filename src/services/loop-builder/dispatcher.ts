import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { discoverToolsForLoopBuild } from "../connectors/composio-discovery.js";
import {
  loopIntentAnalysisSchema,
  loopIntentContextSchema,
} from "../loop-engine/intent-context.js";
import {
  emptyLoopBuilderUsage,
  runWithLoopBuilderProgress,
  sanitizeLoopBuilderProgressDetails,
  type LoopBuilderProgressEvent,
  type LoopBuilderUsage,
} from "./progress.js";
import { approveLoopSpec, archiveLoopSpec, draftLoopSpec, refineLoopSpec } from "./specs.js";
import { refineLoopBuilderProposal, resolveLoopBuilderIntent, saveLoopBuilderProposal } from "./intent-resolver.js";
import {
  createWorkflowBuilderSession,
  requireWorkflowBuilderSession,
  updateWorkflowBuilderSession,
  type WorkflowBuilderPhase,
} from "./sessions.js";

export type BuilderToolName =
  | "getAvailableTools"
  | "draftSpec"
  | "refineSpec"
  | "approveSpec"
  | "archiveSpec"
  | "generateWorkflowGraph"
  | "refineWorkflowGraph"
  | "saveWorkflow";

export type WorkflowBuilderCommandView = {
  jobId: string;
  sessionId: string;
  kind: string;
  toolName: BuilderToolName;
  status: "pending" | "running" | "completed" | "failed" | "rejected";
  createdAt: string;
  updatedAt: string;
  events: LoopBuilderProgressEvent[];
  usage: LoopBuilderUsage;
  proposal?: unknown;
  spec?: unknown;
  intentAnalysis?: unknown;
  composioSessionId?: string;
  result?: Record<string, unknown>;
  error?: string;
};

type CommandRow = {
  id: string;
  session_id: string;
  tool_name: BuilderToolName;
  status: WorkflowBuilderCommandView["status"];
  events_json: LoopBuilderProgressEvent[];
  usage_json: LoopBuilderUsage;
  result_json: Record<string, unknown> | null;
  error_text: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const commandQueues = new Map<string, Promise<void>>();

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function legacyKind(toolName: BuilderToolName): string {
  return ({
    getAvailableTools: "analyze-intent",
    draftSpec: "draft-spec",
    refineSpec: "refine-spec",
    approveSpec: "approve-spec",
    archiveSpec: "archive-spec",
    generateWorkflowGraph: "propose",
    refineWorkflowGraph: "refine",
    saveWorkflow: "save",
  } satisfies Record<BuilderToolName, string>)[toolName];
}

function mapCommand(row: CommandRow): WorkflowBuilderCommandView {
  const result = row.result_json ?? {};
  return {
    jobId: row.id,
    sessionId: row.session_id,
    kind: legacyKind(row.tool_name),
    toolName: row.tool_name,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    events: row.events_json ?? [],
    usage: row.usage_json ?? emptyLoopBuilderUsage(),
    ...(result.proposal ? { proposal: result.proposal } : {}),
    ...(result.spec ? { spec: result.spec } : {}),
    ...(result.intentAnalysis ? { intentAnalysis: result.intentAnalysis } : {}),
    ...(typeof result.composioSessionId === "string" ? { composioSessionId: result.composioSessionId } : {}),
    ...(row.result_json ? { result } : {}),
    ...(row.error_text ? { error: row.error_text } : {}),
  };
}

function requirePhase(actual: WorkflowBuilderPhase, allowed: WorkflowBuilderPhase[], tool: BuilderToolName): void {
  if (!allowed.includes(actual)) {
    throw new Error(`${tool} is not available while the builder session is in phase ${actual}`);
  }
}

function requireApproval(input: Record<string, unknown>, tool: BuilderToolName): void {
  if (input.approved !== true) throw new Error(`${tool} requires explicit approval`);
}

async function execute(auth: AuthContext, sessionId: string, toolName: BuilderToolName, input: Record<string, unknown>) {
  const session = await requireWorkflowBuilderSession(auth, sessionId);
  switch (toolName) {
    case "getAvailableTools": {
      requirePhase(session.phase, ["new", "analyzing", "needs_clarification", "failed"], toolName);
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "analyzing", error: null });
      const normalizedIntent = input.normalizedIntent && typeof input.normalizedIntent === "object"
        ? input.normalizedIntent as Record<string, unknown>
        : {};
      const resolvedIntentText = String(input.resolvedIntent ?? normalizedIntent.outcome ?? session.goal).trim();
      if (!resolvedIntentText) throw new Error("getAvailableTools requires a normalized resolved intent");
      const analysis = loopIntentAnalysisSchema.parse({
        normalizedIntent: {
          outcome: String(normalizedIntent.outcome ?? resolvedIntentText),
          toolCategories: Array.isArray(normalizedIntent.toolCategories) ? normalizedIntent.toolCategories : [],
          cadence: String(normalizedIntent.cadence ?? "As needed"),
          approvalModel: String(normalizedIntent.approvalModel ?? "Operator approval before external mutations"),
          runtimeInputs: Array.isArray(normalizedIntent.runtimeInputs) ? normalizedIntent.runtimeInputs : [],
        },
        questions: [],
        assumptions: Array.isArray(input.assumptions) ? input.assumptions : [],
        connectorFeasibility: [],
        interactivePrompts: [],
        events: [],
        analyzedAt: new Date().toISOString(),
      });
      const resolvedIntent = loopIntentContextSchema.parse({
        analysis,
        decisions: [],
        assumptions: analysis.assumptions,
        resolvedIntent: resolvedIntentText,
        resolvedAt: new Date().toISOString(),
      });
      const discovered = await discoverToolsForLoopBuild({
        auth,
        prompt: resolvedIntentText,
        composioSessionId: session.composioSessionId,
        limit: 24,
      });
      if (discovered.sessionId !== session.composioSessionId) {
        throw new Error("Composio discovery did not reuse the persisted builder session");
      }
      const contracts = discovered.tools.map((entry) => ({
        ...entry.contract,
        constraints: { ...entry.contract.constraints, connected: entry.connected },
      }));
      await updateWorkflowBuilderSession(auth, sessionId, {
        phase: "intent_resolved",
        intentAnalysis: analysis,
        resolvedIntent,
        discoveredToolContracts: contracts,
      });
      return {
        intentAnalysis: analysis,
        intentContext: resolvedIntent,
        composioSessionId: discovered.sessionId,
        tools: discovered.tools.map((entry) => ({
          name: entry.contract.name,
          description: entry.contract.description,
          connected: entry.connected,
          risk: entry.contract.constraints.risk ?? null,
        })),
      };
    }
    case "draftSpec": {
      requirePhase(session.phase, ["intent_resolved"], toolName);
      if (!session.resolvedIntent) throw new Error("Resolved intent is required before drafting");
      const spec = await draftLoopSpec({ auth, prompt: session.goal, intentContext: session.resolvedIntent });
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "spec_drafted", spec });
      return { spec };
    }
    case "refineSpec": {
      requirePhase(session.phase, ["spec_drafted", "spec_approved", "graph_generated", "saved"], toolName);
      if (!session.specId) throw new Error("Session has no spec");
      const spec = await refineLoopSpec({ auth, specId: session.specId, feedback: String(input.feedback ?? "") });
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "spec_drafted", spec, currentProposal: null, workflowId: null });
      return { spec };
    }
    case "approveSpec": {
      requireApproval(input, toolName);
      requirePhase(session.phase, ["spec_drafted"], toolName);
      if (!session.specId) throw new Error("Session has no spec");
      const spec = await approveLoopSpec({ auth, specId: session.specId, specJson: input.specJson, bodyMarkdown: input.bodyMarkdown as string | undefined });
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "spec_approved", spec });
      return { spec };
    }
    case "archiveSpec": {
      requireApproval(input, toolName);
      if (!session.specId) throw new Error("Session has no spec");
      await archiveLoopSpec(auth, session.specId);
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "archived" });
      return { ok: true };
    }
    case "generateWorkflowGraph": {
      requirePhase(session.phase, ["spec_approved"], toolName);
      if (!session.specId) throw new Error("Session has no approved spec");
      const proposal = await resolveLoopBuilderIntent({
        auth, prompt: session.resolvedIntent?.resolvedIntent ?? session.goal, specId: session.specId,
        discoveredToolContracts: session.discoveredToolContracts,
      });
      proposal.definition.builderMeta = { ...proposal.definition.builderMeta, workflowBuilderSessionId: session.id };
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "graph_generated", currentProposal: proposal });
      return { proposal };
    }
    case "refineWorkflowGraph": {
      requirePhase(session.phase, ["graph_generated", "saved"], toolName);
      if (!session.currentProposal) throw new Error("Session has no workflow graph");
      const proposal = await refineLoopBuilderProposal({
        auth, prompt: session.goal, feedback: String(input.feedback ?? ""), priorProposal: session.currentProposal,
        specId: session.specId ?? undefined, discoveredToolContracts: session.discoveredToolContracts,
      });
      proposal.definition.builderMeta = { ...proposal.definition.builderMeta, workflowBuilderSessionId: session.id };
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "graph_generated", currentProposal: proposal });
      return { proposal };
    }
    case "saveWorkflow": {
      requireApproval(input, toolName);
      requirePhase(session.phase, ["graph_generated", "saved"], toolName);
      if (!session.currentProposal) throw new Error("Session has no workflow graph");
      const loop = await saveLoopBuilderProposal({
        auth, proposal: session.currentProposal, cron: input.cron as string | undefined,
        timezone: input.timezone as string | undefined, workspaceId: input.workspaceId as string | null | undefined,
      });
      const workflowId = String((loop as { id?: unknown }).id ?? "");
      await updateWorkflowBuilderSession(auth, sessionId, { phase: "saved", workflowId });
      return { loop };
    }
  }
}

async function runCommand(auth: AuthContext, commandId: string, sessionId: string, toolName: BuilderToolName, input: Record<string, unknown>) {
  await pool.query(`UPDATE workflow_builder_commands SET status = 'running', updated_at = NOW() WHERE id = $1`, [commandId]);
  try {
    const events: LoopBuilderProgressEvent[] = [];
    const usage = emptyLoopBuilderUsage();
    const result = await runWithLoopBuilderProgress({
      append: (event) => {
        const next = {
          ...event,
          ...(event.details !== undefined ? { details: sanitizeLoopBuilderProgressDetails(event.details) } : {}),
          id: events.length + 1,
          at: new Date().toISOString(),
        };
        events.push(next);
        if (event.model) usage.models[event.model] = (usage.models[event.model] ?? 0) + 1;
        if (event.promptTokens != null || event.completionTokens != null || event.totalTokens != null) {
          usage.calls += 1;
          usage.promptTokens += event.promptTokens ?? 0;
          usage.completionTokens += event.completionTokens ?? 0;
          usage.totalTokens += event.totalTokens ?? 0;
          usage.estimatedCostUsd = Number((usage.estimatedCostUsd + (event.estimatedCostUsd ?? 0)).toFixed(8));
        }
        void pool.query(
          `UPDATE workflow_builder_commands SET events_json = $2::jsonb, usage_json = $3::jsonb, updated_at = NOW() WHERE id = $1`,
          [commandId, JSON.stringify(events.slice(-100)), JSON.stringify(usage)],
        );
      },
    }, () => execute(auth, sessionId, toolName, input));
    await pool.query(
      `UPDATE workflow_builder_commands
       SET status = 'completed', result_json = $2::jsonb, events_json = $3::jsonb, usage_json = $4::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [commandId, JSON.stringify(result), JSON.stringify(events.slice(-100)), JSON.stringify(usage)],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE workflow_builder_commands SET status = 'failed', error_text = $2, updated_at = NOW() WHERE id = $1`,
      [commandId, message],
    );
    await updateWorkflowBuilderSession(auth, sessionId, { phase: "failed", error: { message } }).catch(() => undefined);
  }
}

export async function dispatchWorkflowBuilderCommand(input: {
  auth: AuthContext;
  sessionId?: string;
  toolName: BuilderToolName;
  input: Record<string, unknown>;
}): Promise<WorkflowBuilderCommandView> {
  const session = input.sessionId
    ? await requireWorkflowBuilderSession(input.auth, input.sessionId)
    : await createWorkflowBuilderSession(input.auth, String(input.input.prompt ?? ""));
  const commandId = randomUUID();
  const result = await pool.query<CommandRow>(
    `INSERT INTO workflow_builder_commands
       (id, session_id, tenant_id, user_id, tool_name, input_json, events_json, usage_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, $7::jsonb)
     RETURNING id, session_id, tool_name, status, events_json, usage_json, result_json, error_text, created_at, updated_at`,
    [commandId, session.id, input.auth.tenantId, input.auth.userId, input.toolName, JSON.stringify(input.input), JSON.stringify(emptyLoopBuilderUsage())],
  );
  const previous = commandQueues.get(session.id) ?? Promise.resolve();
  const queued = previous.then(() => runCommand(input.auth, commandId, session.id, input.toolName, input.input));
  commandQueues.set(session.id, queued.finally(() => {
    if (commandQueues.get(session.id) === queued) commandQueues.delete(session.id);
  }));
  return mapCommand(result.rows[0]!);
}

export async function getWorkflowBuilderCommand(auth: AuthContext, commandId: string): Promise<WorkflowBuilderCommandView | null> {
  const result = await pool.query<CommandRow>(
    `SELECT id, session_id, tool_name, status, events_json, usage_json, result_json, error_text, created_at, updated_at
     FROM workflow_builder_commands WHERE id = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1`,
    [commandId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ? mapCommand(result.rows[0]) : null;
}
