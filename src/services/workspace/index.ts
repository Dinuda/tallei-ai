import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { requireLoopAdmin } from "./access.js";
import type { WorkspaceKind, WorkspaceView } from "./types.js";

function slugifyName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "workspace";
}

function mapWorkspace(row: {
  id: string;
  name: string;
  description: string | null;
  slug: string | null;
  kind: string;
  is_default: boolean;
  icon: string | null;
  color: string | null;
  settings_json: unknown;
  created_at: string;
  updated_at: string;
}): WorkspaceView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    slug: row.slug ?? "workspace",
    kind: row.kind === "personal" ? "personal" : "custom",
    isDefault: row.is_default,
    icon: row.icon,
    color: row.color,
    settings: row.settings_json && typeof row.settings_json === "object" && !Array.isArray(row.settings_json)
      ? row.settings_json as Record<string, unknown>
      : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertWorkspaceAccess(auth: AuthContext, workspaceId: string): Promise<WorkspaceView> {
  const result = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    slug: string | null;
    kind: string;
    is_default: boolean;
    icon: string | null;
    color: string | null;
    settings_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT w.id, w.name, w.description, w.slug, w.kind, w.is_default, w.icon, w.color, w.settings_json, w.created_at, w.updated_at
     FROM loop_workspaces w
     INNER JOIN workspace_memberships m
       ON m.workspace_id = w.id
      AND m.user_id = $3
     WHERE w.id = $1
       AND w.tenant_id = $2
     LIMIT 1`,
    [workspaceId, auth.tenantId, auth.userId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Workspace not found");
  return mapWorkspace(row);
}

export async function getDefaultWorkspaceId(auth: AuthContext): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT w.id
     FROM loop_workspaces w
     INNER JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $2
     WHERE w.tenant_id = $1
       AND w.is_default = TRUE
     LIMIT 1`,
    [auth.tenantId, auth.userId]
  );
  if (result.rows[0]?.id) return result.rows[0].id;

  const fallback = await pool.query<{ id: string }>(
    `SELECT w.id
     FROM loop_workspaces w
     INNER JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $2
     WHERE w.tenant_id = $1
     ORDER BY w.created_at ASC
     LIMIT 1`,
    [auth.tenantId, auth.userId]
  );
  if (!fallback.rows[0]?.id) {
    return ensureDefaultWorkspace(auth);
  }
  return fallback.rows[0].id;
}

export async function resolveWorkspaceId(auth: AuthContext, workspaceId?: string | null): Promise<string> {
  if (workspaceId) {
    await assertWorkspaceAccess(auth, workspaceId);
    return workspaceId;
  }
  const pref = await pool.query<{ last_active_workspace_id: string | null }>(
    `SELECT last_active_workspace_id
     FROM user_workspace_preferences
     WHERE user_id = $1
     LIMIT 1`,
    [auth.userId]
  );
  if (pref.rows[0]?.last_active_workspace_id) {
    try {
      await assertWorkspaceAccess(auth, pref.rows[0].last_active_workspace_id);
      return pref.rows[0].last_active_workspace_id;
    } catch {
      // fall through to default
    }
  }
  return getDefaultWorkspaceId(auth);
}

export async function listWorkspaces(auth: AuthContext): Promise<WorkspaceView[]> {
  await requireLoopAdmin(auth);
  const result = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    slug: string | null;
    kind: string;
    is_default: boolean;
    icon: string | null;
    color: string | null;
    settings_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT w.id, w.name, w.description, w.slug, w.kind, w.is_default, w.icon, w.color, w.settings_json, w.created_at, w.updated_at
     FROM loop_workspaces w
     INNER JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $2
     WHERE w.tenant_id = $1
     ORDER BY w.is_default DESC, w.created_at ASC`,
    [auth.tenantId, auth.userId]
  );
  return result.rows.map(mapWorkspace);
}

export async function getWorkspace(auth: AuthContext, workspaceId: string): Promise<WorkspaceView> {
  await requireLoopAdmin(auth);
  return assertWorkspaceAccess(auth, workspaceId);
}

export async function createWorkspace(auth: AuthContext, input: {
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
}): Promise<WorkspaceView> {
  await requireLoopAdmin(auth);
  const workspaceId = randomUUID();
  let slug = slugifyName(input.name);
  const slugConflict = await pool.query<{ id: string }>(
    `SELECT id FROM loop_workspaces WHERE user_id = $1 AND slug = $2 LIMIT 1`,
    [auth.userId, slug]
  );
  if (slugConflict.rows[0]) slug = `${slug}-${workspaceId.slice(0, 8)}`;

  const result = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    slug: string | null;
    kind: string;
    is_default: boolean;
    icon: string | null;
    color: string | null;
    settings_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO loop_workspaces
       (id, tenant_id, user_id, name, description, slug, kind, is_default, icon, color, settings_json)
     VALUES ($1, $2, $3, $4, $5, $6, 'custom', FALSE, $7, $8, '{}'::jsonb)
     RETURNING id, name, description, slug, kind, is_default, icon, color, settings_json, created_at, updated_at`,
    [
      workspaceId,
      auth.tenantId,
      auth.userId,
      input.name.trim(),
      input.description?.trim() || null,
      slug,
      input.icon?.trim() || null,
      input.color?.trim() || "#6366f1",
    ]
  );

  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, tenant_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [workspaceId, auth.tenantId, auth.userId]
  );

  return mapWorkspace(result.rows[0]);
}

