/**
 * Hybrid retrieval with Reciprocal Rank Fusion (RRF).
 *
 * Three signals run IN PARALLEL then fused:
 *   1. Semantic — vector similarity via Qdrant
 *   2. BM25     — in-process keyword matching over decrypted memory texts
 *   3. Entity   — phrase/entity token matching for proper nouns and compounds
 *
 * RRF formula: score(d) = Σ 1 / (k + rank_i)  where k=60
 *
 * mem0 new algorithm reference: arXiv 2504.19413
 */

import type { AuthContext } from "../types/auth.js";
import { embedText } from "./embeddings.js";
import { decryptMemoryContent } from "./crypto.js";
import { MemoryRepository } from "../repositories/memoryRepository.js";
import { VectorRepository } from "../repositories/vectorRepository.js";
import { config } from "../config.js";

// ─── Repositories ────────────────────────────────────────────────────────────

const memoryRepository = new MemoryRepository();
const vectorRepository = new VectorRepository();

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── BM25 Implementation ─────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const BM25_CACHE_TTL_MS = 5 * 60_000;

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

const bm25Cache = new Map<string, BM25Index>();

export function invalidateBm25Cache(auth: AuthContext): void {
  const prefix = `${auth.tenantId}:${auth.userId}`;
  for (const key of bm25Cache.keys()) {
    if (key.startsWith(prefix)) bm25Cache.delete(key);
  }
}

function tokenizeBm25(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function buildBm25Index(docs: Array<{ id: string; text: string }>): BM25Index {
  const bm25Docs: BM25Doc[] = docs.map(({ id, text }) => {
    const tokens = tokenizeBm25(text);
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

  const totalLen = bm25Docs.reduce((sum, d) => sum + d.tokens.length, 0);
  const avgdl = bm25Docs.length > 0 ? totalLen / bm25Docs.length : 1;

  return { docs: bm25Docs, df, avgdl, N: bm25Docs.length, exp: Date.now() + BM25_CACHE_TTL_MS };
}

function bm25Search(index: BM25Index, query: string, topK: number): Array<{ id: string; score: number }> {
  const queryTokens = tokenizeBm25(query);
  if (queryTokens.length === 0 || index.N === 0) return [];

  const scores: Array<{ id: string; score: number }> = index.docs.map((doc) => {
    let score = 0;
    const dl = doc.tokens.length;
    for (const qt of queryTokens) {
      const freq = doc.tf.get(qt) ?? 0;
      if (freq === 0) continue;
      const dfVal = index.df.get(qt) ?? 0;
      const idf = Math.log((index.N - dfVal + 0.5) / (dfVal + 0.5) + 1);
      const numerator = freq * (BM25_K1 + 1);
      const denominator = freq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / index.avgdl));
      score += idf * (numerator / denominator);
    }
    return { id: doc.id, score };
  });

  return scores
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── Entity / Phrase Matching ─────────────────────────────────────────────────

function extractEntityTokens(query: string): string[] {
  const tokens: string[] = [];

  // Capitalized words and known compound patterns
  const words = query.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^[A-Z]/.test(w) && w.length > 1) {
      tokens.push(w.toLowerCase());
    }
    // Bigrams of capitalized words (e.g. "San Francisco", "TypeScript React")
    if (i + 1 < words.length) {
      const bigram = `${w} ${words[i + 1]}`;
      if (/^[A-Z]/.test(w) && /^[A-Z]/.test(words[i + 1])) {
        tokens.push(bigram.toLowerCase());
      }
    }
  }

  // Quoted phrases
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
      // Bonus: full query phrase appears in text
      if (score > 0 && textLower.includes(queryLower)) score += 0.5;
      return { id, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── Reciprocal Rank Fusion ──────────────────────────────────────────────────

const RRF_K = 60;

function rrfFuse(
  rankedLists: Array<Array<{ id: string }>>,
  allIds: string[],
  topK: number
): Array<{ id: string; score: number }> {
  const fusedScores = new Map<string, number>();
  for (const id of allIds) {
    fusedScores.set(id, 0);
  }
  for (const rankedList of rankedLists) {
    rankedList.forEach(({ id }, idx) => {
      const rank = idx + 1;
      fusedScores.set(id, (fusedScores.get(id) ?? 0) + 1 / (RRF_K + rank));
    });
  }
  return [...fusedScores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ id, score }));
}

// ─── Main Export ─────────────────────────────────────────────────────────────

