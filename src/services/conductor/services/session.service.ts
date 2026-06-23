import { randomUUID } from "crypto";
import { getToolName, isToolUIPart, type UIMessage } from "ai";

import type { AuthContext } from "../../../domain/auth/index.js";
import { createComposioSession } from "../../connectors/composio-session.js";
import type { LoopIntentAnalysis, LoopIntentContext } from "../contracts/intent-context.js";
import type { ToolContract } from "../../tool-spec/types.js";
import type { LoopBuilderProposal } from "./save-loop.service.js";
import type { LoopSpecView } from "./spec.service.js";
import type { LoopBuildContract } from "../domain/build-contract.js";
import type { LoopBuilderUsage } from "../utils/progress.js";
import { emptyLoopBuilderUsage } from "../utils/progress.js";
import {
  findWorkflowBuilderSessionRow,
  findWorkflowBuilderSessionRowBySpec,
  insertWorkflowBuilderSession,
  listWorkflowBuilderMessageRows,
  replaceWorkflowBuilderMessageRows,
  updateWorkflowBuilderAnalyzerUsageRow,
  updateWorkflowBuilderSessionRow,
  type SessionRow,
} from "../data/session.repository.js";
import type { WorkflowBuilderPhase } from "../contracts/builder-types.js";

export type { WorkflowBuilderPhase } from "../contracts/builder-types.js";

const POST_INTENT_PHASES = new Set<WorkflowBuilderPhase>([
  "spec_drafted",
  "spec_approved",
  "graph_generated",
  "saved",
]);

/** Keep later phases when reconnecting a connector after spec save/approval. */
export function phaseAfterRequirementsResolved(
  currentPhase: WorkflowBuilderPhase,
  unresolvedCount: number,
): WorkflowBuilderPhase {
  if (unresolvedCount > 0) return "resolving_requirements";
  if (POST_INTENT_PHASES.has(currentPhase)) return currentPhase;
  return "intent_resolved";
}

