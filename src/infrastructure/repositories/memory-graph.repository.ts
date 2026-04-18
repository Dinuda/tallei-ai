import { pool } from "../db/index.js";
import type { AuthContext } from "../../domain/auth/index.js";

export type ConfidenceLabel = "explicit" | "inferred" | "uncertain";

export interface MemoryEntityRow {
  id: string;
  tenant_id: string;
  user_id: string;
  canonical_label: string;
  entity_type: string;
  normalized_label: string;
  first_seen_at: string;
  last_seen_at: string;
  source_confidence: number;
  created_at: string;
}

export interface MemoryEntityMentionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  memory_id: string;
  entity_id: string;
  mention_text: string;
  start_offset: number;
  end_offset: number;
  confidence: number;
  extraction_source: string;
  created_at: string;
}

export interface MemoryRelationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  confidence_label: ConfidenceLabel;
  confidence_score: number;
  evidence_memory_id: string | null;
  created_at: string;
  last_seen_at: string;
  active: boolean;
}

export interface GraphMemoryMetaRow {
  id: string;
  platform: string;
  created_at: string;
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class MemoryGraphRepository {
  normalizeLabel(value: string): string {
    return normalizeLabel(value);
  }

  async upsertEntity(input: {
    auth: AuthContext;
    canonicalLabel: string;
    entityType: string;
    sourceConfidence: number;
  }): Promise<MemoryEntityRow> {
    const normalized = normalizeLabel(input.canonicalLabel);
    const result = await pool.query<MemoryEntityRow>(
      `INSERT INTO memory_entities
        (tenant_id, user_id, canonical_label, entity_type, normalized_label, source_confidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, user_id, normalized_label)
       DO UPDATE SET
         canonical_label = EXCLUDED.canonical_label,
         entity_type = EXCLUDED.entity_type,
         source_confidence = GREATEST(memory_entities.source_confidence, EXCLUDED.source_confidence),
         last_seen_at = NOW()
       RETURNING *`,
      [
        input.auth.tenantId,
        input.auth.userId,
        input.canonicalLabel,
        input.entityType,
        normalized,
        input.sourceConfidence,
      ]
    );
    return result.rows[0];
  }

  async upsertMention(input: {
    auth: AuthContext;
    memoryId: string;
    entityId: string;
    mentionText: string;
    startOffset: number;
    endOffset: number;
    confidence: number;
    extractionSource: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO memory_entity_mentions
        (tenant_id, user_id, memory_id, entity_id, mention_text, start_offset, end_offset, confidence, extraction_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, user_id, memory_id, entity_id, mention_text)
       DO UPDATE SET
         confidence = GREATEST(memory_entity_mentions.confidence, EXCLUDED.confidence),
         extraction_source = EXCLUDED.extraction_source`,
      [
        input.auth.tenantId,
        input.auth.userId,
        input.memoryId,
        input.entityId,
        input.mentionText,
        input.startOffset,
        input.endOffset,
        input.confidence,
        input.extractionSource,
      ]
    );
  }

  async upsertRelation(input: {
    auth: AuthContext;
    sourceEntityId: string;
    targetEntityId: string;
    relationType: string;
    confidenceLabel: ConfidenceLabel;
    confidenceScore: number;
    evidenceMemoryId?: string | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO memory_relations
        (tenant_id, user_id, source_entity_id, target_entity_id, relation_type, confidence_label, confidence_score, evidence_memory_id, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (tenant_id, user_id, source_entity_id, target_entity_id, relation_type)
       DO UPDATE SET
         confidence_label = EXCLUDED.confidence_label,
         confidence_score = GREATEST(memory_relations.confidence_score, EXCLUDED.confidence_score),
         evidence_memory_id = COALESCE(EXCLUDED.evidence_memory_id, memory_relations.evidence_memory_id),
         active = true,
         last_seen_at = NOW()`,
      [
        input.auth.tenantId,
        input.auth.userId,
        input.sourceEntityId,
        input.targetEntityId,
        input.relationType,
        input.confidenceLabel,
        input.confidenceScore,
        input.evidenceMemoryId ?? null,
      ]
    );
  }

  async searchEntitiesByTokens(auth: AuthContext, tokens: string[], limit = 24): Promise<MemoryEntityRow[]> {
    const normalized = [...new Set(tokens.map((t) => normalizeLabel(t)).filter(Boolean))];
    if (normalized.length === 0) return [];

    const patterns = normalized.map((t) => `%${t}%`);
    const result = await pool.query<MemoryEntityRow>(
      `SELECT *
       FROM memory_entities
       WHERE tenant_id = $1
         AND user_id = $2
         AND (
           normalized_label = ANY($3::text[])
           OR normalized_label ILIKE ANY($4::text[])
         )
       ORDER BY source_confidence DESC, last_seen_at DESC
       LIMIT $5`,
      [auth.tenantId, auth.userId, normalized, patterns, limit]
    );
    return result.rows;
  }

  async listEntitiesByIds(auth: AuthContext, entityIds: string[]): Promise<MemoryEntityRow[]> {
    if (entityIds.length === 0) return [];
    const result = await pool.query<MemoryEntityRow>(
      `SELECT *
       FROM memory_entities
       WHERE tenant_id = $1
         AND user_id = $2
         AND id = ANY($3::uuid[])`,
      [auth.tenantId, auth.userId, entityIds]
    );
    return result.rows;
  }

  async listRelationsForEntityIds(auth: AuthContext, entityIds: string[], limit = 600): Promise<MemoryRelationRow[]> {
    if (entityIds.length === 0) return [];
    const result = await pool.query<MemoryRelationRow>(
      `SELECT *
       FROM memory_relations
       WHERE tenant_id = $1
         AND user_id = $2
         AND active = true
         AND (source_entity_id = ANY($3::uuid[]) OR target_entity_id = ANY($3::uuid[]))
       ORDER BY confidence_score DESC, last_seen_at DESC
       LIMIT $4`,
      [auth.tenantId, auth.userId, entityIds, limit]
    );
    return result.rows;
  }

  async listMentionsForEntityIds(
    auth: AuthContext,
    entityIds: string[],
    limit = 800
  ): Promise<MemoryEntityMentionRow[]> {
    if (entityIds.length === 0) return [];
    const result = await pool.query<MemoryEntityMentionRow>(
      `SELECT *
       FROM memory_entity_mentions
       WHERE tenant_id = $1
         AND user_id = $2
         AND entity_id = ANY($3::uuid[])
       ORDER BY confidence DESC, created_at DESC
       LIMIT $4`,
      [auth.tenantId, auth.userId, entityIds, limit]
    );
    return result.rows;
  }

  async listLatestMemoryMeta(auth: AuthContext, limit = 80): Promise<GraphMemoryMetaRow[]> {
    const result = await pool.query<GraphMemoryMetaRow>(
      `SELECT id, platform, created_at
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

  async listMentionsForMemoryIds(auth: AuthContext, memoryIds: string[]): Promise<MemoryEntityMentionRow[]> {
    if (memoryIds.length === 0) return [];
    const result = await pool.query<MemoryEntityMentionRow>(
      `SELECT *
       FROM memory_entity_mentions
       WHERE tenant_id = $1
         AND user_id = $2
         AND memory_id = ANY($3::uuid[])
       ORDER BY created_at DESC`,
      [auth.tenantId, auth.userId, memoryIds]
    );
    return result.rows;
  }

  async listEntities(auth: AuthContext, limit = 40, q?: string): Promise<MemoryEntityRow[]> {
    const search = q ? `%${normalizeLabel(q)}%` : null;
    const result = await pool.query<MemoryEntityRow>(
      `SELECT *
       FROM memory_entities
       WHERE tenant_id = $1
         AND user_id = $2
         AND ($3::text IS NULL OR normalized_label ILIKE $3)
       ORDER BY last_seen_at DESC, source_confidence DESC
       LIMIT $4`,
      [auth.tenantId, auth.userId, search, limit]
    );
    return result.rows;
  }

  async listTopEntities(auth: AuthContext, limit = 8): Promise<Array<{ entity_id: string; mentions: number }>> {
    const result = await pool.query<{ entity_id: string; mentions: string }>(
      `SELECT entity_id, COUNT(*)::text AS mentions
       FROM memory_entity_mentions
       WHERE tenant_id = $1
         AND user_id = $2
       GROUP BY entity_id
       ORDER BY COUNT(*) DESC
       LIMIT $3`,
      [auth.tenantId, auth.userId, limit]
    );

    return result.rows.map((row) => ({ entity_id: row.entity_id, mentions: Number(row.mentions) }));
  }

  async listStrongestRelations(
    auth: AuthContext,
    limit = 10
  ): Promise<Array<{ source_entity_id: string; target_entity_id: string; relation_type: string; confidence_score: number; confidence_label: ConfidenceLabel }>> {
    const result = await pool.query<{
      source_entity_id: string;
      target_entity_id: string;
      relation_type: string;
      confidence_score: number;
      confidence_label: ConfidenceLabel;
    }>(
      `SELECT source_entity_id, target_entity_id, relation_type, confidence_score, confidence_label
       FROM memory_relations
       WHERE tenant_id = $1
         AND user_id = $2
         AND active = true
       ORDER BY confidence_score DESC, last_seen_at DESC
       LIMIT $3`,
      [auth.tenantId, auth.userId, limit]
    );
    return result.rows;
  }

  async countUncertainRelations(auth: AuthContext): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM memory_relations
       WHERE tenant_id = $1
         AND user_id = $2
         AND active = true
         AND confidence_label = 'uncertain'`,
      [auth.tenantId, auth.userId]
    );
    return Number(result.rows[0]?.count ?? "0");
  }
}
