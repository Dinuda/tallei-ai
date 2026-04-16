import { createHash } from "crypto";
import { config } from "../config.js";
import type { AuthContext } from "../types/auth.js";
import { embedText } from "./embeddings.js";
import { decryptMemoryContent } from "./crypto.js";
import {
  buildRecentFallback,
  readExactRecallPayload,
  readWarmRecallPayload,
  runBackgroundRecallEnrichment,
  writeRecallPayload,
} from "./fastRecall.js";
import { lookupPrecomputedRecallV2, queueSnapshotRefresh } from "./precomputedGraphRecall.js";
import { setRequestTimingFields } from "./requestTiming.js";
import { VectorRepository } from "../repositories/vectorRepository.js";
import { MemoryRepository } from "../repositories/memoryRepository.js";
import { MemoryGraphRepository } from "../repositories/memoryGraphRepository.js";
import { MemoryGraphJobRepository } from "../repositories/memoryGraphJobRepository.js";

const vectorRepository = new VectorRepository();
const memoryRepository = new MemoryRepository();
const graphRepository = new MemoryGraphRepository();
const graphJobRepository = new MemoryGraphJobRepository();

const GRAPH_TIMEOUT_MS = 100;
const RECALL_V2_CACHE_TTL_MS = 5 * 60_000;
const VECTOR_BYPASS_TTL_MS = config.nodeEnv === "production" ? 0 : 60_000;
const FAST_RECALL_EMBED_TIMEOUT_MS = config.memoryRecallEmbedTimeoutMs;
const FAST_RECALL_VECTOR_TIMEOUT_MS = config.memoryRecallVectorTimeoutMs;
const FAST_RECALL_TOTAL_TIMEOUT_MS = config.memoryRecallTotalTimeoutMs;

interface VectorCandidate {
  memoryId: string;
  score: number;
}

interface GraphSignal {
  graphScore: number;
  reasons: string[];
  topPaths: string[];
  confidenceSummary: {
    explicit: number;
    inferred: number;
    uncertain: number;
  };
}

export interface RecallV2Result {
  contextBlock: string;
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
  explanations: Array<{
    memory_id: string;
    reasons: string[];
    top_paths: string[];
    confidence_summary: {
      explicit: number;
      inferred: number;
      uncertain: number;
    };
  }>;
  retrieval_mode: "graph_augmented" | "vector_fallback";
  timings_ms: Record<string, number>;
  debug_flags?: Record<string, unknown>;
}

interface RecallV2CacheEntry {
  exp: number;
  result: RecallV2Result;
}

const recallV2Cache = new Map<string, RecallV2CacheEntry>();
let vectorBypassUntil = 0;

function isVectorInfraError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Qdrant|timeout|aborted|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|No route to host/i.test(error.message);
}

function shouldBypassVector(): boolean {
  return VECTOR_BYPASS_TTL_MS > 0 && Date.now() < vectorBypassUntil;
}

function noteVectorFailure(error: unknown): void {
  if (VECTOR_BYPASS_TTL_MS > 0 && isVectorInfraError(error)) {
    vectorBypassUntil = Date.now() + VECTOR_BYPASS_TTL_MS;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function recencyScore(createdAtIso: string): number {
  const days = Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000);
  return Math.max(0, 1 - days / 30);
}

function cacheKey(auth: AuthContext, query: string, limit: number, depth: number): string {
  const hash = createHash("sha256").update(query).digest("hex");
  return `recall-v2:${auth.tenantId}:${auth.userId}:${limit}:${depth}:${hash}`;
}

function enrichmentKey(auth: AuthContext, query: string, limit: number, depth: number): string {
  return `recall-v2-enrich:${auth.tenantId}:${auth.userId}:${limit}:${depth}:${createHash("sha256").update(query).digest("hex")}`;
}

export function invalidateRecallV2Cache(auth: AuthContext): void {
  const prefix = `recall-v2:${auth.tenantId}:${auth.userId}:`;
  for (const key of recallV2Cache.keys()) {
    if (key.startsWith(prefix)) {
      recallV2Cache.delete(key);
    }
  }
}

function vectorNormalize(score: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, score / max));
}

