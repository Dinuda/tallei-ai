import { decryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { getCacheJson, setCacheJson } from "../../infrastructure/cache/redis-cache.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { config } from "../../config/index.js";
import { MemoryRepository } from "../../infrastructure/repositories/memory.repository.js";
import { MemoryGraphRepository } from "../../infrastructure/repositories/memory-graph.repository.js";
import { MemoryGraphJobRepository } from "../../infrastructure/repositories/memory-graph-job.repository.js";
import { readRecallStamp } from "../../infrastructure/recall/fast-recall.js";

interface SnapshotMemoryMeta {
  id: string;
  created_at: string;
  platform: string;
  summary_text: string;
}

interface SnapshotEntityMemory {
  memory_id: string;
  weight: number;
}

interface SnapshotRelationNeighbor {
  label: string;
  confidence: number;
}

export interface PrecomputedGraphSnapshot {
  version: number;
  updated_at: string;
  source_window: {
    max_memories: number;
    memory_count: number;
    mention_count: number;
    relation_count: number;
  };
  entities: Record<string, SnapshotEntityMemory[]>;
  relations: Record<string, SnapshotRelationNeighbor[]>;
  memory_meta: Record<string, SnapshotMemoryMeta>;
}

export interface PrecomputedRecallV1Result {
  contextBlock: string;
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
}

export interface PrecomputedRecallV2Result {
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

type SnapshotStatus = "hit" | "miss" | "stale" | "error" | "disabled";

export interface PrecomputedLookup<T> {
  status: SnapshotStatus;
  result: T | null;
  snapshot_lookup_ms: number;
  snapshot_age_ms: number;
}

const memoryRepository = new MemoryRepository();
const graphRepository = new MemoryGraphRepository();
const graphJobRepository = new MemoryGraphJobRepository();

const SNAPSHOT_MAX_MEMORIES = 1_000;
const SNAPSHOT_TTL_SECONDS = 900;
const SNAPSHOT_STALE_TTL_SECONDS = 180;
const SNAPSHOT_MAX_AGE_MS = 180_000;
const SNAPSHOT_ENTITY_MEMORY_LIMIT = 48;
const SNAPSHOT_RELATION_LIMIT = 24;

const LOOKUP_FAILURE_WINDOW_MS = 60_000;
const LOOKUP_FAILURE_THRESHOLD = 5;
const LOOKUP_CIRCUIT_COOLDOWN_MS = 120_000;

const localSnapshotCache = new Map<string, { exp: number; snapshot: PrecomputedGraphSnapshot }>();
const localStaleByScope = new Map<string, number>();
let lookupFailureTimestamps: number[] = [];
let lookupCircuitDisabledUntil = 0;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function scopeKey(auth: AuthContext): string {
  return `${auth.tenantId}:${auth.userId}`;
}

function snapshotCacheKey(auth: AuthContext, version: number): string {
  return `recall:snapshot:${auth.tenantId}:${auth.userId}:${version}`;
}

function snapshotStaleKey(auth: AuthContext): string {
  return `recall:snapshot:stale:${auth.tenantId}:${auth.userId}`;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function recencyScore(createdAtIso: string): number {
  const days = Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000);
  return Math.max(0, 1 - days / 30);
}

function buildContextBlock(memories: PrecomputedRecallV1Result["memories"]): string {
  if (memories.length === 0) return "--- No relevant memories found ---";
  const lines = memories.map((memory) => {
    const platformValue = memory.metadata.platform;
    const platform = typeof platformValue === "string" && platformValue.length > 0 ? platformValue : "unknown";
    return `[${platform.toUpperCase()}] ${memory.text}`;
  });
  return `--- Your Past Context ---\n${lines.join("\n")}\n---`;
}

function noteLookupFailure(): void {
  const now = Date.now();
  lookupFailureTimestamps = lookupFailureTimestamps.filter((value) => now - value <= LOOKUP_FAILURE_WINDOW_MS);
  lookupFailureTimestamps.push(now);
  if (lookupFailureTimestamps.length >= LOOKUP_FAILURE_THRESHOLD) {
    lookupCircuitDisabledUntil = now + LOOKUP_CIRCUIT_COOLDOWN_MS;
    lookupFailureTimestamps = [];
  }
}

function noteLookupSuccess(): void {
  const now = Date.now();
  lookupFailureTimestamps = lookupFailureTimestamps.filter((value) => now - value <= LOOKUP_FAILURE_WINDOW_MS);
}

async function getSnapshot(auth: AuthContext): Promise<{
  status: SnapshotStatus;
  snapshot: PrecomputedGraphSnapshot | null;
  lookupMs: number;
  ageMs: number;
}> {
  const startedAt = Date.now();
  if (Date.now() < lookupCircuitDisabledUntil) {
    return {
      status: "disabled",
      snapshot: null,
      lookupMs: Date.now() - startedAt,
      ageMs: 0,
    };
  }

  try {
    const version = await readRecallStamp(auth);
    const key = snapshotCacheKey(auth, version);
    const local = localSnapshotCache.get(key);
    let snapshot = local?.exp && local.exp > Date.now() ? local.snapshot : null;
    if (!snapshot) {
      snapshot = await getCacheJson<PrecomputedGraphSnapshot>(key);
      if (snapshot) {
        localSnapshotCache.set(key, {
          exp: Date.now() + SNAPSHOT_TTL_SECONDS * 1000,
          snapshot,
        });
      }
    }

    if (!snapshot) {
      noteLookupSuccess();
      return {
        status: "miss",
        snapshot: null,
        lookupMs: Date.now() - startedAt,
        ageMs: 0,
      };
    }

    const ageMs = Date.now() - new Date(snapshot.updated_at).getTime();
    const staleLocalUntil = localStaleByScope.get(scopeKey(auth)) ?? 0;
    const staleRemote = await getCacheJson<boolean>(snapshotStaleKey(auth));
    const isStale = staleLocalUntil > Date.now() || staleRemote === true || ageMs > SNAPSHOT_MAX_AGE_MS;
    noteLookupSuccess();
    return {
      status: isStale ? "stale" : "hit",
      snapshot,
      lookupMs: Date.now() - startedAt,
      ageMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0,
    };
  } catch {
    noteLookupFailure();
    return {
      status: "error",
      snapshot: null,
      lookupMs: Date.now() - startedAt,
      ageMs: 0,
    };
  }
}

export async function markSnapshotStale(auth: AuthContext): Promise<void> {
  localStaleByScope.set(scopeKey(auth), Date.now() + SNAPSHOT_STALE_TTL_SECONDS * 1000);
  await setCacheJson(snapshotStaleKey(auth), true, SNAPSHOT_STALE_TTL_SECONDS);
}

async function clearSnapshotStale(auth: AuthContext): Promise<void> {
  localStaleByScope.delete(scopeKey(auth));
  await setCacheJson(snapshotStaleKey(auth), false, SNAPSHOT_STALE_TTL_SECONDS);
}

export async function queueSnapshotRefresh(
  auth: AuthContext,
  reason: string,
  debounceMs = 1_000
): Promise<void> {
  if (!config.graphExtractionEnabled) return;
  await graphJobRepository.enqueueSnapshotRefreshJob(auth, { reason }, debounceMs);
}

function summarizeJson(summaryJson: unknown): string {
  if (!summaryJson || typeof summaryJson !== "object") return "";
  const value = summaryJson as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title : "";
  const summary = typeof value.summary === "string" ? value.summary : "";
  const points = Array.isArray(value.keyPoints)
    ? value.keyPoints.filter((item): item is string => typeof item === "string").join("; ")
    : "";
  return [title, summary, points].filter(Boolean).join(" | ");
}

export async function buildUserSnapshot(
  auth: AuthContext,
  maxMemories = SNAPSHOT_MAX_MEMORIES
): Promise<{ snapshot: PrecomputedGraphSnapshot; snapshot_build_ms: number }> {
  const startedAt = Date.now();
  const rows = await memoryRepository.list(auth, maxMemories);
  const memoryById = new Map(rows.map((row) => [row.id, row]));
  const memoryMeta: Record<string, SnapshotMemoryMeta> = {};
  for (const row of rows) {
    memoryMeta[row.id] = {
      id: row.id,
      created_at: row.created_at,
      platform: row.platform,
      summary_text: summarizeJson(row.summary_json),
    };
  }

  const memoryIds = rows.map((row) => row.id);
  const mentions = await graphRepository.listMentionsForMemoryIds(auth, memoryIds);
  const entityIds = [...new Set(mentions.map((mention) => mention.entity_id))];
  const entities = await graphRepository.listEntitiesByIds(auth, entityIds);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));

  const entityMemoryScores = new Map<string, Map<string, number>>();
  for (const mention of mentions) {
    const entity = entityById.get(mention.entity_id);
    if (!entity) continue;
    if (!memoryById.has(mention.memory_id)) continue;
    const label = entity.normalized_label;
    const byMemory = entityMemoryScores.get(label) ?? new Map<string, number>();
    const score = clamp((entity.source_confidence || 0.6) * (mention.confidence || 0.6));
    const previous = byMemory.get(mention.memory_id) ?? 0;
    byMemory.set(mention.memory_id, Math.max(previous, score));
    entityMemoryScores.set(label, byMemory);
  }

  const entitiesSnapshot: Record<string, SnapshotEntityMemory[]> = {};
  for (const [label, byMemory] of entityMemoryScores.entries()) {
    const ranked = [...byMemory.entries()]
      .map(([memoryId, weight]) => ({
        memory_id: memoryId,
        weight: Number(weight.toFixed(4)),
      }))
      .sort((a, b) => {
        const aCreated = memoryMeta[a.memory_id]?.created_at ?? "";
        const bCreated = memoryMeta[b.memory_id]?.created_at ?? "";
        if (b.weight !== a.weight) return b.weight - a.weight;
        return bCreated.localeCompare(aCreated);
      })
      .slice(0, SNAPSHOT_ENTITY_MEMORY_LIMIT);
    if (ranked.length > 0) {
      entitiesSnapshot[label] = ranked;
    }
  }

  const relationsSnapshot: Record<string, SnapshotRelationNeighbor[]> = {};
  if (entityIds.length > 0) {
    const relations = await graphRepository.listRelationsForEntityIds(auth, entityIds, 2_000);
    for (const relation of relations) {
      const source = entityById.get(relation.source_entity_id)?.normalized_label;
      const target = entityById.get(relation.target_entity_id)?.normalized_label;
      if (!source || !target || source === target) continue;
      const confidence = Number(clamp(relation.confidence_score || 0.6).toFixed(4));

      const sourceNeighbors = relationsSnapshot[source] ?? [];
      sourceNeighbors.push({ label: target, confidence });
      relationsSnapshot[source] = sourceNeighbors;

      const targetNeighbors = relationsSnapshot[target] ?? [];
      targetNeighbors.push({ label: source, confidence });
      relationsSnapshot[target] = targetNeighbors;
    }
  }

  for (const [label, neighbors] of Object.entries(relationsSnapshot)) {
    const deduped = new Map<string, number>();
    for (const neighbor of neighbors) {
      const previous = deduped.get(neighbor.label) ?? 0;
      deduped.set(neighbor.label, Math.max(previous, neighbor.confidence));
    }
    relationsSnapshot[label] = [...deduped.entries()]
      .map(([neighborLabel, confidence]) => ({ label: neighborLabel, confidence }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, SNAPSHOT_RELATION_LIMIT);
  }

  const version = await readRecallStamp(auth);
  const snapshot: PrecomputedGraphSnapshot = {
    version,
    updated_at: new Date().toISOString(),
    source_window: {
      max_memories: maxMemories,
      memory_count: rows.length,
      mention_count: mentions.length,
      relation_count: Object.values(relationsSnapshot).reduce((acc, current) => acc + current.length, 0),
    },
    entities: entitiesSnapshot,
    relations: relationsSnapshot,
    memory_meta: memoryMeta,
  };

  const key = snapshotCacheKey(auth, version);
  localSnapshotCache.set(key, {
    exp: Date.now() + SNAPSHOT_TTL_SECONDS * 1000,
    snapshot,
  });
  await setCacheJson(key, snapshot, SNAPSHOT_TTL_SECONDS);
  await clearSnapshotStale(auth);

  return {
    snapshot,
    snapshot_build_ms: Date.now() - startedAt,
  };
}

interface RankedMemory {
  id: string;
  score: number;
  reasons: string[];
  paths: string[];
}

function rankFromSnapshot(
  snapshot: PrecomputedGraphSnapshot,
  query: string,
  limit: number,
  includeRelationExpansion: boolean
): RankedMemory[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];

  const labels = Object.keys(snapshot.entities);
  const matchedLabels = labels.filter((label) =>
    queryTokens.some((token) => label === token || label.includes(token) || token.includes(label))
  );
  if (matchedLabels.length === 0) return [];

  const scoreByMemory = new Map<string, number>();
  const reasonsByMemory = new Map<string, Set<string>>();
  const pathsByMemory = new Map<string, Set<string>>();

  const applyLabel = (label: string, boost: number, reasonPrefix: string, pathPrefix: string): void => {
    const entries = snapshot.entities[label] ?? [];
    for (const entry of entries) {
      const prev = scoreByMemory.get(entry.memory_id) ?? 0;
      scoreByMemory.set(entry.memory_id, prev + boost * entry.weight);
      const reasons = reasonsByMemory.get(entry.memory_id) ?? new Set<string>();
      reasons.add(`${reasonPrefix}: ${label}`);
      reasonsByMemory.set(entry.memory_id, reasons);

      const paths = pathsByMemory.get(entry.memory_id) ?? new Set<string>();
      paths.add(`${pathPrefix}${label} -> memory`);
      pathsByMemory.set(entry.memory_id, paths);
    }
  };

  for (const label of matchedLabels) {
    applyLabel(label, 1.0, "Direct entity match", "");
  }

  if (includeRelationExpansion) {
    for (const label of matchedLabels) {
      const neighbors = snapshot.relations[label] ?? [];
      for (const neighbor of neighbors.slice(0, 8)) {
        applyLabel(
          neighbor.label,
          0.45 * neighbor.confidence,
          "Related entity match",
          "query entities -> "
        );
      }
    }
  }

  const ranked = [...scoreByMemory.entries()]
    .map(([memoryId, baseScore]) => {
      const meta = snapshot.memory_meta[memoryId];
      if (!meta) return null;

      const summaryTokens = new Set(tokenize(meta.summary_text));
      let overlap = 0;
      for (const token of queryTokens) {
        if (summaryTokens.has(token)) overlap += 1;
      }
      const lexical = queryTokens.length > 0 ? overlap / queryTokens.length : 0;
      const score = Number(
        (baseScore * 0.65 + recencyScore(meta.created_at) * 0.2 + lexical * 0.15).toFixed(5)
      );
      return {
        id: memoryId,
        score,
        reasons: [...(reasonsByMemory.get(memoryId) ?? new Set(["Precomputed graph match"]))],
        paths: [...(pathsByMemory.get(memoryId) ?? new Set(["snapshot -> memory"]))],
      };
    })
    .filter((item): item is RankedMemory => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

async function materializeRankedMemories(
  auth: AuthContext,
  ranked: RankedMemory[]
): Promise<Array<{ id: string; text: string; score: number; metadata: Record<string, unknown>; reasons: string[]; paths: string[] }>> {
  if (ranked.length === 0) return [];
  const rows = await memoryRepository.getByIds(auth, ranked.map((item) => item.id));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const result: Array<{ id: string; text: string; score: number; metadata: Record<string, unknown>; reasons: string[]; paths: string[] }> = [];
  for (const item of ranked) {
    const row = rowById.get(item.id);
    if (!row) continue;
    let text = "";
    try {
      text = decryptMemoryContent(row.content_ciphertext);
    } catch {
      text = "[Encrypted memory unavailable]";
    }

    const summaryMetadata = row.summary_json && typeof row.summary_json === "object"
      ? (row.summary_json as Record<string, unknown>)
      : {};

    result.push({
      id: row.id,
      text,
      score: item.score,
      metadata: {
        ...summaryMetadata,
        platform: row.platform,
        createdAt: row.created_at,
        source: "precomputed_graph",
      },
      reasons: item.reasons.slice(0, 4),
      paths: item.paths.slice(0, 3),
    });
  }
  return result;
}

export async function lookupPrecomputedRecallV1(
  auth: AuthContext,
  query: string,
  limit: number
): Promise<PrecomputedLookup<PrecomputedRecallV1Result>> {
  const snapshotState = await getSnapshot(auth);
  if (!snapshotState.snapshot || snapshotState.status !== "hit") {
    if (snapshotState.status === "miss" || snapshotState.status === "stale" || snapshotState.status === "error") {
      void queueSnapshotRefresh(auth, `lookup_${snapshotState.status}`, 750).catch(() => {});
    }
    return {
      status: snapshotState.status,
      result: null,
      snapshot_lookup_ms: snapshotState.lookupMs,
      snapshot_age_ms: snapshotState.ageMs,
    };
  }

  const ranked = rankFromSnapshot(snapshotState.snapshot, query, limit, false);
  if (ranked.length === 0) {
    void queueSnapshotRefresh(auth, "lookup_no_candidates", 750).catch(() => {});
    return {
      status: "miss",
      result: null,
      snapshot_lookup_ms: snapshotState.lookupMs,
      snapshot_age_ms: snapshotState.ageMs,
    };
  }
  const memories = await materializeRankedMemories(auth, ranked);
  if (memories.length === 0) {
    return {
      status: "miss",
      result: null,
      snapshot_lookup_ms: snapshotState.lookupMs,
      snapshot_age_ms: snapshotState.ageMs,
    };
  }
  return {
    status: "hit",
    result: {
      contextBlock: buildContextBlock(memories),
      memories: memories.map((memory) => ({
        id: memory.id,
        text: memory.text,
        score: memory.score,
        metadata: memory.metadata,
      })),
    },
    snapshot_lookup_ms: snapshotState.lookupMs,
    snapshot_age_ms: snapshotState.ageMs,
  };
}

export async function lookupPrecomputedRecallV2(
  auth: AuthContext,
  query: string,
  limit: number
): Promise<PrecomputedLookup<PrecomputedRecallV2Result>> {
  const snapshotState = await getSnapshot(auth);
  if (!snapshotState.snapshot || snapshotState.status !== "hit") {
    if (snapshotState.status === "miss" || snapshotState.status === "stale" || snapshotState.status === "error") {
      void queueSnapshotRefresh(auth, `lookup_v2_${snapshotState.status}`, 750).catch(() => {});
    }
    return {
      status: snapshotState.status,
      result: null,
      snapshot_lookup_ms: snapshotState.lookupMs,
      snapshot_age_ms: snapshotState.ageMs,
    };
  }

  const ranked = rankFromSnapshot(snapshotState.snapshot, query, limit, true);
  if (ranked.length === 0) {
    void queueSnapshotRefresh(auth, "lookup_v2_no_candidates", 750).catch(() => {});
    return {
      status: "miss",
      result: null,
      snapshot_lookup_ms: snapshotState.lookupMs,
      snapshot_age_ms: snapshotState.ageMs,
    };
  }
  const memories = await materializeRankedMemories(auth, ranked);
  if (memories.length === 0) {
    return {
      status: "miss",
      result: null,
      snapshot_lookup_ms: snapshotState.lookupMs,
      snapshot_age_ms: snapshotState.ageMs,
    };
  }

  const compactMemories = memories.map((memory) => ({
    id: memory.id,
    text: memory.text,
    score: memory.score,
    metadata: memory.metadata,
  }));

  return {
    status: "hit",
    result: {
      contextBlock: buildContextBlock(compactMemories),
      memories: compactMemories,
      explanations: memories.map((memory) => ({
        memory_id: memory.id,
        reasons: memory.reasons,
        top_paths: memory.paths,
        confidence_summary: {
          explicit: 0,
          inferred: 0,
          uncertain: 0,
        },
      })),
      retrieval_mode: "graph_augmented",
      timings_ms: {
        snapshot_lookup_ms: snapshotState.lookupMs,
        snapshot_age_ms: snapshotState.ageMs,
        total: snapshotState.lookupMs,
      },
      debug_flags: {
        source: "precomputed_graph",
      },
    },
    snapshot_lookup_ms: snapshotState.lookupMs,
    snapshot_age_ms: snapshotState.ageMs,
  };
}
