import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { readLoopDefinition } from "./plan.js";
import {
  LOOP_DEFINITION_VERSION,
  loopExecutorRunMetaSchema,
  type LoopDefinition,
  type LoopExecutorRunMeta,
} from "./types.js";

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type LoopRunContext = {
  runId: string;
  tenantId: string;
  userId: string;
  workflowId: string;
  workflowTitle: string;
  runStatus: string;
  draftOutput: string | null;
  metadataJson: unknown;
  definition: LoopDefinition;
};

export function authFromContext(context: Pick<LoopRunContext, "tenantId" | "userId">): AuthContext {
  return {
    tenantId: context.tenantId,
    userId: context.userId,
    authMode: "internal",
    plan: "pro",
  };
}

export function readLoopExecutorMeta(metadataJson: unknown): LoopExecutorRunMeta {
  const root = readObject(metadataJson);
  const loopExecutor = readObject(root.loop_executor);
  return loopExecutorRunMetaSchema.parse({
    proposedRoster: loopExecutor.proposedRoster,
    approvedRoster: loopExecutor.approvedRoster,
    strategyReadyAt: loopExecutor.strategyReadyAt,
    rosterApprovedAt: loopExecutor.rosterApprovedAt,
    approvalRequest: loopExecutor.approvalRequest,
    approvalDecision: loopExecutor.approvalDecision,
    pendingInput: loopExecutor.pendingInput,
    artifactBody: loopExecutor.artifactBody,
    publicistApproval: loopExecutor.publicistApproval,
    emailApprovedAt: loopExecutor.emailApprovedAt,
    uiApprovedAt: loopExecutor.uiApprovedAt,
    approvalChannel: loopExecutor.approvalChannel,
    newsletterBody: loopExecutor.newsletterBody,
    contactList: loopExecutor.contactList,
    distribution: loopExecutor.distribution,
    deliveryAction: loopExecutor.deliveryAction,
  });
}

export function mergeLoopExecutorMeta(metadataJson: unknown, patch: Record<string, unknown>) {
  const root = readObject(metadataJson);
  const loopExecutor = readObject(root.loop_executor);
  return {
    ...root,
    loop_executor: {
      ...loopExecutor,
      ...patch,
    },
  };
}

export async function loadWorkflow(auth: AuthContext, workflowId: string) {
  const result = await pool.query<{ id: string; title: string; status: string; metadata_json: unknown }>(
    `SELECT id, title, status, metadata_json
     FROM workflows
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND definition_version = $4
     LIMIT 1`,
    [workflowId, auth.tenantId, auth.userId, LOOP_DEFINITION_VERSION]
  );
  const workflow = result.rows[0];
  if (!workflow) throw new Error("Loop workflow not found");
  if (workflow.status !== "active") throw new Error(`Loop workflow is ${workflow.status}`);
  return workflow;
}

export async function loadRunContext(runId: string): Promise<LoopRunContext> {
  const result = await pool.query<{
    id: string;
    tenant_id: string;
    user_id: string;
    workflow_id: string;
    status: string;
    draft_output: string | null;
    metadata_json: unknown;
    workflow_title: string;
    workflow_metadata_json: unknown;
  }>(
    `SELECT r.id,
            r.tenant_id,
            r.user_id,
            r.workflow_id,
            r.status,
            r.draft_output,
            r.metadata_json,
            w.title AS workflow_title,
            w.metadata_json AS workflow_metadata_json
     FROM workflow_runs r
     JOIN workflows w ON w.id = r.workflow_id
     WHERE r.id = $1
       AND w.definition_version = $2
     LIMIT 1`,
    [runId, LOOP_DEFINITION_VERSION]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Loop run not found");
  return {
    runId: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    workflowTitle: row.workflow_title,
    runStatus: row.status,
    draftOutput: row.draft_output,
    metadataJson: row.metadata_json,
    definition: readLoopDefinition(row.workflow_metadata_json),
  };
}

export async function assertRunAccess(auth: AuthContext, runId: string): Promise<void> {
  const result = await pool.query(
    `SELECT id
     FROM workflow_runs
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     LIMIT 1`,
    [runId, auth.tenantId, auth.userId]
  );
  if (!result.rows[0]) throw new Error("Loop run not found");
}
