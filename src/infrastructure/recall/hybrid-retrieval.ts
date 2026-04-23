/**
 * Hybrid retrieval with pinned-preference preloading + type-aware ranking.
 *
 * Signals:
 *   1. Semantic vector search
 *   2. BM25 lexical retrieval
 *   3. Entity/phrase matching
 *
 * Ranking:
 *   - Reciprocal Rank Fusion (RRF)
 *   - Type/age decay
 *   - Reference count boost
 *   - Similarity floor
 *   - Context-level near-duplicate suppression
 */

import type { AuthContext } from "../../domain/auth/index.js";
import { embedText } from "../cache/embedding-cache.js";
import { decryptMemoryContent } from "../crypto/memory-crypto.js";
import { MemoryRepository, type MemoryRecordRow } from "../repositories/memory.repository.js";
import { VectorRepository } from "../repositories/vector.repository.js";
import { config } from "../../config/index.js";
import type { MemoryType } from "../../orchestration/memory/memory-types.js";
import { activitySignal, confidenceTier } from "./scoring-utils.js";

const memoryRepository = new MemoryRepository();
const vectorRepository = new VectorRepository();

export interface HybridRecallResult {
  contextBlock: string;
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
  timingsMs: Record<string, number>;
}

interface HybridRecallOptions {
  types?: MemoryType[];
}

interface BM25Doc {
  id: string;
  tokens: string[];
  tf: Map<string, number>;
}

interface BM25Index {
  docs: BM25Doc[];
  df: Map<string, number>;
  avgdl: number;
  N: number;
  exp: number;
}

interface DecryptedDoc {
  id: string;
  text: string;
  row: MemoryRecordRow;
}