export async function updateWorkspace(auth: AuthContext, workspaceId: string, input: {
  name?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  settings?: Record<string, unknown>;
}): Promise<WorkspaceView> {
  await requireLoopAdmin(auth);
  const existing = await assertWorkspaceAccess(auth, workspaceId);
  if (existing.kind === "personal" && input.name && input.name.trim() !== existing.name) {
    throw new Error("The Personal workspace name cannot be changed");
  }

  const result = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    slug: string | null;
    kind: string;
    is_default: boolean;
    icon: string | null;
    color: string | null;
    settings_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `UPDATE loop_workspaces
     SET name = COALESCE($4, name),
         description = COALESCE($5, description),
         icon = COALESCE($6, icon),
         color = COALESCE($7, color),
         settings_json = COALESCE($8::jsonb, settings_json),
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     RETURNING id, name, description, slug, kind, is_default, icon, color, settings_json, created_at, updated_at`,
    [
      workspaceId,
      auth.tenantId,
      auth.userId,
      input.name?.trim() ?? null,
      input.description !== undefined ? (input.description?.trim() || null) : null,
      input.icon !== undefined ? (input.icon?.trim() || null) : null,
      input.color !== undefined ? (input.color?.trim() || null) : null,
      input.settings ? JSON.stringify(input.settings) : null,
    ]
  );
  return mapWorkspace(result.rows[0]);
}

export async function activateWorkspace(auth: AuthContext, workspaceId: string): Promise<{ workspaceId: string }> {
  await requireLoopAdmin(auth);
  await assertWorkspaceAccess(auth, workspaceId);
  await pool.query(
    `INSERT INTO user_workspace_preferences (user_id, tenant_id, last_active_workspace_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET last_active_workspace_id = EXCLUDED.last_active_workspace_id,
           updated_at = NOW()`,
    [auth.userId, auth.tenantId, workspaceId]
  );
  return { workspaceId };
}

export async function deleteWorkspace(auth: AuthContext, workspaceId: string): Promise<void> {
  await requireLoopAdmin(auth);
  const workspace = await assertWorkspaceAccess(auth, workspaceId);
  if (workspace.kind === "personal") throw new Error("The Personal workspace cannot be deleted");
  await pool.query(
    `DELETE FROM loop_workspaces
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [workspaceId, auth.tenantId, auth.userId]
  );
}

export async function assignLoopToWorkspace(auth: AuthContext, input: {
  loopId: string;
  workspaceId: string | null;
}): Promise<{ loopId: string; workspaceId: string | null }> {
  await requireLoopAdmin(auth);
  const targetWorkspaceId = input.workspaceId ?? await resolveWorkspaceId(auth);
  if (input.workspaceId) await assertWorkspaceAccess(auth, input.workspaceId);

  const result = await pool.query<{ id: string }>(
    `UPDATE loops
     SET workspace_id = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3
     RETURNING id`,
    [input.loopId, auth.tenantId, auth.userId, targetWorkspaceId]
  );
  if (!result.rows[0]) throw new Error("Loop not found");
  return { loopId: input.loopId, workspaceId: targetWorkspaceId };
}

export async function ensureDefaultWorkspace(auth: AuthContext): Promise<string> {
  try {
    return await getDefaultWorkspaceId(auth);
  } catch {
    const workspaceId = randomUUID();
    await pool.query(
      `INSERT INTO loop_workspaces
         (id, tenant_id, user_id, name, slug, kind, is_default, color)
       VALUES ($1, $2, $3, 'Personal', 'personal', 'personal', TRUE, '#7eb71b')`,
      [workspaceId, auth.tenantId, auth.userId]
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [workspaceId, auth.tenantId, auth.userId]
    );
    return workspaceId;
  }
}

export type { WorkspaceKind, WorkspaceView };
