import { pool } from "../db/index.js";
import type { AuthContext } from "../../domain/auth/index.js";

export interface MemoryRecordRow {
  id: string;
  tenant_id: string;
  user_id: string;
  content_ciphertext: string;
  content_hash: string;
  platform: string;
  summary_json: unknown;
  qdrant_point_id: string;
  memory_type: string;
  category: string | null;
  is_pinned: boolean;
  reference_count: number;
  last_referenced_at: string | null;
  superseded_by: string | null;
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
  memoryType?: string;
  category?: string | null;
  isPinned?: boolean;
  referenceCount?: number;
  lastReferencedAt?: string | null;
}

interface UpdateMemoryRecordContentInput {
  contentCiphertext: string;
  contentHash: string;
  summaryJson: unknown;
}

interface ListMemoryOptions {
  types?: string[];
  pinnedOnly?: boolean;
  includeSuperseded?: boolean;
}

function normalizeTypes(types?: string[]): string[] {
  if (!types || types.length === 0) return [];
  return [...new Set(types.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export class MemoryRepository {
  async create(auth: AuthContext, input: CreateMemoryRecordInput): Promise<void> {
    await pool.query(
      `INSERT INTO memory_records
       (id, tenant_id, user_id, content_ciphertext, content_hash, platform, summary_json, qdrant_point_id, memory_type, category, is_pinned, reference_count, last_referenced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)`,
      [
        input.id,
        auth.tenantId,
        auth.userId,
        input.contentCiphertext,
        input.contentHash,
        input.platform,
        JSON.stringify(input.summaryJson ?? {}),
        input.qdrantPointId,
        input.memoryType ?? "fact",
        input.category ?? null,
        input.isPinned ?? false,
        input.referenceCount ?? 1,
        input.lastReferencedAt ?? null,
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

  async findActiveByContentHash(auth: AuthContext, contentHash: string): Promise<MemoryRecordRow | null> {
    const result = await pool.query<MemoryRecordRow>(
      `SELECT *
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND superseded_by IS NULL
         AND content_hash = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [auth.tenantId, auth.userId, contentHash]
    );
    return result.rows[0] ?? null;
  }

  async incrementReferenceScoped(
    auth: AuthContext,
    memoryId: string,
    delta = 1,
    referencedAtIso = new Date().toISOString()
  ): Promise<boolean> {
    const result = await pool.query(
      `UPDATE memory_records
       SET reference_count = reference_count + GREATEST($1, 1),
           last_referenced_at = $2::timestamptz
       WHERE id = $3
         AND tenant_id = $4
         AND user_id = $5
         AND deleted_at IS NULL
         AND superseded_by IS NULL`,
      [delta, referencedAtIso, memoryId, auth.tenantId, auth.userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async touchReferencedScoped(
    auth: AuthContext,
    memoryIds: string[],
    referencedAtIso = new Date().toISOString()
  ): Promise<void> {
    if (memoryIds.length === 0) return;
    await pool.query(
      `UPDATE memory_records
       SET last_referenced_at = $1::timestamptz
       WHERE tenant_id = $2
         AND user_id = $3
         AND deleted_at IS NULL
         AND superseded_by IS NULL
         AND id = ANY($4::uuid[])`,
      [referencedAtIso, auth.tenantId, auth.userId, memoryIds]
    );
  }

  private async listWithOptions(
    auth: AuthContext,
    limit: number | null,
    options: ListMemoryOptions = {}
  ): Promise<MemoryRecordRow[]> {
    const clauses = [
      "tenant_id = $1",
      "user_id = $2",
      "deleted_at IS NULL",
    ];
    const values: unknown[] = [auth.tenantId, auth.userId];
    const types = normalizeTypes(options.types);

    if (!options.includeSuperseded) {
      clauses.push("superseded_by IS NULL");
    }
    if (types.length > 0) {
      values.push(types);
      clauses.push(`memory_type = ANY($${values.length}::text[])`);
    }
    if (options.pinnedOnly) {
      clauses.push("is_pinned = TRUE");
    }

    let sql = `SELECT *
       FROM memory_records
       WHERE ${clauses.join("\n         AND ")}
       ORDER BY is_pinned DESC, last_referenced_at DESC NULLS LAST, created_at DESC`;

    if (typeof limit === "number") {
      values.push(limit);
      sql += `\n       LIMIT $${values.length}`;
    }

    const result = await pool.query<MemoryRecordRow>(sql, values);
    return result.rows;
  }

  async list(auth: AuthContext, limit = 100, options: ListMemoryOptions = {}): Promise<MemoryRecordRow[]> {
    return this.listWithOptions(auth, limit, options);
  }

  /**
   * Returns ALL active memories for a user with no row cap.
   */
  async listAll(auth: AuthContext, options: ListMemoryOptions = {}): Promise<MemoryRecordRow[]> {
    return this.listWithOptions(auth, null, options);
  }

  async listPinnedPreferences(auth: AuthContext): Promise<MemoryRecordRow[]> {
    return this.listWithOptions(auth, null, {
      types: ["preference"],
      pinnedOnly: true,
      includeSuperseded: false,
    });
  }

  async listPreferences(auth: AuthContext, limit = 200): Promise<MemoryRecordRow[]> {
    return this.listWithOptions(auth, limit, {
      types: ["preference"],
      includeSuperseded: false,
    });
  }

  async markSupersededPreferences(auth: AuthContext, input: {
    supersededById: string;
    preferenceKey?: string | null;
    category?: string | null;
    excludeContentHash?: string;
  }): Promise<string[]> {
    const result = await pool.query<{ id: string }>(
      `UPDATE memory_records
       SET superseded_by = $1
       WHERE tenant_id = $2
         AND user_id = $3
         AND deleted_at IS NULL
         AND superseded_by IS NULL
         AND memory_type = 'preference'
         AND id <> $1
         AND ($6::text IS NULL OR content_hash <> $6)
         AND (
           ($4::text IS NOT NULL AND summary_json->>'preference_key' = $4)
           OR ($5::text IS NOT NULL AND category = $5)
         )
       RETURNING id`,
      [
        input.supersededById,
        auth.tenantId,
        auth.userId,
        input.preferenceKey ?? null,
        input.category ?? null,
        input.excludeContentHash ?? null,
      ]
    );
    return result.rows.map((row) => row.id);
  }

  async getByIds(auth: AuthContext, ids: string[], includeSuperseded = false): Promise<MemoryRecordRow[]> {
    if (ids.length === 0) return [];

    const result = await pool.query<MemoryRecordRow>(
      `SELECT *
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         ${includeSuperseded ? "" : "AND superseded_by IS NULL"}
         AND id = ANY($3::uuid[])`,
      [auth.tenantId, auth.userId, ids]
    );

    return result.rows;
  }

  async getByIdScoped(auth: AuthContext, id: string, includeSuperseded = true): Promise<MemoryRecordRow | null> {
    const result = await pool.query<MemoryRecordRow>(
      `SELECT *
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         ${includeSuperseded ? "" : "AND superseded_by IS NULL"}
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
