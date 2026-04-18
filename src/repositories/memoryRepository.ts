import { pool } from "../db/index.js";
import type { AuthContext } from "../types/auth.js";

export interface MemoryRecordRow {
  id: string;
  tenant_id: string;
  user_id: string;
  content_ciphertext: string;
  content_hash: string;
  platform: string;
  summary_json: unknown;
  qdrant_point_id: string;
  created_at: string;
  deleted_at: string | null;
}

interface CreateMemoryRecordInput {
  id: string;
  contentCiphertext: string;
  contentHash: string;
  platform: string;
  summaryJson: unknown;
  qdrantPointId: string;
}

interface UpdateMemoryRecordContentInput {
  contentCiphertext: string;
  contentHash: string;
  summaryJson: unknown;
}

export class MemoryRepository {
  async create(auth: AuthContext, input: CreateMemoryRecordInput): Promise<void> {
    await pool.query(
      `INSERT INTO memory_records
       (id, tenant_id, user_id, content_ciphertext, content_hash, platform, summary_json, qdrant_point_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        input.id,
        auth.tenantId,
        auth.userId,
        input.contentCiphertext,
        input.contentHash,
        input.platform,
        JSON.stringify(input.summaryJson ?? {}),
        input.qdrantPointId,
      ]
    );
  }

  async updateContentAndSummaryScoped(
    auth: AuthContext,
    memoryId: string,
    input: UpdateMemoryRecordContentInput
  ): Promise<boolean> {
    const result = await pool.query(
      `UPDATE memory_records
       SET content_ciphertext = $1,
           content_hash = $2,
           summary_json = $3::jsonb
       WHERE id = $4
         AND tenant_id = $5
         AND user_id = $6
         AND deleted_at IS NULL`,
      [
        input.contentCiphertext,
        input.contentHash,
        JSON.stringify(input.summaryJson ?? {}),
        memoryId,
        auth.tenantId,
        auth.userId,
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(auth: AuthContext, limit = 100): Promise<MemoryRecordRow[]> {
    const result = await pool.query<MemoryRecordRow>(
      `SELECT *
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $3`,
      [auth.tenantId, auth.userId, limit]
    );
    return result.rows;
  }

  /**
   * Returns ALL non-deleted memories for a user with no row cap.
   * Used by recall fallback paths so that old memories are not silently skipped
   * due to a recency-ordered LIMIT.
   */
  async listAll(auth: AuthContext): Promise<MemoryRecordRow[]> {
    const result = await pool.query<MemoryRecordRow>(
      `SELECT *
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [auth.tenantId, auth.userId]
    );
    return result.rows;
  }

  async getByIds(auth: AuthContext, ids: string[]): Promise<MemoryRecordRow[]> {
    if (ids.length === 0) return [];

    const result = await pool.query<MemoryRecordRow>(
      `SELECT *
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND id = ANY($3::uuid[])`,
      [auth.tenantId, auth.userId, ids]
    );

    return result.rows;
  }

  async getByIdScoped(auth: AuthContext, id: string): Promise<MemoryRecordRow | null> {
    const result = await pool.query<MemoryRecordRow>(
      `SELECT *
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND id = $3
       LIMIT 1`,
      [auth.tenantId, auth.userId, id]
    );
    return result.rows[0] ?? null;
  }

  async softDeleteScoped(auth: AuthContext, memoryId: string): Promise<MemoryRecordRow | null> {
    const result = await pool.query<MemoryRecordRow>(
      `UPDATE memory_records
       SET deleted_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3
         AND deleted_at IS NULL
       RETURNING *`,
      [memoryId, auth.tenantId, auth.userId]
    );

    return result.rows[0] ?? null;
  }

  async logEvent(input: {
    auth: AuthContext;
    action: string;
    memoryId?: string | null;
    actorType?: "user" | "system";
    ipHash?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO memory_events
       (tenant_id, user_id, memory_id, action, actor_type, auth_mode, ip_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.auth.tenantId,
        input.auth.userId,
        input.memoryId ?? null,
        input.action,
        input.actorType ?? "user",
        input.auth.authMode,
        input.ipHash ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
  }
}
