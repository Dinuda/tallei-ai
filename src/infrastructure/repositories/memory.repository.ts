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
  tier: string;
  segment: string | null;
  importance: string | number;
  decay_rate: string | number;
  access_count: number;
  lifecycle: string;
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
  tier?: string;
  segment?: string | null;
  importance?: number;
  decayRate?: number;
  accessCount?: number;
  lifecycle?: string;
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
  offset?: number;
}

function normalizeTypes(types?: string[]): string[] {
  if (!types || types.length === 0) return [];
  return [...new Set(types.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export class MemoryRepository {
  private buildListScope(auth: AuthContext, options: ListMemoryOptions = {}): {
    clauses: string[];
    values: unknown[];
  } {
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

    return { clauses, values };
  }

  async create(auth: AuthContext, input: CreateMemoryRecordInput): Promise<void> {
    await pool.query(
      `INSERT INTO memory_records
       (id, tenant_id, user_id, content_ciphertext, content_hash, platform, summary_json, qdrant_point_id, memory_type, category, is_pinned, reference_count, tier, segment, importance, decay_rate, access_count, lifecycle, last_referenced_at)
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4::text,
         $5::text,
         $6::text,
         $7::jsonb,
         $8::text,
         $9::text,
         $10::text,
         $11::boolean,
         $12::integer,
         COALESCE(
           $13::text,
           CASE
             WHEN $11::boolean = TRUE OR $9::text = 'preference' THEN 'permanent'
             WHEN $9::text IN ('event', 'note') THEN 'short_term'
             ELSE 'long_term'
           END
         ),
         COALESCE($14::text, $10::text, $9::text),
         COALESCE(
           $15::numeric,
           CASE
             WHEN $11::boolean = TRUE OR $9::text = 'preference' THEN 0.9500
             WHEN $9::text IN ('decision', 'checkpoint') THEN 0.7500
             WHEN $9::text IN ('event', 'note') THEN 0.3500
             ELSE 0.6000
           END
         ),
         COALESCE(
           $16::numeric,
           CASE
             WHEN $11::boolean = TRUE OR $9::text = 'preference' THEN 0.000000
             WHEN $9::text IN ('event', 'note') THEN 0.080000
             ELSE 0.010000
           END
         ),
         COALESCE($17::integer, $12::integer),
         COALESCE(
           $18::text,
           CASE
             WHEN $11::boolean = TRUE OR $9::text = 'preference' THEN 'protected'
             ELSE 'active'
           END
         ),
         $19::timestamptz
       )`,
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
        input.tier ?? null,
        input.segment ?? null,
        input.importance ?? null,
        input.decayRate ?? null,
        input.accessCount ?? input.referenceCount ?? 1,
        input.lifecycle ?? null,
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
           access_count = access_count + GREATEST($1, 1),
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
    const { clauses, values } = this.buildListScope(auth, options);

    let sql = `SELECT *
       FROM memory_records
       WHERE ${clauses.join("\n         AND ")}
       ORDER BY is_pinned DESC,
                GREATEST(COALESCE(last_referenced_at, created_at), created_at) DESC,
                created_at DESC`;

    if (typeof limit === "number") {
      values.push(limit);
      sql += `\n       LIMIT $${values.length}`;
    }

    if (typeof options.offset === "number" && options.offset > 0) {
      values.push(options.offset);
      sql += `\n       OFFSET $${values.length}`;
    }

    const result = await pool.query<MemoryRecordRow>(sql, values);
    return result.rows;
  }

  async list(auth: AuthContext, limit = 100, options: ListMemoryOptions = {}): Promise<MemoryRecordRow[]> {
    return this.listWithOptions(auth, limit, options);
  }

  async count(auth: AuthContext, options: ListMemoryOptions = {}): Promise<number> {
    const { clauses, values } = this.buildListScope(auth, options);
    const result = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM memory_records
       WHERE ${clauses.join("\n         AND ")}`,
      values
    );
    return result.rows[0]?.total ?? 0;
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

  /** Durable profile memories: preferences, permanent tier, pinned, cleanup_bucket permanent. */
  async listWorkflowProfileMemories(auth: AuthContext, limit = 32): Promise<MemoryRecordRow[]> {
    const result = await pool.query<MemoryRecordRow>(
      `SELECT *
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND superseded_by IS NULL
         AND (
           tier = 'permanent'
           OR is_pinned = TRUE
           OR memory_type = 'preference'
           OR summary_json->>'cleanup_bucket' = 'permanent'
         )
       ORDER BY
         CASE WHEN memory_type = 'preference' THEN 0 WHEN is_pinned THEN 1 ELSE 2 END,
         reference_count DESC,
         importance DESC,
         created_at DESC
       LIMIT $3`,
      [auth.tenantId, auth.userId, limit],
    );
    return result.rows;
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