interface RankedCandidate {
  id: string;
  text: string;
  score: number;
  similaritySignal: number;
  row: MemoryRecordRow;
  reason: "vector" | "bm25" | "entity" | "hybrid";
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const BM25_CACHE_TTL_MS = 5 * 60_000;
const EMBED_TIMEOUT_MS = config.memoryRecallEmbedTimeoutMs;
const VECTOR_TIMEOUT_MS = config.memoryRecallVectorTimeoutMs;
const RRF_K = 60;
const SIMILARITY_FLOOR = Math.max(0, Math.min(1, config.recallHybridSimilarityFloor ?? 0.15));
const DEDUP_SIMILARITY_THRESHOLD = 0.9;

const bm25Cache = new Map<string, BM25Index>();

function normalizeTypes(types?: MemoryType[]): MemoryType[] {
  if (!types || types.length === 0) return [];
  return [...new Set(types)].sort() as MemoryType[];
}

function shouldIncludePinnedPreferences(types: MemoryType[]): boolean {
  return types.length === 0 || types.includes("preference");
}

function scopeKey(auth: AuthContext, types: MemoryType[]): string {
  const typeKey = types.length > 0 ? types.join(",") : "all";
  return `${auth.tenantId}:${auth.userId}:${typeKey}`;
}

export function invalidateBm25Cache(auth: AuthContext): void {
  const prefix = `${auth.tenantId}:${auth.userId}:`;
  for (const key of bm25Cache.keys()) {
    if (key.startsWith(prefix)) bm25Cache.delete(key);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Collapse slash-joined abbreviations like "A/L", "A/Ls" → "al", "als"
    // so "A/Ls" and "AL" resolve to the same BM25 token.
    .replace(/([a-z])\/([a-z])/g, "$1$2")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function buildBm25Index(docs: Array<{ id: string; text: string }>): BM25Index {
  const bm25Docs: BM25Doc[] = docs.map(({ id, text }) => {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    return { id, tokens, tf };
  });

  const df = new Map<string, number>();
  for (const doc of bm25Docs) {
    for (const token of doc.tf.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  const totalLen = bm25Docs.reduce((sum, doc) => sum + doc.tokens.length, 0);
  const avgdl = bm25Docs.length > 0 ? totalLen / bm25Docs.length : 1;

  return {
    docs: bm25Docs,
    df,
    avgdl,
    N: bm25Docs.length,
    exp: Date.now() + BM25_CACHE_TTL_MS,
  };
}

function bm25Search(index: BM25Index, query: string, topK: number): Array<{ id: string; score: number }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || index.N === 0) return [];

  const scores = index.docs.map((doc) => {
    let score = 0;
    const dl = doc.tokens.length;

    for (const token of queryTokens) {
      const freq = doc.tf.get(token) ?? 0;
      if (freq === 0) continue;
      const dfVal = index.df.get(token) ?? 0;
      const idf = Math.log((index.N - dfVal + 0.5) / (dfVal + 0.5) + 1);
      const numerator = freq * (BM25_K1 + 1);
      const denominator = freq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / index.avgdl));
      score += idf * (numerator / denominator);
    }

    return { id: doc.id, score };
  });

  return scores
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function extractEntityTokens(query: string): string[] {
  const tokens: string[] = [];
  const words = query.split(/\s+/);

  for (let i = 0; i < words.length; i += 1) {
    const current = words[i];
    if (/^[A-Z]/.test(current) && current.length > 1) {
      tokens.push(current.toLowerCase());
    }
    if (i + 1 < words.length && /^[A-Z]/.test(current) && /^[A-Z]/.test(words[i + 1])) {
      tokens.push(`${current} ${words[i + 1]}`.toLowerCase());
    }
  }

  for (const match of query.matchAll(/"([^"]+)"/g)) {
    tokens.push(match[1].toLowerCase());
  }

  return [...new Set(tokens)];
}

function entityMatchSearch(
  docs: Array<{ id: string; text: string }>,
  query: string,
  topK: number
): Array<{ id: string; score: number }> {
  const entityTokens = extractEntityTokens(query);
  if (entityTokens.length === 0) return [];
  const queryLower = query.toLowerCase();

  return docs
    .map(({ id, text }) => {
      const textLower = text.toLowerCase();
      let score = 0;
      for (const token of entityTokens) {
        if (textLower.includes(token)) score += 1;
      }
      if (score > 0 && textLower.includes(queryLower)) score += 0.5;
      return { id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function rrfFuse(rankedLists: Array<Array<{ id: string }>>, allIds: string[]): Map<string, number> {
  const fused = new Map<string, number>();
  for (const id of allIds) {
    fused.set(id, 0);
  }

  for (const rankedList of rankedLists) {
    rankedList.forEach(({ id }, index) => {
      const rank = index + 1;
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank));
    });
  }

  return fused;
}

function normalizeSignalScores(hits: Array<{ id: string; score: number }>): Map<string, number> {
  if (hits.length === 0) return new Map<string, number>();
  const max = hits.reduce((acc, entry) => Math.max(acc, entry.score), 0);
  const normalized = new Map<string, number>();
  for (const hit of hits) {
    normalized.set(hit.id, max > 0 ? hit.score / max : 0);
  }
  return normalized;
}

function extractRawPreferenceText(text: string): string {
  const rawIdx = text.indexOf("\nRaw:");
  if (rawIdx >= 0) {
    return text.slice(rawIdx + "\nRaw:".length).trim();
  }
  return text.trim();
}

function memoryDecay(memoryTypeRaw: string, createdAtIso: string): number {
  const memoryType = memoryTypeRaw.toLowerCase() as MemoryType;
  if (memoryType === "preference") return 1;

  const ageDays = Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000);
  if (memoryType === "fact") {
    return Math.max(0.5, Math.exp(-ageDays / 365));
  }
  if (memoryType === "lesson") {
    return Math.max(0.65, Math.exp(-ageDays / 540));
  }
  if (memoryType === "decision") {
    return Math.max(0.45, Math.exp(-ageDays / 220));
  }
  if (memoryType === "failure") {
    return Math.max(0.3, Math.exp(-ageDays / 90));
  }
  if (memoryType === "event" || memoryType === "note") {
    return Math.max(0.1, Math.exp(-ageDays / 45));
  }
  return Math.max(0.35, Math.exp(-ageDays / 180));
}

function ageDays(createdAtIso: string): number {
  return Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000);
}

function isEventLikeQuery(query: string): boolean {
  return /\b(event|happened|yesterday|today|tomorrow|last\s+week|last\s+month|when)\b/i.test(query);
}


function topReason(
  vectorNorm: number,
  bm25Norm: number,
  entityNorm: number
): "vector" | "bm25" | "entity" | "hybrid" {
  const max = Math.max(vectorNorm, bm25Norm, entityNorm);
  if (max <= 0) return "hybrid";
  if (max === vectorNorm) return "vector";
  if (max === bm25Norm) return "bm25";
  return "entity";
}

function textSimilarity(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  const union = aTokens.size + bTokens.size - overlap;
  if (union <= 0) return 0;
  return overlap / union;
}

function dedupeContextRows(
  memories: Array<{
    id: string;
    displayText: string;
    score: number;
    metadata: Record<string, unknown>;
  }>
): Array<{
  id: string;
  displayText: string;
  score: number;
  metadata: Record<string, unknown>;
}> {
  const deduped: Array<{
    id: string;
    displayText: string;
    score: number;
    metadata: Record<string, unknown>;
  }> = [];

  for (const memory of memories) {
    const duplicate = deduped.some(
      (existing) => textSimilarity(existing.displayText, memory.displayText) > DEDUP_SIMILARITY_THRESHOLD
    );
    if (!duplicate) deduped.push(memory);
  }
  return deduped;
}

function buildContextBlock(memories: Array<{ text: string; metadata: Record<string, unknown> }>): string {
  if (memories.length === 0) return "--- No relevant memories found ---";
  const lines = memories.map((memory) => {
    const platform = typeof memory.metadata.platform === "string" ? memory.metadata.platform : "unknown";
    const tier = confidenceTier(memory.metadata.reference_count);
    return `[${platform.toUpperCase()}:${tier}] ${memory.text}`;
  });
  return `--- Your Past Context ---\n${lines.join("\n")}\n---`;
}

export async function hybridRecall(
  query: string,
  auth: AuthContext,
  limit: number,
  options: HybridRecallOptions = {}
): Promise<HybridRecallResult> {
  const startedAt = Date.now();
  const timingsMs: Record<string, number> = {};
  const normalizedTypes = normalizeTypes(options.types);
  const candidateK = Math.max(limit * 6, 30);

  const docsStartedAt = Date.now();
  let allRows: MemoryRecordRow[] = [];
  try {
    allRows = await memoryRepository.listAll(auth, {
      types: normalizedTypes.length > 0 ? normalizedTypes : undefined,
      includeSuperseded: false,
    });
  } catch {
    allRows = [];
  }
  timingsMs.docs_ms = Date.now() - docsStartedAt;

  const decryptedDocs: DecryptedDoc[] = allRows.flatMap((row) => {
    try {
      return [{ id: row.id, text: decryptMemoryContent(row.content_ciphertext), row }];
    } catch {
      return [];
    }
  });

  const pinnedPreferenceRows = shouldIncludePinnedPreferences(normalizedTypes)
    ? await memoryRepository.listPinnedPreferences(auth).catch(() => [])
    : [];
  const pinnedPreferenceDocs: DecryptedDoc[] = pinnedPreferenceRows.flatMap((row) => {
    try {
      return [{ id: row.id, text: decryptMemoryContent(row.content_ciphertext), row }];
    } catch {
      return [];
    }
  });

  const pinnedIds = new Set<string>(pinnedPreferenceDocs.map((doc) => doc.id));
  const searchableDocs = decryptedDocs.filter((doc) => !pinnedIds.has(doc.id));
  const docMap = new Map<string, DecryptedDoc>(searchableDocs.map((doc) => [doc.id, doc]));

  const scope = scopeKey(auth, normalizedTypes);
  let bm25Index = bm25Cache.get(scope);
  if (!bm25Index || bm25Index.exp < Date.now()) {
    bm25Index = buildBm25Index(searchableDocs.map((doc) => ({ id: doc.id, text: doc.text })));
    bm25Cache.set(scope, bm25Index);
  }

  const [vectorResult, bm25Result, entityResult] = await Promise.allSettled([
    (async () => {
      const signalStarted = Date.now();
      const queryVector = await withTimeout(embedText(query), EMBED_TIMEOUT_MS, "hybrid.embed");
      const hits = await withTimeout(
        vectorRepository.searchVectors(auth, queryVector, candidateK),
        VECTOR_TIMEOUT_MS,
        "hybrid.vector"
      );
      timingsMs.vector_ms = Date.now() - signalStarted;
      return hits
        .filter((hit) => docMap.has(hit.memoryId))
        .map((hit) => ({ id: hit.memoryId, score: hit.score }));
    })(),
    (async () => {
      const signalStarted = Date.now();
      const hits = bm25Search(bm25Index!, query, candidateK);
      timingsMs.bm25_ms = Date.now() - signalStarted;
      return hits;
    })(),
    (async () => {
      const signalStarted = Date.now();
      const hits = entityMatchSearch(
        searchableDocs.map((doc) => ({ id: doc.id, text: doc.text })),
        query,
        candidateK
      );
      timingsMs.entity_ms = Date.now() - signalStarted;
      return hits;
    })(),
  ]);

  const vectorHits = vectorResult.status === "fulfilled" ? vectorResult.value : [];
  const bm25Hits = bm25Result.status === "fulfilled" ? bm25Result.value : [];
  const entityHits = entityResult.status === "fulfilled" ? entityResult.value : [];
  const vectorNorm = normalizeSignalScores(vectorHits);
  const bm25Norm = normalizeSignalScores(bm25Hits);
  const entityNorm = normalizeSignalScores(entityHits);
  const eventLikeQuery = isEventLikeQuery(query);

  const allCandidateIds = [
    ...new Set([
      ...vectorHits.map((hit) => hit.id),
      ...bm25Hits.map((hit) => hit.id),
      ...entityHits.map((hit) => hit.id),
    ]),
  ];

  const fused = rrfFuse([vectorHits, bm25Hits, entityHits], allCandidateIds);
  const rankedCandidates: RankedCandidate[] = allCandidateIds.flatMap((id) => {
    const doc = docMap.get(id);
    if (!doc) return [];

    const vectorSignal = vectorNorm.get(id) ?? 0;
    const bm25Signal = bm25Norm.get(id) ?? 0;
    const entitySignal = entityNorm.get(id) ?? 0;
    const similaritySignal = Math.max(vectorSignal, bm25Signal, entitySignal);
    if (similaritySignal < SIMILARITY_FLOOR) return [];
    const itemAgeDays = ageDays(doc.row.created_at);
    if (!eventLikeQuery && (doc.row.memory_type === "event" || doc.row.memory_type === "note") && itemAgeDays > 30) {
      return [];
    }

    const rrfScore = fused.get(id) ?? 0;
    const score = Number((
      rrfScore *
      memoryDecay(doc.row.memory_type, doc.row.created_at) *
      activitySignal(doc.row.reference_count ?? 1, doc.row.last_referenced_at ?? null)
    ).toFixed(6));

    return [{
      id,
      text: doc.text,
      score,
      similaritySignal,
      row: doc.row,
      reason: topReason(vectorSignal, bm25Signal, entitySignal),
    }];
  });

  rankedCandidates.sort((a, b) => b.score - a.score || b.similaritySignal - a.similaritySignal);

  const pinnedContextRows = dedupeContextRows(
    pinnedPreferenceDocs.map((doc) => ({
      id: doc.id,
      displayText: extractRawPreferenceText(doc.text),
      score: Number((10 + activitySignal(doc.row.reference_count ?? 1, doc.row.last_referenced_at ?? null)).toFixed(6)),
      metadata: {
        ...((doc.row.summary_json && typeof doc.row.summary_json === "object")
          ? doc.row.summary_json as Record<string, unknown>
          : {}),
        platform: doc.row.platform,
        createdAt: doc.row.created_at,
        memory_type: doc.row.memory_type,
        category: doc.row.category,
        is_pinned: doc.row.is_pinned,
        reference_count: doc.row.reference_count,
        ...(config.nodeEnv === "production" ? {} : { _debug: { why_included: "pinned" } }),
      },
    }))
  );

  const rankedContextRows = dedupeContextRows(
    rankedCandidates.slice(0, limit).map((candidate) => {
      const displayText = candidate.row.memory_type === "preference"
        ? extractRawPreferenceText(candidate.text)
        : candidate.text;

      return {
        id: candidate.id,
        displayText,
        score: candidate.score,
        metadata: {
          ...((candidate.row.summary_json && typeof candidate.row.summary_json === "object")
            ? candidate.row.summary_json as Record<string, unknown>
            : {}),
          platform: candidate.row.platform,
          createdAt: candidate.row.created_at,
          memory_type: candidate.row.memory_type,
          category: candidate.row.category,
          is_pinned: candidate.row.is_pinned,
          reference_count: candidate.row.reference_count,
          similarity_signal: Number(candidate.similaritySignal.toFixed(4)),
          ...(config.nodeEnv === "production" ? {} : { _debug: { why_included: candidate.reason } }),
        },
      };
    })
  );

  const finalRows = dedupeContextRows([...pinnedContextRows, ...rankedContextRows]);
  const finalMemories = finalRows.map((row) => ({
    id: row.id,
    text: row.displayText,
    score: row.score,
    metadata: row.metadata,
  }));

  if (finalMemories.length === 0) {
    const fallback = searchableDocs.slice(0, limit).map((doc, index) => ({
      id: doc.id,
      text: doc.row.memory_type === "preference" ? extractRawPreferenceText(doc.text) : doc.text,
      score: Number((1 - index * 0.05).toFixed(4)),
      metadata: {
        platform: doc.row.platform,
        createdAt: doc.row.created_at,
        memory_type: doc.row.memory_type,
        category: doc.row.category,
        is_pinned: doc.row.is_pinned,
        reference_count: doc.row.reference_count,
      },
    }));
    timingsMs.total_ms = Date.now() - startedAt;
    return {
      contextBlock: buildContextBlock(fallback),
      memories: fallback,
      timingsMs,
    };
  }

  const touchedIds = finalMemories.map((memory) => memory.id);
  void memoryRepository.touchReferencedScoped(auth, touchedIds).catch(() => {});

  timingsMs.total_ms = Date.now() - startedAt;
  return {
    contextBlock: buildContextBlock(finalMemories),
    memories: finalMemories,
    timingsMs,
  };
}
