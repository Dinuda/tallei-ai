/**
 * Three-bucket recall — replaces the background-enrichment + lexical-fallback
 * architecture with a single synchronous pass that always returns semantically
 * correct results.
 *
 * Buckets (fixed token budgets out of TOTAL_BUDGET = 8 000 tokens):
 *   preference  (1 500 tok) — injected unconditionally, sorted by pinned > refcount
 *   long-term   (4 800 tok) — facts + decisions; dump-all when ≤ budget, else recall-first hybrid
 *   short-term  (1 700 tok) — events + notes; recency-first, max 60 days old
 *
 * Overflow strategy (long-term bucket only):
 *   Union of vector top-25 + BM25 top-15 + temporal top-5, no similarity floor,
 *   packed under token budget.  The host LLM is the final reranker.
 */

import type { AuthContext } from "../../domain/auth/index.js";
import { decryptMemoryContent } from "../crypto/memory-crypto.js";
import { embedText } from "../cache/embedding-cache.js";
import { MemoryRepository, type MemoryRecordRow } from "../repositories/memory.repository.js";
import { VectorRepository } from "../repositories/vector.repository.js";
import { activitySignal, confidenceTier, detectConflicts, type ConflictHint } from "./scoring-utils.js";

const memoryRepository = new MemoryRepository();
const vectorRepository = new VectorRepository();

// ── Budget constants ──────────────────────────────────────────────────────────

const PREF_BUDGET = 1_500;
const LONGTERM_BUDGET = 4_800;
const SHORTTERM_BUDGET = 1_700;
const SHORT_TERM_MAX_AGE_DAYS = 60;

// ── BM25 tuning ───────────────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;

// ── Static query expansion ────────────────────────────────────────────────────
// Expands common abbreviations before embedding and BM25 search.
// No LLM call — pure lookup, zero latency.

const QUERY_EXPANSIONS: Readonly<Record<string, string>> = {
  "a/l":  "al advanced level exam results academic",
  "al":   "a/l advanced level exam results academic",
  "o/l":  "ol ordinary level exam results",
  "ol":   "o/l ordinary level exam results",
  "ict":  "information communication technology",
  "uni":  "university college degree",
  "dev":  "developer development software",
  "ai":   "artificial intelligence",
  "ml":   "machine learning",
  "cs":   "computer science",
  "gpa":  "grade point average academic",
  "cv":   "curriculum vitae resume",
};

// ── Public types ──────────────────────────────────────────────────────────────