async function vectorCandidates(auth: AuthContext, query: string, limit: number): Promise<VectorCandidate[]> {
  if (shouldBypassVector()) return [];
  try {
    const queryVector = await embedText(query);
    const results = await vectorRepository.searchVectors(auth, queryVector, Math.max(limit * 3, 20));
    return results.map((row) => ({ memoryId: row.memoryId, score: row.score }));
  } catch (error) {
    noteVectorFailure(error);
    return [];
  }
}

function fallbackV2Result(
  contextBlock: string,
  memories: Array<{ id: string; text: string; score: number; metadata: Record<string, unknown> }>,
  fallbackMs: number
): RecallV2Result {
  return {
    contextBlock,
    memories,
    explanations: memories.map((memory) => ({
      memory_id: memory.id,
      reasons: ["Recent memory fallback"],
      top_paths: ["recent_memory -> recall"],
      confidence_summary: { explicit: 0, inferred: 0, uncertain: 0 },
    })),
    retrieval_mode: "vector_fallback",
    timings_ms: {
      fallback_ms: fallbackMs,
      total: fallbackMs,
    },
    debug_flags: debugFlags({ source: "recent_fallback" }),
  };
}

async function semanticRecallMemoriesV2(
  query: string,
  auth: AuthContext,
  limit: number,
  depth: number
): Promise<RecallV2Result> {
  const start = Date.now();
  const timings: Record<string, number> = {};
  const flags: Record<string, unknown> = {};

  const vectorStarted = Date.now();
  let vectorHits: VectorCandidate[] = [];
  if (!shouldBypassVector()) {
    try {
      const embedStarted = Date.now();
      const queryVector = await withTimeout(
        embedText(query),
        FAST_RECALL_EMBED_TIMEOUT_MS,
        "recall_v2.embed"
      );
      timings.embed_ms = Date.now() - embedStarted;

      const searchStarted = Date.now();
      const results = await withTimeout(
        vectorRepository.searchVectors(auth, queryVector, Math.max(limit * 3, 20)),
        FAST_RECALL_VECTOR_TIMEOUT_MS,
        "recall_v2.searchVectors"
      );
      timings.vector_ms = Date.now() - searchStarted;
      vectorHits = results.map((row) => ({ memoryId: row.memoryId, score: row.score }));
    } catch (error) {
      noteVectorFailure(error);
    }
  }
  timings.vector = Date.now() - vectorStarted;

  const graphStarted = Date.now();
  let signalsByMemory = new Map<string, GraphSignal>();
  let retrievalMode: RecallV2Result["retrieval_mode"] = "graph_augmented";
  try {
    const graph = await withTimeout(graphSignals(auth, query, depth), GRAPH_TIMEOUT_MS, "graph.signals");
    signalsByMemory = graph.signalsByMemory;
    flags.graph_entities = graph.entityIds.length;
  } catch (error) {
    retrievalMode = "vector_fallback";
    flags.graph_timeout = true;
    flags.graph_error = error instanceof Error ? error.message : "graph_failed";
  }
  timings.graph_ms = Date.now() - graphStarted;
  timings.graph = timings.graph_ms;

  const candidateMemoryIds = new Set<string>(vectorHits.map((hit) => hit.memoryId));
  for (const memoryId of signalsByMemory.keys()) {
    candidateMemoryIds.add(memoryId);
  }

  if (candidateMemoryIds.size === 0) {
    const fallbackRows = await memoryRepository.list(auth, Math.max(limit * 6, 30));
    for (const row of fallbackRows.slice(0, Math.max(limit * 2, 10))) {
      candidateMemoryIds.add(row.id);
    }
  }

  const rows = await memoryRepository.getByIds(auth, [...candidateMemoryIds]);
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const maxVectorScore = vectorHits.reduce((max, hit) => Math.max(max, hit.score), 0);
  const vectorScoreByMemoryId = new Map(vectorHits.map((hit) => [hit.memoryId, hit.score]));

  const ranking = [...candidateMemoryIds]
    .map((memoryId) => {
      const row = rowById.get(memoryId);
      if (!row) return null;

      const vectorScore = vectorNormalize(vectorScoreByMemoryId.get(memoryId) ?? 0, maxVectorScore);
      const graphSignal = signalsByMemory.get(memoryId);
      const graphRelevance = Math.max(0, Math.min(1, (graphSignal?.graphScore ?? 0) / 3));
      const recency = recencyScore(row.created_at);

      const confSummary = graphSignal?.confidenceSummary ?? { explicit: 0, inferred: 0, uncertain: 0 };
      const confTotal = confSummary.explicit + confSummary.inferred + confSummary.uncertain;
      const confidenceWeight = confTotal === 0
        ? 0.5
        : Math.max(
            0,
            Math.min(
              1,
              (confSummary.explicit * 1 + confSummary.inferred * 0.7 + confSummary.uncertain * 0.2) / confTotal
            )
          );

      const score = Number(
        (
          vectorScore * 0.55 +
          graphRelevance * 0.25 +
          recency * 0.15 +
          confidenceWeight * 0.05
        ).toFixed(5)
      );

      let text = "";
      try {
        text = decryptMemoryContent(row.content_ciphertext);
      } catch {
        text = "[Encrypted memory unavailable]";
      }

      const summaryMetadata = (row.summary_json && typeof row.summary_json === "object"
        ? (row.summary_json as Record<string, unknown>)
        : {}) as Record<string, unknown>;

      return {
        id: memoryId,
        text,
        score,
        metadata: {
          ...summaryMetadata,
          platform: row.platform,
          createdAt: row.created_at,
        },
        explanation: {
          memory_id: memoryId,
          reasons: graphSignal?.reasons ?? ["Vector similarity match"],
          top_paths: graphSignal?.topPaths ?? ["query -> vector_match -> memory"],
          confidence_summary: confSummary,
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    contextBlock: buildContextBlock(ranking),
    memories: ranking.map((item) => ({
      id: item.id,
      text: item.text,
      score: item.score,
      metadata: item.metadata,
    })),
    explanations: ranking.map((item) => item.explanation),
    retrieval_mode: retrievalMode,
    timings_ms: {
      ...timings,
      total: Date.now() - start,
    },
    debug_flags: debugFlags(flags),
  };
}

function logRecallV2Event(
  auth: AuthContext,
  query: string,
  limit: number,
  depth: number,
  requesterIp: string | undefined,
  result: RecallV2Result,
  source:
    | "exact_cache"
    | "warm_cache"
    | "recent_fallback"
    | "semantic_enriched"
    | "precomputed_graph_hit"
    | "precomputed_graph_miss"
    | "precomputed_graph_stale",
  snapshot: { status?: string; lookupMs?: number; ageMs?: number } = {}
): void {
  setRequestTimingFields({
    recall_source: source,
    recall_cache_hit: source === "exact_cache" || source === "warm_cache",
    recall_mode: result.retrieval_mode,
    recall_fallback_ms: result.timings_ms.fallback_ms ?? 0,
    recall_relevance_miss: (result.timings_ms.relevance_miss ?? 0) > 0,
    recall_enrich_ms: result.timings_ms.total ?? 0,
    recall_embed_ms: result.timings_ms.embed_ms ?? 0,
    recall_vector_ms: result.timings_ms.vector_ms ?? 0,
    recall_graph_ms: result.timings_ms.graph_ms ?? 0,
    recall_total_ms: result.timings_ms.total ?? 0,
    recall_snapshot_status: snapshot.status ?? null,
    recall_snapshot_lookup_ms: snapshot.lookupMs ?? 0,
    recall_snapshot_age_ms: snapshot.ageMs ?? 0,
  });
  void memoryRepository.logEvent({
    auth,
    action: "recall_v2",
    ipHash: requesterIp ? createHash("sha256").update(requesterIp).digest("hex") : null,
    metadata: {
      query,
      limit,
      graphDepth: depth,
      retrievalMode: result.retrieval_mode,
      hits: result.memories.length,
      source,
      cache_hit: source === "exact_cache" || source === "warm_cache",
      fallback_ms: result.timings_ms.fallback_ms ?? 0,
      relevance_miss: (result.timings_ms.relevance_miss ?? 0) > 0,
      enrich_ms: result.timings_ms.total ?? 0,
      embed_ms: result.timings_ms.embed_ms ?? 0,
      vector_ms: result.timings_ms.vector_ms ?? 0,
      graph_ms: result.timings_ms.graph_ms ?? 0,
      snapshot_status: snapshot.status ?? null,
      snapshot_lookup_ms: snapshot.lookupMs ?? 0,
      snapshot_age_ms: snapshot.ageMs ?? 0,
      timings: result.timings_ms,
    },
  }).catch(() => {});
}

function buildContextBlock(memories: Array<{ text: string; metadata: Record<string, unknown> }>): string {
  if (memories.length === 0) return "--- No relevant memories found ---";
  const lines = memories.map((memory) => {
    const platformRaw = memory.metadata.platform;
    const platform = typeof platformRaw === "string" && platformRaw.length > 0 ? platformRaw : "unknown";
    return `[${platform.toUpperCase()}] ${memory.text}`;
  });
  return `--- Your Past Context ---\n${lines.join("\n")}\n---`;
}

async function graphSignals(
  auth: AuthContext,
  query: string,
  depth: number
): Promise<{
  entityIds: string[];
  signalsByMemory: Map<string, GraphSignal>;
}> {
  const tokens = tokenize(query);
  const matchedEntities = await graphRepository.searchEntitiesByTokens(auth, tokens, 24);
  const matchedEntityIds = matchedEntities.map((entity) => entity.id);
  if (matchedEntityIds.length === 0) {
    return { entityIds: [], signalsByMemory: new Map() };
  }

  const visited = new Set(matchedEntityIds);
  let frontier = new Set(matchedEntityIds);
  const allRelations = new Map<string, Awaited<ReturnType<typeof graphRepository.listRelationsForEntityIds>>[number]>();

  for (let hop = 0; hop < Math.max(1, Math.min(2, depth)); hop += 1) {
    if (frontier.size === 0) break;
    const relations = await graphRepository.listRelationsForEntityIds(auth, [...frontier], 500);
    const next = new Set<string>();
    for (const relation of relations) {
      allRelations.set(relation.id, relation);
      if (!visited.has(relation.source_entity_id)) {
        visited.add(relation.source_entity_id);
        next.add(relation.source_entity_id);
      }
      if (!visited.has(relation.target_entity_id)) {
        visited.add(relation.target_entity_id);
        next.add(relation.target_entity_id);
      }
    }
    frontier = next;
  }

  const allEntityIds = [...visited];
  const entities = await graphRepository.listEntitiesByIds(auth, allEntityIds);
  const entityLabelById = new Map(entities.map((entity) => [entity.id, entity.canonical_label]));
  const mentions = await graphRepository.listMentionsForEntityIds(auth, allEntityIds, 1200);

  const confidenceByEntity = new Map<string, { explicit: number; inferred: number; uncertain: number }>();
  for (const relation of allRelations.values()) {
    const sourceCounter = confidenceByEntity.get(relation.source_entity_id) ?? {
      explicit: 0,
      inferred: 0,
      uncertain: 0,
    };
    sourceCounter[relation.confidence_label] += 1;
    confidenceByEntity.set(relation.source_entity_id, sourceCounter);

    const targetCounter = confidenceByEntity.get(relation.target_entity_id) ?? {
      explicit: 0,
      inferred: 0,
      uncertain: 0,
    };
    targetCounter[relation.confidence_label] += 1;
    confidenceByEntity.set(relation.target_entity_id, targetCounter);
  }

  const signalsByMemory = new Map<string, GraphSignal>();
  for (const mention of mentions) {
    const label = entityLabelById.get(mention.entity_id) ?? mention.mention_text;
    const existing = signalsByMemory.get(mention.memory_id) ?? {
      graphScore: 0,
      reasons: [],
      topPaths: [],
      confidenceSummary: { explicit: 0, inferred: 0, uncertain: 0 },
    };

    const isDirect = matchedEntityIds.includes(mention.entity_id);
    existing.graphScore += isDirect ? 1.0 : 0.55;
    const reason = isDirect
      ? `Direct entity match: ${label}`
      : `Related entity match: ${label}`;
    if (!existing.reasons.includes(reason) && existing.reasons.length < 4) {
      existing.reasons.push(reason);
    }
    const path = isDirect ? `${label} -> memory` : `query entities -> ${label} -> memory`;
    if (!existing.topPaths.includes(path) && existing.topPaths.length < 3) {
      existing.topPaths.push(path);
    }

    const c = confidenceByEntity.get(mention.entity_id);
    if (c) {
      existing.confidenceSummary.explicit += c.explicit;
      existing.confidenceSummary.inferred += c.inferred;
      existing.confidenceSummary.uncertain += c.uncertain;
    }

    signalsByMemory.set(mention.memory_id, existing);
  }

  return { entityIds: allEntityIds, signalsByMemory };
}

function debugFlags(base: Record<string, unknown>): Record<string, unknown> | undefined {
  if (config.nodeEnv === "production") return undefined;
  return base;
}

export async function enqueueGraphExtractionJob(auth: AuthContext, memoryId: string): Promise<void> {
  if (!config.graphExtractionEnabled) return;
  await graphJobRepository.enqueueExtractJob(auth, memoryId, { reason: "save_memory" });
}

export async function recallMemoriesV2(
  query: string,
  auth: AuthContext,
  limit = 5,
  graphDepth = 1,
  requesterIp?: string
): Promise<RecallV2Result> {
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
  const boundedLimit = Math.min(20, Math.max(1, limit));
  const depth = Math.max(1, Math.min(2, graphDepth));
  const key = cacheKey(auth, normalizedQuery, boundedLimit, depth);
  const cached = recallV2Cache.get(key);
  if (cached && cached.exp > Date.now()) {
    logRecallV2Event(auth, normalizedQuery, boundedLimit, depth, requesterIp, cached.result, "exact_cache");
    return cached.result;
  }

  const exactHit = await readExactRecallPayload<RecallV2Result>(auth, normalizedQuery, "v2");
  if (exactHit) {
    recallV2Cache.set(key, { exp: Date.now() + RECALL_V2_CACHE_TTL_MS, result: exactHit });
    logRecallV2Event(auth, normalizedQuery, boundedLimit, depth, requesterIp, exactHit, "exact_cache");
    return exactHit;
  }

  const warmHit = await readWarmRecallPayload<RecallV2Result>(auth, normalizedQuery, "v2");
  if (warmHit) {
    recallV2Cache.set(key, { exp: Date.now() + RECALL_V2_CACHE_TTL_MS, result: warmHit });
    runBackgroundRecallEnrichment(enrichmentKey(auth, normalizedQuery, boundedLimit, depth), async () => {
      const enriched = await withTimeout(
        semanticRecallMemoriesV2(normalizedQuery, auth, boundedLimit, depth),
        FAST_RECALL_TOTAL_TIMEOUT_MS,
        "recall_v2.enrichTotal"
      );
      recallV2Cache.set(key, { exp: Date.now() + RECALL_V2_CACHE_TTL_MS, result: enriched });
      await writeRecallPayload(auth, normalizedQuery, "v2", enriched);
      logRecallV2Event(auth, normalizedQuery, boundedLimit, depth, requesterIp, enriched, "semantic_enriched");
    });
    logRecallV2Event(auth, normalizedQuery, boundedLimit, depth, requesterIp, warmHit, "warm_cache");
    return warmHit;
  }

  const snapshotLookup = await lookupPrecomputedRecallV2(auth, normalizedQuery, boundedLimit);
  if (snapshotLookup.status === "hit" && snapshotLookup.result) {
    recallV2Cache.set(key, { exp: Date.now() + RECALL_V2_CACHE_TTL_MS, result: snapshotLookup.result });
    void writeRecallPayload(auth, normalizedQuery, "v2", snapshotLookup.result).catch(() => {});
    logRecallV2Event(
      auth,
      normalizedQuery,
      boundedLimit,
      depth,
      requesterIp,
      snapshotLookup.result,
      "precomputed_graph_hit",
      {
        status: snapshotLookup.status,
        lookupMs: snapshotLookup.snapshot_lookup_ms,
        ageMs: snapshotLookup.snapshot_age_ms,
      }
    );
    return snapshotLookup.result;
  }

  const fallback = await buildRecentFallback(auth, normalizedQuery, boundedLimit);
  const result = fallbackV2Result(fallback.contextBlock, fallback.memories, fallback.elapsedMs);
  if (fallback.relevanceMiss) {
    result.timings_ms.relevance_miss = 1;
    void queueSnapshotRefresh(auth, "fallback_relevance_miss_v2", 750).catch(() => {});
  }

  runBackgroundRecallEnrichment(enrichmentKey(auth, normalizedQuery, boundedLimit, depth), async () => {
    const enriched = await withTimeout(
      semanticRecallMemoriesV2(normalizedQuery, auth, boundedLimit, depth),
      FAST_RECALL_TOTAL_TIMEOUT_MS,
      "recall_v2.enrichTotal"
    );
    recallV2Cache.set(key, { exp: Date.now() + RECALL_V2_CACHE_TTL_MS, result: enriched });
    await writeRecallPayload(auth, normalizedQuery, "v2", enriched);
    logRecallV2Event(auth, normalizedQuery, boundedLimit, depth, requesterIp, enriched, "semantic_enriched");
  });
  const fallbackSource =
    snapshotLookup.status === "miss"
      ? "precomputed_graph_miss"
      : snapshotLookup.status === "stale"
        ? "precomputed_graph_stale"
        : "recent_fallback";
  logRecallV2Event(auth, normalizedQuery, boundedLimit, depth, requesterIp, result, fallbackSource, {
    status: snapshotLookup.status,
    lookupMs: snapshotLookup.snapshot_lookup_ms,
    ageMs: snapshotLookup.snapshot_age_ms,
  });
  return result;
}

export async function listMemoryEntities(auth: AuthContext, limit = 40, q?: string): Promise<Array<{
  id: string;
  label: string;
  entityType: string;
  confidence: number;
  lastSeenAt: string;
}>> {
  const rows = await graphRepository.listEntities(auth, limit, q);
  return rows.map((row) => ({
    id: row.id,
    label: row.canonical_label,
    entityType: row.entity_type,
    confidence: row.source_confidence,
    lastSeenAt: row.last_seen_at,
  }));
}

export async function explainMemoryConnection(
  auth: AuthContext,
  sourceQuery: string,
  targetQuery: string
): Promise<{ found: boolean; explanation: string; path: string[] }> {
  const sourceCandidates = await graphRepository.listEntities(auth, 6, sourceQuery);
  const targetCandidates = await graphRepository.listEntities(auth, 6, targetQuery);
  const source = sourceCandidates[0];
  const target = targetCandidates[0];

  if (!source || !target) {
    return {
      found: false,
      explanation: "Could not find one or both entities in your memory graph.",
      path: [],
    };
  }

  if (source.id === target.id) {
    return {
      found: true,
      explanation: "Both queries resolve to the same entity.",
      path: [source.canonical_label],
    };
  }

  const relations = await graphRepository.listRelationsForEntityIds(auth, [source.id, target.id], 800);
  const adjacency = new Map<string, Array<{ to: string; relation: string }>>();
  for (const relation of relations) {
    const sourceEdges = adjacency.get(relation.source_entity_id) ?? [];
    sourceEdges.push({ to: relation.target_entity_id, relation: relation.relation_type });
    adjacency.set(relation.source_entity_id, sourceEdges);

    const targetEdges = adjacency.get(relation.target_entity_id) ?? [];
    targetEdges.push({ to: relation.source_entity_id, relation: relation.relation_type });
    adjacency.set(relation.target_entity_id, targetEdges);
  }

  const queue: Array<{ entityId: string; path: string[] }> = [
    { entityId: source.id, path: [source.id] },
  ];
  const visited = new Set<string>([source.id]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.path.length > 4) continue;

    if (current.entityId === target.id) {
      const entityIds = [...new Set(current.path)];
      const entities = await graphRepository.listEntitiesByIds(auth, entityIds);
      const labelById = new Map(entities.map((entity) => [entity.id, entity.canonical_label]));
      const prettyPath = current.path.map((id) => labelById.get(id) ?? id);
      return {
        found: true,
        explanation: "Connection found in memory graph.",
        path: prettyPath,
      };
    }

    const edges = adjacency.get(current.entityId) ?? [];
    for (const edge of edges) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      queue.push({ entityId: edge.to, path: [...current.path, edge.to] });
    }
  }

  return {
    found: false,
    explanation: "No graph path found between those entities in current memory scope.",
    path: [source.canonical_label, target.canonical_label],
  };
}

export async function getMemoryGraphSnapshot(auth: AuthContext): Promise<{
  nodes: Array<{ id: string; label: string; kind: "memory" | "entity" | "platform"; weight: number }>;
  edges: Array<{ from: string; to: string; kind: "mention" | "relation" | "platform"; confidenceLabel?: string }>;
  panels: {
    topEntities: Array<{ label: string; mentions: number }>;
    strongestRelations: Array<{ source: string; target: string; relationType: string; confidence: number; confidenceLabel: string }>;
    uncertainRelations: number;
  };
}> {
  const memoryMeta = await graphRepository.listLatestMemoryMeta(auth, 80);
  const memoryIds = memoryMeta.map((row) => row.id);
  const mentions = await graphRepository.listMentionsForMemoryIds(auth, memoryIds);
  const entityIds = [...new Set(mentions.map((m) => m.entity_id))];
  const entities = await graphRepository.listEntitiesByIds(auth, entityIds);
  const relations = await graphRepository.listRelationsForEntityIds(auth, entityIds, 600);

  const nodes: Array<{ id: string; label: string; kind: "memory" | "entity" | "platform"; weight: number }> = [];
  const edges: Array<{ from: string; to: string; kind: "mention" | "relation" | "platform"; confidenceLabel?: string }> = [];

  for (const memory of memoryMeta) {
    nodes.push({
      id: `m:${memory.id}`,
      label: memory.id.slice(0, 8),
      kind: "memory",
      weight: 1,
    });
  }

  for (const entity of entities) {
    nodes.push({
      id: `e:${entity.id}`,
      label: entity.canonical_label,
      kind: "entity",
      weight: Math.max(1, Math.round(entity.source_confidence * 10)),
    });
  }

  const platformSeen = new Set<string>();
  for (const memory of memoryMeta) {
    const platform = (memory.platform || "other").toLowerCase();
    if (!platformSeen.has(platform)) {
      platformSeen.add(platform);
      nodes.push({
        id: `p:${platform}`,
        label: platform,
        kind: "platform",
        weight: 1,
      });
    }

    edges.push({ from: `m:${memory.id}`, to: `p:${platform}`, kind: "platform" });
  }

  for (const mention of mentions) {
    edges.push({
      from: `m:${mention.memory_id}`,
      to: `e:${mention.entity_id}`,
      kind: "mention",
    });
  }

  for (const relation of relations) {
    edges.push({
      from: `e:${relation.source_entity_id}`,
      to: `e:${relation.target_entity_id}`,
      kind: "relation",
      confidenceLabel: relation.confidence_label,
    });
  }

  const topEntityCounts = await graphRepository.listTopEntities(auth, 8);
  const topEntityRows = await graphRepository.listEntitiesByIds(
    auth,
    topEntityCounts.map((row) => row.entity_id)
  );
  const topEntityLabelById = new Map(topEntityRows.map((row) => [row.id, row.canonical_label]));

  const strongestRelations = await graphRepository.listStrongestRelations(auth, 10);
  const strongestEntityIds = [
    ...new Set(strongestRelations.flatMap((row) => [row.source_entity_id, row.target_entity_id])),
  ];
  const strongestEntityRows = await graphRepository.listEntitiesByIds(auth, strongestEntityIds);
  const strongestLabelById = new Map(strongestEntityRows.map((row) => [row.id, row.canonical_label]));

  return {
    nodes,
    edges,
    panels: {
      topEntities: topEntityCounts.map((row) => ({
        label: topEntityLabelById.get(row.entity_id) ?? row.entity_id,
        mentions: row.mentions,
      })),
      strongestRelations: strongestRelations.map((row) => ({
        source: strongestLabelById.get(row.source_entity_id) ?? row.source_entity_id,
        target: strongestLabelById.get(row.target_entity_id) ?? row.target_entity_id,
        relationType: row.relation_type,
        confidence: row.confidence_score,
        confidenceLabel: row.confidence_label,
      })),
      uncertainRelations: await graphRepository.countUncertainRelations(auth),
    },
  };
}