export type WorkflowBuilderSession = {
  id: string;
  phase: WorkflowBuilderPhase;
  title: string;
  goal: string;
  composioSessionId: string;
  workflowRunId: string | null;
  specId: string | null;
  workflowId: string | null;
  intentAnalysis: LoopIntentAnalysis | null;
  resolvedIntent: LoopIntentContext | null;
  discoveredToolContracts: ToolContract[];
  buildContract: LoopBuildContract | null;
  currentProposal: LoopBuilderProposal | null;
  error: { message: string } | null;
  revision: number;
  analyzerUsage: LoopBuilderUsage;
  createdAt: string;
  updatedAt: string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapSession(row: SessionRow): WorkflowBuilderSession {
  if (!row.composio_session_id) throw new Error(`Builder session ${row.id} has no Composio session`);
  return {
    id: row.id,
    phase: row.phase,
    title: row.title,
    goal: row.goal,
    composioSessionId: row.composio_session_id,
    workflowRunId: row.workflow_run_id,
    specId: row.spec_id,
    workflowId: row.workflow_id,
    intentAnalysis: row.intent_analysis_json,
    resolvedIntent: row.resolved_intent_json,
    discoveredToolContracts: row.discovered_tool_contracts_json ?? [],
    buildContract: row.build_contract_json,
    currentProposal: row.current_proposal_json,
    error: row.error_json,
    revision: row.revision,
    analyzerUsage: row.analyzer_usage_json ?? emptyLoopBuilderUsage(),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function createWorkflowBuilderSession(auth: AuthContext, goal: string): Promise<WorkflowBuilderSession> {
  const normalizedGoal = goal.trim();
  if (!normalizedGoal) throw new Error("A loop-building request is required");
  const composio = await createComposioSession(auth);
  const id = randomUUID();
  const row = await insertWorkflowBuilderSession(auth, {
    id,
    title: normalizedGoal.slice(0, 100),
    goal: normalizedGoal,
    composioSessionId: composio.sessionId,
  });
  return mapSession(row);
}

async function getWorkflowBuilderSession(auth: AuthContext, sessionId: string): Promise<WorkflowBuilderSession | null> {
  const row = await findWorkflowBuilderSessionRow(auth, sessionId);
  return row ? mapSession(row) : null;
}

export async function requireWorkflowBuilderSession(auth: AuthContext, sessionId: string): Promise<WorkflowBuilderSession> {
  const session = await getWorkflowBuilderSession(auth, sessionId);
  if (!session) throw new Error("Workflow builder session not found");
  return session;
}

export async function findWorkflowBuilderSessionBySpec(auth: AuthContext, specId: string): Promise<WorkflowBuilderSession | null> {
  const row = await findWorkflowBuilderSessionRowBySpec(auth, specId);
  return row ? mapSession(row) : null;
}

export async function updateWorkflowBuilderSession(
  auth: AuthContext,
  sessionId: string,
  patch: {
    phase?: WorkflowBuilderPhase;
    title?: string;
    goal?: string;
    composioSessionId?: string;
    workflowRunId?: string | null;
    spec?: LoopSpecView | null;
    workflowId?: string | null;
    intentAnalysis?: LoopIntentAnalysis | null;
    resolvedIntent?: LoopIntentContext | null;
    discoveredToolContracts?: ToolContract[];
    buildContract?: LoopBuildContract | null;
    currentProposal?: LoopBuilderProposal | null;
    error?: { message: string } | null;
  },
): Promise<WorkflowBuilderSession> {
  const row = await updateWorkflowBuilderSessionRow(auth, sessionId, [
    sessionId,
    auth.tenantId,
    auth.userId,
    patch.phase ?? null,
    "composioSessionId" in patch,
    patch.composioSessionId ?? null,
    "workflowRunId" in patch,
    patch.workflowRunId ?? null,
    "spec" in patch,
    patch.spec?.id ?? null,
    "workflowId" in patch,
    patch.workflowId ?? null,
    "intentAnalysis" in patch,
    patch.intentAnalysis ? JSON.stringify(patch.intentAnalysis) : null,
    "resolvedIntent" in patch,
    patch.resolvedIntent ? JSON.stringify(patch.resolvedIntent) : null,
    "discoveredToolContracts" in patch,
    JSON.stringify(patch.discoveredToolContracts ?? []),
    "buildContract" in patch,
    patch.buildContract ? JSON.stringify(patch.buildContract) : null,
    "currentProposal" in patch,
    patch.currentProposal ? JSON.stringify(patch.currentProposal) : null,
    "error" in patch,
    patch.error ? JSON.stringify(patch.error) : null,
    patch.title ?? null,
    patch.goal ?? null,
  ]);
  if (!row) throw new Error("Workflow builder session not found");
  return mapSession(row);
}

export async function saveWorkflowBuilderAnalyzerUsage(
  auth: AuthContext,
  sessionId: string,
  usage: LoopBuilderUsage,
): Promise<void> {
  const updated = await updateWorkflowBuilderAnalyzerUsageRow(auth, sessionId, usage);
  if (updated === 0) throw new Error("Workflow builder session not found");
}

export async function replaceWorkflowBuilderMessages(
  auth: AuthContext,
  sessionId: string,
  messages: UIMessage[],
): Promise<void> {
  const normalizedMessages = normalizeWorkflowBuilderMessages(messages);
  await replaceWorkflowBuilderMessageRows(auth, sessionId, normalizedMessages);
}

export async function listWorkflowBuilderMessages(auth: AuthContext, sessionId: string): Promise<UIMessage[]> {
  const rows = await listWorkflowBuilderMessageRows(auth, sessionId);
  return normalizeWorkflowBuilderMessages(rows);
}

export function normalizeWorkflowBuilderMessages(messages: unknown[]): UIMessage[] {
  const normalized = messages.filter((message): message is UIMessage =>
    Boolean(
      message
      && typeof message === "object"
      && "parts" in message
      && Array.isArray(message.parts)
      && message.parts.length > 0,
    )
  );

  const seen = new Set<string>();
  return normalized.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function stripOpenAiStoredItemIds(part: UIMessage["parts"][number]): UIMessage["parts"][number] {
  const cloned = { ...part } as Record<string, unknown>;
  for (const key of ["providerOptions", "providerMetadata"] as const) {
    const wrapper = cloned[key];
    if (!wrapper || typeof wrapper !== "object") continue;
    const record = { ...(wrapper as Record<string, unknown>) };
    const openai = record.openai;
    if (!openai || typeof openai !== "object") continue;
    const { itemId, ...rest } = openai as Record<string, unknown>;
    if (itemId == null) continue;
    if (Object.keys(rest).length > 0) record.openai = rest;
    else delete record.openai;
    cloned[key] = record;
  }
  return cloned as UIMessage["parts"][number];
}

function slimArtifactTemplateRecord(template: unknown): unknown {
  if (!template || typeof template !== "object") return template;
  const { html: _html, text: _text, editorContent: _editorContent, ...rest } = template as Record<string, unknown>;
  return rest;
}

function slimArtifactSetupOutputForChat(output: Record<string, unknown>): Record<string, unknown> {
  const templates = Array.isArray(output.templates)
    ? output.templates.map(slimArtifactTemplateRecord)
    : output.templates;
  let value = output.value;
  let artifactPersisted = output.artifactPersisted === true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const valueRecord = value as Record<string, unknown>;
    if (typeof valueRecord.template === "string") {
      artifactPersisted = true;
      value = { mode: valueRecord.mode ?? "supplied_template" };
    }
  }
  return {
    ...output,
    templates,
    value,
    ...(artifactPersisted ? { artifactPersisted: true } : {}),
  };
}

function slimArtifactToolParts(part: UIMessage["parts"][number]): UIMessage["parts"][number] {
  if (!isToolUIPart(part) || getToolName(part) !== "artifactSetup") return part;
  if (part.state !== "output-available" || !part.output || typeof part.output !== "object") return part;
  return {
    ...part,
    output: slimArtifactSetupOutputForChat(part.output as Record<string, unknown>),
  };
}

/** Remove OpenAI Responses item ids before replaying history to a fresh request. */
export function sanitizeLoopBuilderChatMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts
      .map(stripOpenAiStoredItemIds)
      .map(slimArtifactToolParts)
      .filter((part) => part.type !== "reasoning" || part.text.trim().length > 0),
  }));
}