export interface BucketMemory {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface BucketRecallResult {
  contextBlock: string;
  memories: BucketMemory[];
  timingsMs: Record<string, number>;
  conflictHints?: ConflictHint[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function expandQuery(query: string): string {
  const lower = query.toLowerCase();
  const extra: string[] = [];
  for (const [abbr, expansion] of Object.entries(QUERY_EXPANSIONS)) {
    // Match whole-word abbreviation in the query
    if (new RegExp(`(?:^|\\s)${abbr.replace("/", "\\/")}(?:\\s|$)`).test(lower)) {
      extra.push(expansion);
    }
  }
  return extra.length > 0 ? `${query} ${extra.join(" ")}` : query;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])\/([a-z])/g, "$1$2") // A/L → al, A/Ls → als
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function decryptSafe(row: MemoryRecordRow): string | null {
  try {
    return decryptMemoryContent(row.content_ciphertext);
  } catch {
    return null;
  }
}

function toMeta(row: MemoryRecordRow): Record<string, unknown> {
  const summary =
    row.summary_json && typeof row.summary_json === "object"
      ? (row.summary_json as Record<string, unknown>)
      : {};
  return {
    ...summary,
    platform: row.platform,
    createdAt: row.created_at,
    memory_type: row.memory_type,
    category: row.category,
    is_pinned: row.is_pinned,
    reference_count: row.reference_count,
  };
}

function packUnderBudget(
  items: Array<{ row: MemoryRecordRow; text: string; score: number }>,
  budget: number
): BucketMemory[] {
  const out: BucketMemory[] = [];
  let used = 0;
  for (const { row, text, score } of items) {
    const tok = estimateTokens(text);
    if (used + tok > budget) continue; // skip oversized; don't hard-stop
    out.push({ id: row.id, text, score, metadata: toMeta(row) });
    used += tok;
  }
  return out;
}

function buildContextBlock(memories: BucketMemory[]): string {
  if (memories.length === 0) return "--- No relevant memories found ---";
  const lines = memories.map((m) => {
    const platform =
      typeof m.metadata.platform === "string" ? m.metadata.platform : "unknown";
    const tier = confidenceTier(m.metadata.reference_count);
    return `[${platform.toUpperCase()}:${tier}] ${m.text}`;
  });
  return `--- Your Past Context ---\n${lines.join("\n")}\n---`;
}

// ── BM25 ─────────────────────────────────────────────────────────────────────

function bm25Scores(
  query: string,
  docs: Array<{ id: string; text: string }>
): Map<string, number> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || docs.length === 0) return new Map();

  const tokenized = docs.map((d) => {
    const tokens = tokenize(d.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: d.id, tokens, tf };
  });

  const N = tokenized.length;
  const avgdl = tokenized.reduce((s, d) => s + d.tokens.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const d of tokenized) {
    for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const scores = new Map<string, number>();
  for (const d of tokenized) {
    const dl = d.tokens.length;
    let score = 0;
    for (const qt of queryTokens) {
      const freq = d.tf.get(qt) ?? 0;
      if (freq === 0) continue;
      const dfVal = df.get(qt) ?? 0;
      const idf = Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1);
      const num = freq * (BM25_K1 + 1);
      const den = freq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
      score += idf * (num / den);
    }
    if (score > 0) scores.set(d.id, score);
  }
  return scores;
}

// ── Overflow: recall-first hybrid ────────────────────────────────────────────
// Used only when the long-term bucket exceeds its token budget.
// Union of signals, no similarity floor — maximize recall.
// Host LLM does final relevance selection.

