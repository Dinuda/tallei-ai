import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { LOOP_DEFINITION_VERSION } from "./types.js";
import { requireLoopAdmin } from "./creator.js";

export interface LoopWorkspaceView {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapWorkspace(row: {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}): LoopWorkspaceView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createWorkspace(auth: AuthContext, input: {
  name: string;
  description?: string | null;
}): Promise<LoopWorkspaceView> {
  await requireLoopAdmin(auth);
  const result = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO loop_workspaces
     (id, tenant_id, user_id, name, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, description, created_at, updated_at`,
    [randomUUID(), auth.tenantId, auth.userId, input.name.trim(), input.description?.trim() || null]
  );
  return mapWorkspace(result.rows[0]);
}

export async function listWorkspaces(auth: AuthContext): Promise<LoopWorkspaceView[]> {
  await requireLoopAdmin(auth);
  const result = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, name, description, created_at, updated_at
     FROM loop_workspaces
     WHERE tenant_id = $1
       AND user_id = $2
     ORDER BY created_at ASC`,
    [auth.tenantId, auth.userId]
  );
  return result.rows.map(mapWorkspace);
}

export async function assignLoopToWorkspace(auth: AuthContext, input: {
  workflowId: string;
  workspaceId: string | null;
}): Promise<{ workflowId: string; workspaceId: string | null }> {
  await requireLoopAdmin(auth);
  if (input.workspaceId) {
    const workspace = await pool.query<{ id: string }>(
      `SELECT id
       FROM loop_workspaces
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3
       LIMIT 1`,
      [input.workspaceId, auth.tenantId, auth.userId]
    );
    if (!workspace.rows[0]) throw new Error("Loop workspace not found");
  }

  const result = await pool.query<{ id: string }>(
    `UPDATE workflows
     SET workspace_id = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
       AND definition_version = $5
     RETURNING id`,
    [input.workflowId, auth.tenantId, auth.userId, input.workspaceId, LOOP_DEFINITION_VERSION]
  );
  if (!result.rows[0]) throw new Error("Loop workflow not found");
  return { workflowId: input.workflowId, workspaceId: input.workspaceId };
}
