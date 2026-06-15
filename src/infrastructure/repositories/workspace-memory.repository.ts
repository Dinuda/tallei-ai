import { pool } from "../db/index.js";
import type { AuthContext } from "../../domain/auth/index.js";

export interface WorkspaceMemoryRecordRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  user_id: string;
  content_ciphertext: string;
  content_hash: string;
  source: string;
  source_ref: string | null;
  summary_json: unknown;
  qdrant_point_id: string;
  memory_type: string;
  category: string | null;
  tier: string;
  lifecycle: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export class WorkspaceMemoryRepository {
  async create(input: {
    auth: AuthContext;
    workspaceId: string;
    id: string;
    contentCiphertext: string;
    contentHash: string;
    source: string;
    sourceRef?: string | null;
    summaryJson: unknown;
    qdrantPointId: string;
    memoryType?: string;
    category?: string | null;
  }): Promise<WorkspaceMemoryRecordRow> {
    const result = await pool.query<WorkspaceMemoryRecordRow>(
      `INSERT INTO workspace_memory_records
         (id, tenant_id, workspace_id, user_id, content_ciphertext, content_hash, source, source_ref, summary_json, qdrant_point_id, memory_type, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
       RETURNING *`,
      [
        input.id,
        input.auth.tenantId,
        input.workspaceId,
        input.auth.userId,
        input.contentCiphertext,
        input.contentHash,
        input.source,
        input.sourceRef ?? null,
        JSON.stringify(input.summaryJson ?? {}),
        input.qdrantPointId,
        input.memoryType ?? "fact",
        input.category ?? null,
      ]
    );
    return result.rows[0];
  }

  async list(auth: AuthContext, workspaceId: string, limit = 50): Promise<WorkspaceMemoryRecordRow[]> {
    const result = await pool.query<WorkspaceMemoryRecordRow>(
      `SELECT *
       FROM workspace_memory_records
       WHERE tenant_id = $1
         AND workspace_id = $2
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $3`,
      [auth.tenantId, workspaceId, limit]
    );
    return result.rows;
  }

  async getByIds(auth: AuthContext, workspaceId: string, ids: string[]): Promise<WorkspaceMemoryRecordRow[]> {
    if (ids.length === 0) return [];
    const result = await pool.query<WorkspaceMemoryRecordRow>(
      `SELECT *
       FROM workspace_memory_records
       WHERE tenant_id = $1
         AND workspace_id = $2
         AND id = ANY($3::uuid[])
         AND deleted_at IS NULL`,
      [auth.tenantId, workspaceId, ids]
    );
    return result.rows;
  }

  async searchByText(auth: AuthContext, workspaceId: string, query: string, limit = 20): Promise<WorkspaceMemoryRecordRow[]> {
    const result = await pool.query<WorkspaceMemoryRecordRow>(
      `SELECT *
       FROM workspace_memory_records
       WHERE tenant_id = $1
         AND workspace_id = $2
         AND deleted_at IS NULL
         AND (
           summary_json::text ILIKE '%' || $3 || '%'
           OR source_ref ILIKE '%' || $3 || '%'
         )
       ORDER BY updated_at DESC
       LIMIT $4`,
      [auth.tenantId, workspaceId, query.trim(), limit]
    );
    return result.rows;
  }

  async delete(auth: AuthContext, workspaceId: string, id: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE workspace_memory_records
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND workspace_id = $3
         AND deleted_at IS NULL
       RETURNING id`,
      [id, auth.tenantId, workspaceId]
    );
    return Boolean(result.rowCount);
  }
}