async function recallFirstHybrid(
  query: string,
  auth: AuthContext,
  rows: Array<{ row: MemoryRecordRow; text: string }>,
  budget: number
): Promise<BucketMemory[]> {
  const expandedQuery = expandQuery(query);
  const docMap = new Map(rows.map((r) => [r.row.id, r]));
  const docs = rows.map((r) => ({ id: r.row.id, text: r.text }));

  // Signal 1: vector search (top 25, no score floor)
  let vectorIds: string[] = [];
  try {
    const vec = await embedText(expandedQuery);
    const hits = await vectorRepository.searchVectors(auth, vec, 25);
    vectorIds = hits.filter((h) => docMap.has(h.memoryId)).map((h) => h.memoryId);
  } catch {
    // Vector unavailable — BM25 + temporal cover
  }

  // Signal 2: BM25 (top 15)
  const bm25 = bm25Scores(expandedQuery, docs);
  const bm25Ids = [...bm25.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([id]) => id);

  // Signal 3: temporal baseline (5 most recent — safety net for poor embeddings)
  const temporalIds = [...rows]
    .sort((a, b) => new Date(b.row.created_at).getTime() - new Date(a.row.created_at).getTime())
    .slice(0, 5)
    .map((r) => r.row.id);

  // Union — dedupe, preserve order: vector first (highest signal quality)
  const seen = new Set<string>();
  const candidateIds: string[] = [];
  for (const id of [...vectorIds, ...bm25Ids, ...temporalIds]) {
    if (!seen.has(id) && docMap.has(id)) {
      seen.add(id);
      candidateIds.push(id);
    }
  }

  // Score: vector rank (RRF-style) + BM25 normalised + reference boost
  const maxBm25 = Math.max(0, ...[...bm25.values()]);
  const vectorRank = new Map(vectorIds.map((id, i) => [id, i]));

  const scored = candidateIds
    .map((id) => {
      const item = docMap.get(id)!;
      const vRank = vectorRank.get(id);
      const vScore = vRank !== undefined ? 1 / (60 + vRank + 1) : 0;
      const bScore = maxBm25 > 0 ? (bm25.get(id) ?? 0) / maxBm25 : 0;
      const activity = activitySignal(item.row.reference_count ?? 1, item.row.last_referenced_at ?? null);
      return { ...item, score: (vScore * 0.7 + bScore * 0.3) * activity };
    })
    .sort((a, b) => b.score - a.score);

  return packUnderBudget(scored, budget);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function bucketRecall(
  query: string,
  auth: AuthContext
): Promise<BucketRecallResult> {
  const t0 = Date.now();
  const timingsMs: Record<string, number> = {};

  // Single DB fetch — all non-deleted, non-superseded memories
  const allRows = await memoryRepository.listAll(auth, { includeSuperseded: false });
  timingsMs.db_ms = Date.now() - t0;

  // Decrypt once
  const decrypted = allRows.flatMap((row) => {
    const text = decryptSafe(row);
    return text !== null ? [{ row, text }] : [];
  });

  // Split into buckets
  const prefRows = decrypted.filter((d) => d.row.memory_type === "preference");
  const longtermRows = decrypted.filter(
    (d) =>
      d.row.memory_type === "fact" ||
      d.row.memory_type === "decision" ||
      d.row.memory_type === "lesson" ||
      d.row.memory_type === "failure"
  );
  const shorttermRows = decrypted.filter(
    (d) => d.row.memory_type === "event" || d.row.memory_type === "note"
  );

  // ── 1. Preference bucket (always inject, capped at PREF_BUDGET) ────────────
  const prefSorted = prefRows.sort((a, b) => {
    if (a.row.is_pinned !== b.row.is_pinned) return a.row.is_pinned ? -1 : 1;
    return (b.row.reference_count ?? 0) - (a.row.reference_count ?? 0);
  });
  const prefMemories = packUnderBudget(
    prefSorted.map((r) => ({
      ...r,
      score: 10 + activitySignal(r.row.reference_count ?? 1, r.row.last_referenced_at ?? null),
    })),
    PREF_BUDGET
  );

  // ── 2. Long-term bucket (dump-all or overflow hybrid) ─────────────────────
  const t1 = Date.now();
  let longtermMemories: BucketMemory[];

  const longtermTotalTokens = longtermRows.reduce(
    (s, r) => s + estimateTokens(r.text),
    0
  );

  if (longtermTotalTokens <= LONGTERM_BUDGET) {
    // Fits entirely — dump everything, sorted by reference count
    longtermMemories = packUnderBudget(
      longtermRows
        .sort((a, b) => (b.row.reference_count ?? 0) - (a.row.reference_count ?? 0))
        .map((r) => ({
          ...r,
          score: activitySignal(r.row.reference_count ?? 1, r.row.last_referenced_at ?? null),
        })),
      LONGTERM_BUDGET
    );
  } else {
    // Overflow — recall-first hybrid, recall > precision
    longtermMemories = await recallFirstHybrid(query, auth, longtermRows, LONGTERM_BUDGET);
  }
  timingsMs.longterm_ms = Date.now() - t1;

  // ── 3. Short-term bucket (recency-first, 60d decay) ───────────────────────
  const cutoff = Date.now() - SHORT_TERM_MAX_AGE_DAYS * 86_400_000;
  const recentRows = shorttermRows
    .filter((r) => new Date(r.row.created_at).getTime() >= cutoff)
    .sort(
      (a, b) =>
        new Date(b.row.created_at).getTime() - new Date(a.row.created_at).getTime()
    );
  const shorttermMemories = packUnderBudget(
    recentRows.map((r, i) => ({ ...r, score: Math.max(0.01, 1 - i * 0.05) })),
    SHORTTERM_BUDGET
  );

  // ── Combine ───────────────────────────────────────────────────────────────
  const memories = [...prefMemories, ...longtermMemories, ...shorttermMemories];
  timingsMs.total_ms = Date.now() - t0;

  const conflictHints = detectConflicts(memories);

  return {
    contextBlock: buildContextBlock(memories),
    memories,
    timingsMs,
    ...(conflictHints.length > 0 ? { conflictHints } : {}),
  };
}
