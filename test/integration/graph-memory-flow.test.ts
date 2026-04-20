import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.INTERNAL_API_SECRET ??= "integration-secret";
process.env.DATABASE_URL ??= "postgresql://tallei:tallei@127.0.0.1:5432/tallei";
process.env.DATABASE_URL_FALLBACK ??= process.env.DATABASE_URL;
process.env.OPENAI_API_KEY ??= "test-openai-key";
process.env.JWT_SECRET ??= "integration-jwt-secret";
process.env.GRAPH_EXTRACTION_ENABLED = "true";
process.env.RECALL_V2_ENABLED = "true";
process.env.RECALL_V2_SHADOW_MODE = "false";
process.env.DASHBOARD_GRAPH_V2_ENABLED = "true";
process.env.MEMORY_MASTER_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.REDIS_URL = "";

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  if (url.includes("/embeddings")) {
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.15, 0.22, 0.47, 0.31] }],
        model: "text-embedding-3-small",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  if (url.includes("/chat/completions")) {
    return new Response(
      JSON.stringify({
        id: "chatcmpl_test",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                title: "Memory Summary",
                keyPoints: [
                  "Project: Tallei",
                  "Tool: Postgres",
                  "Tool: Qdrant",
                  "Preference: low latency",
                ],
                decisions: ["Decided on graph memory and vector recall"],
                summary: "Session captured architecture choices and constraints.",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ error: `Unhandled fetch URL in test stub: ${url}` }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
};

const [{ randomUUID }, { MemoryRepository }, { VectorRepository }, { MemoryGraphRepository }, { MemoryGraphJobRepository }] =
  await Promise.all([
    import("node:crypto"),
    import("../../src/infrastructure/repositories/memory.repository.js"),
    import("../../src/infrastructure/repositories/vector.repository.js"),
    import("../../src/infrastructure/repositories/memory-graph.repository.js"),
    import("../../src/infrastructure/repositories/memory-graph-job.repository.js"),
  ]);

type Scope = { tenantId: string; userId: string };

interface InMemoryState {
  memories: Array<{
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
  }>;
  jobs: Array<{
    id: string;
    tenant_id: string;
    user_id: string;
    memory_id: string | null;
    job_type: "extract" | "backfill" | "snapshot_refresh";
    status: "queued" | "running" | "retry" | "failed" | "done";
    attempt_count: number;
    next_run_at: string;
    error_code: string | null;
    error_message: string | null;
    payload_json: unknown;
    created_at: string;
    updated_at: string;
  }>;
  entities: Array<{
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
  }>;
  mentions: Array<{
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
  }>;
  relations: Array<{
    id: string;
    tenant_id: string;
    user_id: string;
    source_entity_id: string;
    target_entity_id: string;
    relation_type: string;
    confidence_label: "explicit" | "inferred" | "uncertain";
    confidence_score: number;
    evidence_memory_id: string | null;
    created_at: string;
    last_seen_at: string;
    active: boolean;
  }>;
  events: Array<{
    action: string;
    tenantId: string;
    userId: string;
    metadata?: Record<string, unknown>;
  }>;
}

function scopeKey(scope: Scope): string {
  return `${scope.tenantId}:${scope.userId}`;
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createState(): InMemoryState {
  return {
    memories: [],
    jobs: [],
    entities: [],
    mentions: [],
    relations: [],
    events: [],
  };
}

const stateRef: { current: InMemoryState } = { current: createState() };

function resetState(): void {
  stateRef.current = createState();
}

MemoryRepository.prototype.create = async function create(auth, input) {
  stateRef.current.memories.push({
    id: input.id,
    tenant_id: auth.tenantId,
    user_id: auth.userId,
    content_ciphertext: input.contentCiphertext,
    content_hash: input.contentHash,
    platform: input.platform,
    summary_json: input.summaryJson,
    qdrant_point_id: input.qdrantPointId,
    memory_type: input.memoryType ?? "fact",
    category: input.category ?? null,
    is_pinned: input.isPinned ?? false,
    reference_count: input.referenceCount ?? 1,
    last_referenced_at: input.lastReferencedAt ?? null,
    superseded_by: null,
    created_at: new Date().toISOString(),
    deleted_at: null,
  });
};

MemoryRepository.prototype.list = async function list(auth, limit = 100) {
  return stateRef.current.memories
    .filter((row) => row.tenant_id === auth.tenantId && row.user_id === auth.userId && row.deleted_at === null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
};

MemoryRepository.prototype.listAll = async function listAll(auth, options = {}) {
  const includeTypes = Array.isArray(options?.types) && options.types.length > 0
    ? new Set(options.types)
    : null;
  return stateRef.current.memories
    .filter((row) => {
      if (row.tenant_id !== auth.tenantId || row.user_id !== auth.userId || row.deleted_at !== null) return false;
      if (!options?.includeSuperseded && row.superseded_by) return false;
      if (includeTypes && !includeTypes.has((row as { memory_type?: string }).memory_type ?? "fact")) return false;
      if (options?.pinnedOnly && !(row as { is_pinned?: boolean }).is_pinned) return false;
      return true;
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
};

MemoryRepository.prototype.listPinnedPreferences = async function listPinnedPreferences(auth) {
  return stateRef.current.memories
    .filter(
      (row) =>
        row.tenant_id === auth.tenantId &&
        row.user_id === auth.userId &&
        row.deleted_at === null &&
        !row.superseded_by &&
        (row as { memory_type?: string }).memory_type === "preference" &&
        Boolean((row as { is_pinned?: boolean }).is_pinned)
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
};

MemoryRepository.prototype.findActiveByContentHash = async function findActiveByContentHash(auth, contentHash) {
  return (
    stateRef.current.memories.find(
      (row) =>
        row.tenant_id === auth.tenantId &&
        row.user_id === auth.userId &&
        row.deleted_at === null &&
        !row.superseded_by &&
        row.content_hash === contentHash
    ) ?? null
  );
};

MemoryRepository.prototype.incrementReferenceScoped = async function incrementReferenceScoped(auth, memoryId, delta = 1, at) {
  const row = stateRef.current.memories.find(
    (memory) =>
      memory.id === memoryId &&
      memory.tenant_id === auth.tenantId &&
      memory.user_id === auth.userId &&
      memory.deleted_at === null &&
      !memory.superseded_by
  );
  if (!row) return false;
  (row as { reference_count?: number }).reference_count = ((row as { reference_count?: number }).reference_count ?? 1) + delta;
  (row as { last_referenced_at?: string | null }).last_referenced_at = at ?? new Date().toISOString();
  return true;
};

MemoryRepository.prototype.touchReferencedScoped = async function touchReferencedScoped(auth, memoryIds, at) {
  const touchedAt = at ?? new Date().toISOString();
  const wanted = new Set(memoryIds);
  for (const row of stateRef.current.memories) {
    if (row.tenant_id !== auth.tenantId || row.user_id !== auth.userId || row.deleted_at !== null || row.superseded_by) {
      continue;
    }
    if (wanted.has(row.id)) {
      (row as { last_referenced_at?: string | null }).last_referenced_at = touchedAt;
    }
  }
};

MemoryRepository.prototype.listPreferences = async function listPreferences(auth, limit = 200) {
  return stateRef.current.memories
    .filter(
      (row) =>
        row.tenant_id === auth.tenantId &&
        row.user_id === auth.userId &&
        row.deleted_at === null &&
        !row.superseded_by &&
        (row as { memory_type?: string }).memory_type === "preference"
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
};

MemoryRepository.prototype.markSupersededPreferences = async function markSupersededPreferences(auth, input) {
  const affected: string[] = [];
  for (const row of stateRef.current.memories) {
    if (row.tenant_id !== auth.tenantId || row.user_id !== auth.userId || row.deleted_at !== null) continue;
    if ((row as { memory_type?: string }).memory_type !== "preference") continue;
    if (row.id === input.supersededById) continue;
    if (row.superseded_by) continue;
    if (input.excludeContentHash && row.content_hash === input.excludeContentHash) continue;
    const summary = row.summary_json && typeof row.summary_json === "object"
      ? (row.summary_json as Record<string, unknown>)
      : {};
    const preferenceKey = typeof summary.preference_key === "string" ? summary.preference_key : null;
    const rowCategory = (row as { category?: string | null }).category ?? null;
    const keyMatch = input.preferenceKey && preferenceKey === input.preferenceKey;
    const categoryMatch = input.category && rowCategory === input.category;
    if (!keyMatch && !categoryMatch) continue;
    row.superseded_by = input.supersededById;
    affected.push(row.id);
  }
  return affected;
};

MemoryRepository.prototype.getByIds = async function getByIds(auth, ids) {
  const idSet = new Set(ids);
  return stateRef.current.memories.filter(
    (row) =>
      row.tenant_id === auth.tenantId &&
      row.user_id === auth.userId &&
      row.deleted_at === null &&
      !row.superseded_by &&
      idSet.has(row.id)
  );
};

MemoryRepository.prototype.getByIdScoped = async function getByIdScoped(auth, id) {
  return (
    stateRef.current.memories.find(
      (row) =>
        row.id === id && row.tenant_id === auth.tenantId && row.user_id === auth.userId && row.deleted_at === null
    ) ?? null
  );
};

MemoryRepository.prototype.softDeleteScoped = async function softDeleteScoped(auth, id) {
  const row = stateRef.current.memories.find(
    (memory) =>
      memory.id === id &&
      memory.tenant_id === auth.tenantId &&
      memory.user_id === auth.userId &&
      memory.deleted_at === null
  );
  if (!row) return null;
  row.deleted_at = new Date().toISOString();
  return row;
};

MemoryRepository.prototype.logEvent = async function logEvent(input) {
  stateRef.current.events.push({
    action: input.action,
    tenantId: input.auth.tenantId,
    userId: input.auth.userId,
    metadata: (input.metadata ?? {}) as Record<string, unknown>,
  });
};

VectorRepository.prototype.upsertMemoryVector = async function upsertMemoryVector(input) {
  return { pointId: input.pointId ?? input.memoryId };
};

VectorRepository.prototype.searchVectors = async function searchVectors(auth, _queryVector, limit) {
  const scoped = stateRef.current.memories
    .filter((row) => row.tenant_id === auth.tenantId && row.user_id === auth.userId && row.deleted_at === null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);

  return scoped.map((row, idx) => ({
    pointId: row.qdrant_point_id,
    memoryId: row.id,
    score: Number((1 - idx * 0.05).toFixed(3)),
  }));
};

VectorRepository.prototype.deleteMemoryVector = async function deleteMemoryVector() {};

MemoryGraphJobRepository.prototype.enqueueExtractJob = async function enqueueExtractJob(auth, memoryId, payload) {
  const existing = stateRef.current.jobs.find(
    (job) =>
      job.tenant_id === auth.tenantId &&
      job.user_id === auth.userId &&
      job.memory_id === memoryId &&
      job.job_type === "extract" &&
      (job.status === "queued" || job.status === "running" || job.status === "retry")
  );
  if (existing) return;

  const now = new Date().toISOString();
  stateRef.current.jobs.push({
    id: randomUUID(),
    tenant_id: auth.tenantId,
    user_id: auth.userId,
    memory_id: memoryId,
    job_type: "extract",
    status: "queued",
    attempt_count: 0,
    next_run_at: now,
    error_code: null,
    error_message: null,
    payload_json: payload ?? {},
    created_at: now,
    updated_at: now,
  });
};

MemoryGraphJobRepository.prototype.enqueueSnapshotRefreshJob = async function enqueueSnapshotRefreshJob(
  auth,
  payload = {},
  _debounceMs = 1000
) {
  const existing = stateRef.current.jobs.find(
    (job) =>
      job.tenant_id === auth.tenantId &&
      job.user_id === auth.userId &&
      job.job_type === "snapshot_refresh" &&
      (job.status === "queued" || job.status === "running" || job.status === "retry")
  );
  if (existing) {
    existing.payload_json = {
      ...(typeof existing.payload_json === "object" && existing.payload_json ? existing.payload_json : {}),
      ...(typeof payload === "object" && payload ? payload : {}),
    };
    return;
  }

  const now = new Date().toISOString();
  stateRef.current.jobs.push({
    id: randomUUID(),
    tenant_id: auth.tenantId,
    user_id: auth.userId,
    memory_id: null,
    job_type: "snapshot_refresh",
    status: "queued",
    attempt_count: 0,
    next_run_at: now,
    error_code: null,
    error_message: null,
    payload_json: payload ?? {},
    created_at: now,
    updated_at: now,
  });
};

MemoryGraphJobRepository.prototype.enqueueBackfillForAllActiveMemories = async function enqueueBackfillForAllActiveMemories(
  limit = 5000
) {
  const candidates = stateRef.current.memories
    .filter((memory) => memory.deleted_at === null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
  let inserted = 0;

  for (const memory of candidates) {
    const hasJob = stateRef.current.jobs.some(
      (job) =>
        job.tenant_id === memory.tenant_id &&
        job.user_id === memory.user_id &&
        job.memory_id === memory.id &&
        (job.job_type === "extract" || job.job_type === "backfill") &&
        (job.status === "queued" || job.status === "running" || job.status === "retry" || job.status === "done")
    );
    if (hasJob) continue;

    const now = new Date().toISOString();
    stateRef.current.jobs.push({
      id: randomUUID(),
      tenant_id: memory.tenant_id,
      user_id: memory.user_id,
      memory_id: memory.id,
      job_type: "backfill",
      status: "queued",
      attempt_count: 0,
      next_run_at: now,
      error_code: null,
      error_message: null,
      payload_json: {},
      created_at: now,
      updated_at: now,
    });
    inserted += 1;
  }

  return inserted;
};

MemoryGraphJobRepository.prototype.claimJobs = async function claimJobs(limit) {
  const now = Date.now();
  const picked = stateRef.current.jobs
    .filter(
      (job) =>
        (job.status === "queued" || job.status === "retry") && new Date(job.next_run_at).getTime() <= now
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, limit);

  for (const job of picked) {
    job.status = "running";
    job.attempt_count += 1;
    job.updated_at = new Date().toISOString();
  }
  return picked;
};

MemoryGraphJobRepository.prototype.markDone = async function markDone(jobId) {
  const row = stateRef.current.jobs.find((job) => job.id === jobId);
  if (!row) return;
  row.status = "done";
  row.error_code = null;
  row.error_message = null;
  row.updated_at = new Date().toISOString();
};

MemoryGraphJobRepository.prototype.markRetry = async function markRetry(jobId, delaySeconds, errorCode, message) {
  const row = stateRef.current.jobs.find((job) => job.id === jobId);
  if (!row) return;
  row.status = "retry";
  row.error_code = errorCode;
  row.error_message = message;
  row.next_run_at = new Date(Date.now() + delaySeconds * 1000).toISOString();
  row.updated_at = new Date().toISOString();
};

MemoryGraphJobRepository.prototype.markFailed = async function markFailed(jobId, errorCode, message) {
  const row = stateRef.current.jobs.find((job) => job.id === jobId);
  if (!row) return;
  row.status = "failed";
  row.error_code = errorCode;
  row.error_message = message;
  row.updated_at = new Date().toISOString();
};

MemoryGraphRepository.prototype.normalizeLabel = function normalize(value) {
  return normalizeLabel(value);
};

MemoryGraphRepository.prototype.upsertEntity = async function upsertEntity(input) {
  const normalized = normalizeLabel(input.canonicalLabel);
  const now = new Date().toISOString();
  const existing = stateRef.current.entities.find(
    (row) =>
      row.tenant_id === input.auth.tenantId &&
      row.user_id === input.auth.userId &&
      row.normalized_label === normalized
  );
  if (existing) {
    existing.canonical_label = input.canonicalLabel;
    existing.entity_type = input.entityType;
    existing.source_confidence = Math.max(existing.source_confidence, input.sourceConfidence);
    existing.last_seen_at = now;
    return existing;
  }

  const inserted = {
    id: randomUUID(),
    tenant_id: input.auth.tenantId,
    user_id: input.auth.userId,
    canonical_label: input.canonicalLabel,
    entity_type: input.entityType,
    normalized_label: normalized,
    first_seen_at: now,
    last_seen_at: now,
    source_confidence: input.sourceConfidence,
    created_at: now,
  };
  stateRef.current.entities.push(inserted);
  return inserted;
};

MemoryGraphRepository.prototype.upsertMention = async function upsertMention(input) {
  const existing = stateRef.current.mentions.find(
    (mention) =>
      mention.tenant_id === input.auth.tenantId &&
      mention.user_id === input.auth.userId &&
      mention.memory_id === input.memoryId &&
      mention.entity_id === input.entityId &&
      mention.mention_text === input.mentionText
  );
  if (existing) {
    existing.confidence = Math.max(existing.confidence, input.confidence);
    existing.extraction_source = input.extractionSource;
    return;
  }

  stateRef.current.mentions.push({
    id: randomUUID(),
    tenant_id: input.auth.tenantId,
    user_id: input.auth.userId,
    memory_id: input.memoryId,
    entity_id: input.entityId,
    mention_text: input.mentionText,
    start_offset: input.startOffset,
    end_offset: input.endOffset,
    confidence: input.confidence,
    extraction_source: input.extractionSource,
    created_at: new Date().toISOString(),
  });
};

MemoryGraphRepository.prototype.upsertRelation = async function upsertRelation(input) {
  const existing = stateRef.current.relations.find(
    (relation) =>
      relation.tenant_id === input.auth.tenantId &&
      relation.user_id === input.auth.userId &&
      relation.source_entity_id === input.sourceEntityId &&
      relation.target_entity_id === input.targetEntityId &&
      relation.relation_type === input.relationType
  );
  if (existing) {
    existing.confidence_label = input.confidenceLabel;
    existing.confidence_score = Math.max(existing.confidence_score, input.confidenceScore);
    existing.evidence_memory_id = input.evidenceMemoryId ?? existing.evidence_memory_id;
    existing.last_seen_at = new Date().toISOString();
    existing.active = true;
    return;
  }

  const now = new Date().toISOString();
  stateRef.current.relations.push({
    id: randomUUID(),
    tenant_id: input.auth.tenantId,
    user_id: input.auth.userId,
    source_entity_id: input.sourceEntityId,
    target_entity_id: input.targetEntityId,
    relation_type: input.relationType,
    confidence_label: input.confidenceLabel,
    confidence_score: input.confidenceScore,
    evidence_memory_id: input.evidenceMemoryId ?? null,
    created_at: now,
    last_seen_at: now,
    active: true,
  });
};

MemoryGraphRepository.prototype.searchEntitiesByTokens = async function searchEntitiesByTokens(auth, tokens, limit = 24) {
  const normalizedTokens = [...new Set(tokens.map((token) => normalizeLabel(token)).filter(Boolean))];
  if (normalizedTokens.length === 0) return [];

  return stateRef.current.entities
    .filter(
      (entity) =>
        entity.tenant_id === auth.tenantId &&
        entity.user_id === auth.userId &&
        normalizedTokens.some(
          (token) => entity.normalized_label === token || entity.normalized_label.includes(token)
        )
    )
    .sort((a, b) => b.source_confidence - a.source_confidence || b.last_seen_at.localeCompare(a.last_seen_at))
    .slice(0, limit);
};

MemoryGraphRepository.prototype.listEntitiesByIds = async function listEntitiesByIds(auth, entityIds) {
  const wanted = new Set(entityIds);
  return stateRef.current.entities.filter(
    (entity) => entity.tenant_id === auth.tenantId && entity.user_id === auth.userId && wanted.has(entity.id)
  );
};

MemoryGraphRepository.prototype.listRelationsForEntityIds = async function listRelationsForEntityIds(
  auth,
  entityIds,
  limit = 600
) {
  const wanted = new Set(entityIds);
  return stateRef.current.relations
    .filter(
      (relation) =>
        relation.tenant_id === auth.tenantId &&
        relation.user_id === auth.userId &&
        relation.active &&
        (wanted.has(relation.source_entity_id) || wanted.has(relation.target_entity_id))
    )
    .sort((a, b) => b.confidence_score - a.confidence_score || b.last_seen_at.localeCompare(a.last_seen_at))
    .slice(0, limit);
};

MemoryGraphRepository.prototype.listMentionsForEntityIds = async function listMentionsForEntityIds(
  auth,
  entityIds,
  limit = 800
) {
  const wanted = new Set(entityIds);
  return stateRef.current.mentions
    .filter(
      (mention) =>
        mention.tenant_id === auth.tenantId && mention.user_id === auth.userId && wanted.has(mention.entity_id)
    )
    .sort((a, b) => b.confidence - a.confidence || b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
};

MemoryGraphRepository.prototype.listLatestMemoryMeta = async function listLatestMemoryMeta(auth, limit = 80) {
  return stateRef.current.memories
    .filter(
      (memory) =>
        memory.tenant_id === auth.tenantId &&
        memory.user_id === auth.userId &&
        memory.deleted_at === null &&
        !memory.superseded_by
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((memory) => ({ id: memory.id, platform: memory.platform, created_at: memory.created_at }));
};

MemoryGraphRepository.prototype.listMentionsForMemoryIds = async function listMentionsForMemoryIds(auth, memoryIds) {
  const wanted = new Set(memoryIds);
  return stateRef.current.mentions
    .filter(
      (mention) =>
        mention.tenant_id === auth.tenantId && mention.user_id === auth.userId && wanted.has(mention.memory_id)
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
};

MemoryGraphRepository.prototype.listEntities = async function listEntities(auth, limit = 40, q) {
  const search = q ? normalizeLabel(q) : "";
  return stateRef.current.entities
    .filter(
      (entity) =>
        entity.tenant_id === auth.tenantId &&
        entity.user_id === auth.userId &&
        (!search || entity.normalized_label.includes(search))
    )
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at) || b.source_confidence - a.source_confidence)
    .slice(0, limit);
};

MemoryGraphRepository.prototype.listTopEntities = async function listTopEntities(auth, limit = 8) {
  const counts = new Map<string, number>();
  for (const mention of stateRef.current.mentions) {
    if (mention.tenant_id !== auth.tenantId || mention.user_id !== auth.userId) continue;
    counts.set(mention.entity_id, (counts.get(mention.entity_id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([entityId, mentions]) => ({ entity_id: entityId, mentions }));
};

MemoryGraphRepository.prototype.listStrongestRelations = async function listStrongestRelations(auth, limit = 10) {
  return stateRef.current.relations
    .filter((relation) => relation.tenant_id === auth.tenantId && relation.user_id === auth.userId && relation.active)
    .sort((a, b) => b.confidence_score - a.confidence_score || b.last_seen_at.localeCompare(a.last_seen_at))
    .slice(0, limit)
    .map((relation) => ({
      source_entity_id: relation.source_entity_id,
      target_entity_id: relation.target_entity_id,
      relation_type: relation.relation_type,
      confidence_score: relation.confidence_score,
      confidence_label: relation.confidence_label,
    }));
};

MemoryGraphRepository.prototype.countUncertainRelations = async function countUncertainRelations(auth) {
  return stateRef.current.relations.filter(
    (relation) =>
      relation.tenant_id === auth.tenantId &&
      relation.user_id === auth.userId &&
      relation.active &&
      relation.confidence_label === "uncertain"
  ).length;
};

const [
  { saveMemory, recallMemories, deleteMemory },
  { enqueueGraphExtractionJob, recallMemoriesV2 },
  { startMemoryGraphWorker, stopMemoryGraphWorker },
  { getMemoryGraphInsights },
  { config },
  { buildUserSnapshot },
] =
  await Promise.all([
    import("../../src/services/memory.js"),
    import("../../src/orchestration/graph/recall-v2.usecase.js"),
    import("../../src/orchestration/graph/extract-graph.worker.js"),
    import("../../src/orchestration/graph/graph-insights.usecase.js"),
    import("../../src/config/index.js"),
    import("../../src/orchestration/graph/precomputed-recall.usecase.js"),
  ]);

config.graphExtractionEnabled = true;
config.recallV2Enabled = true;

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("waitUntil timed out");
}

test(
  "saveMemory enqueues one extract job and deduplicates duplicate enqueue calls",
  { concurrency: false },
  async () => {
    resetState();
    const auth = {
      tenantId: "tenant-a",
      userId: "user-a",
      authMode: "internal" as const,
    };

    const saved = await saveMemory(
      [
        "Project: Tallei",
        "Tool: Postgres",
        "Tool: Qdrant",
        "Alice uses Postgres",
        "Alice works on Tallei",
      ].join("\n"),
      auth,
      "claude"
    );

    await enqueueGraphExtractionJob(auth, saved.memoryId);
    await enqueueGraphExtractionJob(auth, saved.memoryId);

    const jobs = stateRef.current.jobs.filter((job) => job.memory_id === saved.memoryId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "queued");
  }
);

test(
  "full graph-memory flow: save -> worker -> recall-v2 explanations -> insights",
  { concurrency: false },
  async () => {
    resetState();
    const auth = {
      tenantId: "tenant-b",
      userId: "user-b",
      authMode: "internal" as const,
    };

    const saveOne = await saveMemory(
      [
        "Project: Tallei",
        "Tool: Postgres",
        "Tool: Qdrant",
        "Alice prefers Postgres",
        "Alice uses Postgres",
        "Alice uses Qdrant",
        "Alice works on Tallei",
      ].join("\n"),
      auth,
      "other"
    );

    const saveTwo = await saveMemory(
      [
        "Project: Tallei",
        "Tool: Redis",
        "Alice prefers Redis",
        "Alice chooses Redis",
      ].join("\n"),
      auth,
      "chatgpt"
    );

    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((handler: (...args: any[]) => void) => {
      return { unref() {}, handler } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    try {
      startMemoryGraphWorker();
      await waitUntil(() => {
        const scoped = stateRef.current.jobs.filter((job) => scopeKey({ tenantId: job.tenant_id, userId: job.user_id }) === scopeKey(auth));
        return scoped.length >= 2 && scoped.every((job) => job.status === "done");
      });
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      stopMemoryGraphWorker();
    }

    assert.ok(stateRef.current.entities.length >= 4, "expected extracted entities");
    assert.ok(stateRef.current.relations.length >= 2, "expected extracted relations");

    const recalled = await recallMemoriesV2("postgres tallei", auth, 5, 1);
    assert.equal(recalled.retrieval_mode, "graph_augmented");
    assert.ok(recalled.memories.some((memory) => memory.id === saveOne.memoryId));
    assert.ok(
      stateRef.current.events.some(
        (event) =>
          event.action === "recall_v2" &&
          typeof event.metadata?.source === "string" &&
          event.metadata.source === "precomputed_graph_hit"
      ),
      "expected precomputed graph hit"
    );

    const explanation = recalled.explanations.find((item) => item.memory_id === saveOne.memoryId);
    assert.ok(explanation, "expected explanation entry for first memory");
    assert.ok(
      explanation?.reasons.some((reason) => reason.includes("Direct entity match")),
      "expected direct graph reason in explanation"
    );

    const insights = await getMemoryGraphInsights(auth);
    assert.ok(insights.summary.highImpactCount > 0, "expected at least one high-impact relationship");
    assert.ok(
      insights.summary.contradictionCount >= 0,
      "contradiction count should be a non-negative number"
    );

    assert.ok(
      stateRef.current.jobs.every((job) => job.status === "done"),
      "all scoped jobs should be done after worker tick"
    );
    assert.ok(
      [saveOne.memoryId, saveTwo.memoryId].every((id) =>
        stateRef.current.memories.some((memory) => memory.id === id)
      )
    );
  }
);

test(
  "fast recall returns immediate recent fallback and next call uses enriched cache",
  { concurrency: false },
  async () => {
    resetState();
    const auth = {
      tenantId: "tenant-c",
      userId: "user-c",
      authMode: "internal" as const,
    };

    await saveMemory("Alice prefers Postgres for Tallei", auth, "chatgpt");
    await saveMemory("Alice is exploring Kubernetes", auth, "chatgpt");

    let searchCalls = 0;
    const originalSearchVectors = VectorRepository.prototype.searchVectors;
    VectorRepository.prototype.searchVectors = async function wrappedSearch(authArg, queryVector, limit) {
      searchCalls += 1;
      return originalSearchVectors.call(this, authArg, queryVector, limit);
    };

    try {
      const startedAt = Date.now();
      const first = await recallMemories("postgres tallei", auth, 5);
      const elapsedMs = Date.now() - startedAt;

      assert.ok(elapsedMs < 1200, `expected immediate fallback under 1200ms, got ${elapsedMs}ms`);
      assert.ok(first.memories.every((memory) => memory.metadata.retrieval === "recent_fallback"));
      assert.ok(
        stateRef.current.events.some(
          (event) =>
            event.action === "recall" &&
            typeof event.metadata?.source === "string" &&
            event.metadata.source === "precomputed_graph_miss"
        ),
        "expected precomputed miss labeling on fallback"
      );

      await waitUntil(() => searchCalls > 0);
      const callsAfterEnrich = searchCalls;

      const second = await recallMemories("postgres tallei", auth, 5);
      assert.ok(second.memories.length > 0);
      assert.equal(searchCalls, callsAfterEnrich, "exact cache hit should avoid re-running semantic search");
    } finally {
      VectorRepository.prototype.searchVectors = originalSearchVectors;
    }
  }
);

test(
  "precomputed snapshot hit avoids semantic vector search after worker refresh",
  { concurrency: false },
  async () => {
    resetState();
    const auth = {
      tenantId: "tenant-f",
      userId: "user-f",
      authMode: "internal" as const,
    };

    await saveMemory("Project Tallei uses Postgres and Redis", auth, "chatgpt");
    await saveMemory("Tallei graph memory mentions Postgres", auth, "claude");

    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((handler: (...args: any[]) => void) => {
      return { unref() {}, handler } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    try {
      startMemoryGraphWorker();
      await waitUntil(() => {
        const scoped = stateRef.current.jobs.filter(
          (job) =>
            scopeKey({ tenantId: job.tenant_id, userId: job.user_id }) === scopeKey(auth) &&
            (job.job_type === "extract" || job.job_type === "snapshot_refresh")
        );
        return scoped.length >= 2 && scoped.every((job) => job.status === "done");
      });
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      stopMemoryGraphWorker();
    }

    await buildUserSnapshot(auth);

    let searchCalls = 0;
    const originalSearchVectors = VectorRepository.prototype.searchVectors;
    VectorRepository.prototype.searchVectors = async function wrappedSearch(authArg, queryVector, limit) {
      searchCalls += 1;
      return originalSearchVectors.call(this, authArg, queryVector, limit);
    };

    try {
      const recalled = await recallMemories("postgres tallei", auth, 5);
      assert.ok(recalled.memories.length > 0);
      assert.ok(
        recalled.memories.some((memory) => memory.metadata.source === "precomputed_graph"),
        "expected precomputed graph-backed memories"
      );
      assert.equal(searchCalls, 0, "precomputed recall path should avoid vector search");
      assert.ok(
        stateRef.current.events.some(
          (event) =>
            event.action === "recall" &&
            typeof event.metadata?.source === "string" &&
            (event.metadata.source === "precomputed_graph_hit" || event.metadata.source === "exact_cache")
        ),
        "expected fast cache or precomputed graph hit"
      );
    } finally {
      VectorRepository.prototype.searchVectors = originalSearchVectors;
    }
  }
);

test(
  "save/delete invalidates fast recall stamp and forces fallback before re-enrichment",
  { concurrency: false },
  async () => {
    resetState();
    const auth = {
      tenantId: "tenant-d",
      userId: "user-d",
      authMode: "internal" as const,
    };

    const saved = await saveMemory("Alice likes Redis and Tallei", auth, "chatgpt");

    await recallMemories("redis", auth, 5);
    await waitUntil(() => stateRef.current.events.some((event) => event.action === "recall_enrich"));

    const primed = await recallMemories("redis", auth, 5);
    assert.ok(primed.memories.length > 0);

    await saveMemory("Alice switched to Postgres", auth, "chatgpt");
    const afterSave = await recallMemories("redis", auth, 5);
    assert.ok(afterSave.memories.every((memory) => memory.metadata.retrieval === "recent_fallback"));

    await deleteMemory(saved.memoryId, auth);
    const afterDelete = await recallMemories("redis", auth, 5);
    assert.ok(afterDelete.memories.every((memory) => memory.metadata.retrieval === "recent_fallback"));
  }
);

test(
  "recall-v2 fallback response keeps compatible shape",
  { concurrency: false },
  async () => {
    resetState();
    const auth = {
      tenantId: "tenant-e",
      userId: "user-e",
      authMode: "internal" as const,
    };

    await saveMemory("Alice likes distributed systems", auth, "claude");
    const result = await recallMemoriesV2("distributed systems", auth, 5, 1);

    assert.equal(result.retrieval_mode, "vector_fallback");
    assert.ok(Array.isArray(result.memories));
    assert.ok(Array.isArray(result.explanations));
    assert.equal(result.explanations.length, result.memories.length);
    assert.ok(typeof result.contextBlock === "string" && result.contextBlock.length > 0);
  }
);

test.after(() => {
  globalThis.fetch = originalFetch;
});