const EMBED_TIMEOUT_MS = config.memoryRecallEmbedTimeoutMs;
const VECTOR_TIMEOUT_MS = config.memoryRecallVectorTimeoutMs;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export async function hybridRecall(
  query: string,
  auth: AuthContext,
  limit: number
): Promise<HybridRecallResult> {
  const start = Date.now();
  const timingsMs: Record<string, number> = {};
  const candidateK = Math.max(limit * 4, 20);

  // ── Fetch all docs for BM25 / entity signals (shared) ──────────────────────
  const docsStart = Date.now();
  let allRows: Awaited<ReturnType<typeof memoryRepository.listAll>> = [];
  try {
    allRows = await memoryRepository.listAll(auth);
  } catch {
    // Proceed with empty list; vector-only fallback
  }
  timingsMs.docs_ms = Date.now() - docsStart;

  const decryptedDocs = allRows.flatMap((row) => {
    try {
      return [{ id: row.id, text: decryptMemoryContent(row.content_ciphertext), row }];
    } catch {
      return [];
    }
  });

  // ── Build / read BM25 index cache ─────────────────────────────────────────
  const scopeKey = `${auth.tenantId}:${auth.userId}`;
  let bm25Index = bm25Cache.get(scopeKey);
  if (!bm25Index || bm25Index.exp < Date.now()) {
    bm25Index = buildBm25Index(decryptedDocs.map(({ id, text }) => ({ id, text })));
    bm25Cache.set(scopeKey, bm25Index);
  }

  // ── Run all three signals IN PARALLEL ─────────────────────────────────────
  const [vectorResult, bm25Result, entityResult] = await Promise.allSettled([
    // 1. Semantic (vector)
    (async () => {
      const t = Date.now();
      const qv = await withTimeout(embedText(query), EMBED_TIMEOUT_MS, "hybrid.embed");
      const hits = await withTimeout(
        vectorRepository.searchVectors(auth, qv, candidateK),
        VECTOR_TIMEOUT_MS,
        "hybrid.vector"
      );
      timingsMs.vector_ms = Date.now() - t;
      return hits.map((h) => ({ id: h.memoryId, score: h.score }));
    })(),

    // 2. BM25
    (async () => {
      const t = Date.now();
      const hits = bm25Search(bm25Index!, query, candidateK);
      timingsMs.bm25_ms = Date.now() - t;
      return hits;
    })(),

    // 3. Entity phrase matching
    (async () => {
      const t = Date.now();
      const hits = entityMatchSearch(decryptedDocs.map(({ id, text }) => ({ id, text })), query, candidateK);
      timingsMs.entity_ms = Date.now() - t;
      return hits;
    })(),
  ]);

  const vectorHits = vectorResult.status === "fulfilled" ? vectorResult.value : [];
  const bm25Hits = bm25Result.status === "fulfilled" ? bm25Result.value : [];
  const entityHits = entityResult.status === "fulfilled" ? entityResult.value : [];

  // Collect all candidate IDs
  const allIds = [
    ...new Set([
      ...vectorHits.map((h) => h.id),
      ...bm25Hits.map((h) => h.id),
      ...entityHits.map((h) => h.id),
    ]),
  ];

  if (allIds.length === 0) {
    // Nothing found — return recent fallback
    const recentDocs = decryptedDocs.slice(0, limit);
    return {
      contextBlock: recentDocs.length > 0
        ? `--- Your Past Context ---\n${recentDocs.map((d) => d.text).join("\n")}\n---`
        : "--- No relevant memories found ---",
      memories: recentDocs.map((d, i) => ({
        id: d.id,
        text: d.text,
        score: 1 - i * 0.05,
        metadata: {
          platform: d.row.platform,
          createdAt: d.row.created_at,
          retrieval: "recent_fallback",
        },
      })),
      timingsMs: { ...timingsMs, total_ms: Date.now() - start },
    };
  }

  // ── RRF fusion ─────────────────────────────────────────────────────────────
  const fused = rrfFuse([vectorHits, bm25Hits, entityHits], allIds, limit);

  // ── Build response ─────────────────────────────────────────────────────────
  const docMap = new Map(decryptedDocs.map((d) => [d.id, d]));
  const rowMap = new Map(allRows.map((r) => [r.id, r]));

  const memories = fused.flatMap(({ id, score }) => {
    const doc = docMap.get(id);
    const row = rowMap.get(id);
    if (!doc || !row) return [];
    const summaryMeta = (row.summary_json && typeof row.summary_json === "object"
      ? (row.summary_json as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    return [{
      id,
      text: doc.text,
      score,
      metadata: {
        ...summaryMeta,
        platform: row.platform,
        createdAt: row.created_at,
      },
    }];
  });

  const lines = memories.map((m) => {
    const p = typeof m.metadata.platform === "string" ? m.metadata.platform : "unknown";
    return `[${p.toUpperCase()}] ${m.text}`;
  });

  timingsMs.total_ms = Date.now() - start;

  return {
    contextBlock: lines.length > 0
      ? `--- Your Past Context ---\n${lines.join("\n")}\n---`
      : "--- No relevant memories found ---",
    memories,
    timingsMs,
  };
}
