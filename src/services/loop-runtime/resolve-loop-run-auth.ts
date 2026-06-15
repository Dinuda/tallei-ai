import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { parseRunnableSpec } from "./spec-run-types.js";

export async function loadWorkflowWorkspaceId(
  tenantId: string,
  userId: string,
  workflowId: string,
): Promise<string | null> {
  const result = await pool.query<{ workspace_id: string | null; metadata_json: unknown }>(
    `SELECT workspace_id, metadata_json
     FROM workflows
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [workflowId, tenantId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.workspace_id) return row.workspace_id;
  const runnableSpec = parseRunnableSpec(row.metadata_json);
  return runnableSpec?.workspaceId ?? null;
}

export async function resolveLoopRunAuth(input: {
  tenantId: string;
  userId: string;
  workflowId: string;
  scopes?: string[];
}): Promise<AuthContext> {
  const workspaceId = await loadWorkflowWorkspaceId(input.tenantId, input.userId, input.workflowId);
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    authMode: "internal",
    plan: "pro",
    scopes: input.scopes ?? ["loop:run"],
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function withWorkflowWorkspaceAuth(auth: AuthContext, workspaceId: string | null | undefined): AuthContext {
  if (!workspaceId || auth.workspaceId) return auth;
  return { ...auth, workspaceId };
}
