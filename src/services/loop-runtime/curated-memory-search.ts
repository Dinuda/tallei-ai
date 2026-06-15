import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { embedText } from "../../infrastructure/cache/embedding-cache.js";
import { decryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { MemoryRepository, type MemoryRecordRow } from "../../infrastructure/repositories/memory.repository.js";
import { VectorRepository } from "../../infrastructure/repositories/vector.repository.js";
import { emptyCleanupAiUsage, recordCleanupAiUsage } from "../../orchestration/memory-cleanup/usage.js";
import type { CleanupAiUsage } from "../../orchestration/memory-cleanup/types.js";
import type { LoopRunAgent } from "../loop-executor/types.js";
import { loopExecutorOpenAiChat } from "../loop-executor/openai-chat.js";

const memoryRepository = new MemoryRepository();
const vectorRepository = new VectorRepository();

const MAX_PLAN_QUERIES = 4;
const MAX_CANDIDATES = 24;
const MAX_ACCEPTED = 8;
const LLM_VALIDATION_CANDIDATES = 8;
const MAX_VALIDATION_TEXT_CHARS = 700;
const VECTOR_RESULTS_PER_QUERY = 14;
const BM25_RESULTS_PER_QUERY = 16;
const ENTITY_RESULTS_PER_QUERY = 12;
const RRF_K = 60;
const DEDUP_SIMILARITY_THRESHOLD = 0.86;

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "agent",
  "all",
  "also",
  "and",
  "any",
  "are",
  "ask",
  "been",
  "before",
  "blog",
  "can",
  "customer",
  "draft",
  "email",
  "for",
  "from",
  "get",
  "has",
  "have",
  "how",
  "input",
  "into",
  "internal",
  "loop",
  "memory",
  "not",
  "now",
  "only",
  "output",
  "past",
  "please",
  "post",
  "product",
  "provide",
  "run",
  "search",
  "sync",
  "task",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "update",
  "updates",
  "user",
  "what",
  "when",
  "with",
  "workflow",
  "write",
]);

const evidenceRoleSchema = z.enum([
  "past_update",
  "style",
  "decision",
  "project_context",
  "constraint",
]);

type CuratedMemoryEvidenceRole = z.infer<typeof evidenceRoleSchema>;

const queryPlanSchema = z.object({
  intent: z.string().min(1),
  outputType: z.string().min(1),
  entities: z.array(z.string()).default([]),
  dateHints: z.array(z.string()).default([]),
  queries: z.array(z.string()).min(1).max(MAX_PLAN_QUERIES),
  requiredEvidence: z.array(z.string()).default([]),
});

type CuratedMemoryQueryPlan = z.infer<typeof queryPlanSchema>;

const validationSchema = z.object({
  accepted: z.array(z.object({
    id: z.string().min(1),
    excerpt: z.string().min(1),
    reason: z.string().min(1),
    evidenceRole: evidenceRoleSchema,
    confidence: z.number().min(0).max(1),
  })).default([]),
  rejectedIds: z.array(z.string()).default([]),
  confidence: z.enum(["high", "medium", "low", "none"]).default("none"),
  noEvidenceReason: z.string().optional(),
});

interface CuratedMemorySearchSource {
  id: string;
  text: string;
  score: number;
  confidence: number;
  reason: string;
  evidenceRole: CuratedMemoryEvidenceRole;
  metadata: Record<string, unknown>;
}

type CandidateMatch = {
  kind: "vector" | "bm25" | "entity";
  query: string;
  score: number;
  rank: number;
};

interface CuratedMemorySearchTrace {
  query: string;
  queryPlan: CuratedMemoryQueryPlan;
  retrieval: {
    mode: "deterministic_hybrid";
    temporalPolicy: BlogCyclePolicy;
    vectorQueries: Array<{
      query: string;
      hitCount: number;
      topMatches: Array<{ id: string; score: number }>;
    }>;
    lexicalMatchCount: number;
    entityMatchCount: number;
    mergedCandidateCount: number;
  };
  candidates: Array<{
    id: string;
    text: string;
    score: number;
    similarity: number;
    metadata: Record<string, unknown>;
    matches: CandidateMatch[];
    accepted: boolean;
    acceptedConfidence?: number;
    acceptedReason?: string;
    evidenceRole?: CuratedMemoryEvidenceRole;
  }>;
  validation: {
    method: "llm_shortlist" | "deterministic_hybrid" | "llm_unavailable_fallback";
    acceptedCount: number;
    acceptedIds: string[];
    rejectedCount: number;
    confidence: "high" | "medium" | "low" | "none";
    noEvidenceReason?: string;
  };
}

interface CuratedMemorySearchResult {
  queryPlan: CuratedMemoryQueryPlan;
  sources: CuratedMemorySearchSource[];
  rejectedCount: number;
  confidence: "high" | "medium" | "low" | "none";
  usage: CleanupAiUsage;
  trace: CuratedMemorySearchTrace;
  noEvidenceReason?: string;
}

interface CuratedMemorySearchInput {
  auth: AuthContext;
  goal: string;
  agent: LoopRunAgent;
  configuredQuery?: string | null;
  workflowTitle?: string;
  priorComments?: Array<{ author: string; body: string }>;
  now?: Date;
}

interface CandidateMemory {
  id: string;
  text: string;
  score: number;
  similarity: number;
  matches: CandidateMatch[];
  metadata: Record<string, unknown>;
}

interface DecryptedMemory {
  id: string;
  text: string;
  row: MemoryRecordRow;
  metadata: Record<string, unknown>;
}

interface VectorCandidateResult {
  hitsById: Map<string, CandidateMatch[]>;
  vectorQueries: CuratedMemorySearchTrace["retrieval"]["vectorQueries"];
}

interface Bm25Doc {
  id: string;
  tokens: string[];
  tf: Map<string, number>;
}

interface Bm25Index {
  docs: Bm25Doc[];
  df: Map<string, number>;
  avgdl: number;
  n: number;
}

interface BlogCyclePolicy {
  applies: boolean;
  currentCycleStartIso: string | null;
  previousCycleStartIso: string | null;
  previousCycleEndIso: string | null;
  rule: string;
}

interface CuratedMemorySearchDeps {
  memoryRepository: Pick<MemoryRepository, "listAll" | "getByIds">;
  vectorRepository: Pick<VectorRepository, "searchVectors">;
  embedText: typeof embedText;
  decryptMemoryContent: typeof decryptMemoryContent;
  chat: typeof loopExecutorOpenAiChat;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function uniqueStrings(values: string[], limit: number): string[] {
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("LLM response did not contain JSON");
    return JSON.parse(match[0]);
  }
}

function rowMetadata(row: MemoryRecordRow): Record<string, unknown> {
  const summary = row.summary_json && typeof row.summary_json === "object"
    ? row.summary_json as Record<string, unknown>
    : {};
  return {
    ...summary,
    platform: row.platform,
    createdAt: row.created_at,
    memory_type: row.memory_type,
    category: row.category,
    is_pinned: row.is_pinned,
    reference_count: row.reference_count,
    tier: row.tier,
    segment: row.segment,
    importance: Number(row.importance),
    lifecycle: row.lifecycle,
  };
}

function decryptRows(
  rows: MemoryRecordRow[],
  deps: Pick<CuratedMemorySearchDeps, "decryptMemoryContent">,
): DecryptedMemory[] {
  return rows.flatMap((row) => {
    try {
      const text = normalizeWhitespace(deps.decryptMemoryContent(row.content_ciphertext));
      if (!text) return [];
      return [{
        id: row.id,
        text,
        row,
        metadata: rowMetadata(row),
      }];
    } catch {
      return [];
    }
  });
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])\/([a-z])/g, "$1$2")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function keywordTokens(text: string): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token]) => token);
}

function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[- ][A-Z][A-Za-z0-9]*){0,3}\b/g)) {
    const value = normalizeWhitespace(match[0]);
    if (value.length > 1 && !/^(I|The|This|That|Please|Can|What|How|When)$/.test(value)) {
      entities.add(value);
    }
  }
  for (const match of text.matchAll(/`([^`]+)`|"([^"]+)"/g)) {
    const value = normalizeWhitespace(match[1] ?? match[2] ?? "");
    if (value) entities.add(value);
  }
  return [...entities].slice(0, 8);
}

function detectOutputType(input: CuratedMemorySearchInput): string {
  const combined = `${input.goal} ${input.agent.task} ${input.agent.outputContract?.description ?? ""}`.toLowerCase();
  if (combined.includes("blog")) return "customer_blog_post";
  if (combined.includes("email") || combined.includes("sync")) return "internal_sync_email";
  if (combined.includes("artifact")) return "artifact_context";
  return "loop_run_memory_context";
}

function isThisWeekBlogRequest(input: CuratedMemorySearchInput): boolean {
  const combined = [
    input.configuredQuery ?? "",
    input.workflowTitle ?? "",
    input.goal,
    input.agent.name,
    input.agent.task,
    input.agent.goal ?? "",
    input.agent.outputContract?.description ?? "",
  ].join(" ").toLowerCase();
  return /\b(blog|customer-facing|customer post|product update)\b/.test(combined) &&
    /\b(this week|weekly|this sprint|sprint)\b/.test(combined);
}

function startOfMondayWeek(input: Date): Date {
  const out = new Date(input);
  out.setHours(0, 0, 0, 0);
  const day = out.getDay();
  const daysSinceMonday = (day + 6) % 7;
  out.setDate(out.getDate() - daysSinceMonday);
  return out;
}

function addDays(input: Date, days: number): Date {
  const out = new Date(input);
  out.setDate(out.getDate() + days);
  return out;
}

function buildBlogCyclePolicy(input: CuratedMemorySearchInput): BlogCyclePolicy {
  if (!isThisWeekBlogRequest(input)) {
    return {
      applies: false,
      currentCycleStartIso: null,
      previousCycleStartIso: null,
      previousCycleEndIso: null,
      rule: "No blog-cycle constraint detected.",
    };
  }

  const currentCycleStart = startOfMondayWeek(input.now ?? new Date());
  const previousCycleStart = addDays(currentCycleStart, -7);
  return {
    applies: true,
    currentCycleStartIso: currentCycleStart.toISOString(),
    previousCycleStartIso: previousCycleStart.toISOString(),
    previousCycleEndIso: currentCycleStart.toISOString(),
    rule:
      "For a this-week blog/product-update run, memory search should provide prior-cycle context. " +
      "Reject product-update memories created on or after currentCycleStart; prefer the previous completed weekly cycle. " +
      "Reusable style, decision, and constraint memories may still pass.",
  };
}

function requiredEvidenceFor(input: CuratedMemorySearchInput): string[] {
  const combined = `${input.goal} ${input.agent.task} ${input.agent.outputContract?.description ?? ""}`.toLowerCase();
  const required = ["specific task-relevant context"];
  if (/\b(shipped|progress|sprint|blocker|rollout|customer|blog|sync|update)\b/.test(combined)) {
    required.push("past product updates or rollout context");
  }
  if (/\b(style|tone|voice|founder|customer-facing|copy)\b/.test(combined)) {
    required.push("writing style or audience guidance");
  }
  if (/\b(constraint|must|avoid|do not|don't|approval|gate)\b/.test(combined)) {
    required.push("constraints or decisions");
  }
  return required;
}

function buildQueryPlan(input: CuratedMemorySearchInput): CuratedMemoryQueryPlan {
  const seed = normalizeWhitespace(input.configuredQuery || input.agent.task || input.goal);
  const combined = normalizeWhitespace([
    input.configuredQuery ?? "",
    input.workflowTitle ?? "",
    input.goal,
    input.agent.name,
    input.agent.task,
    input.agent.goal ?? "",
    input.agent.outputContract?.description ?? "",
    ...(input.priorComments ?? []).slice(-2).map((comment) => comment.body),
  ].join(" "));
  const entities = extractEntities(combined);
  const keywords = keywordTokens(combined).slice(0, 10);
  const entityQuery = entities.length > 0 ? entities.slice(0, 4).join(" ") : "";
  const keywordQuery = keywords.join(" ");
  const queries = uniqueStrings([
    seed,
    [entityQuery, keywordQuery].filter(Boolean).join(" "),
    `${seed} ${keywordQuery}`.trim(),
    `${input.workflowTitle ?? ""} ${input.goal}`.trim(),
  ], MAX_PLAN_QUERIES);

  return queryPlanSchema.parse({
    intent: seed,
    outputType: detectOutputType(input),
    entities,
    dateHints: extractDateHints(combined),
    queries,
    requiredEvidence: requiredEvidenceFor(input),
  });
}

function extractDateHints(text: string): string[] {
  const hints = new Set<string>();
  for (const pattern of [
    /\bthis week\b/gi,
    /\blast week\b/gi,
    /\bnext week\b/gi,
    /\bthis sprint\b/gi,
    /\bnext sprint\b/gi,
    /\blast sprint\b/gi,
    /\btoday\b/gi,
    /\byesterday\b/gi,
  ]) {
    for (const match of text.matchAll(pattern)) {
      hints.add(match[0].toLowerCase());
    }
  }
  return [...hints];
}

async function vectorCandidates(
  auth: AuthContext,
  queries: string[],
  deps: Pick<CuratedMemorySearchDeps, "embedText" | "vectorRepository">,
): Promise<VectorCandidateResult> {
  const hitsById = new Map<string, CandidateMatch[]>();
  const vectorQueries: VectorCandidateResult["vectorQueries"] = [];
  for (const query of queries) {
    try {
      const vector = await deps.embedText(query);
      const hits = await deps.vectorRepository.searchVectors(auth, vector, VECTOR_RESULTS_PER_QUERY);
      vectorQueries.push({
        query,
        hitCount: hits.length,
        topMatches: hits.slice(0, 5).map((hit) => ({
          id: hit.memoryId,
          score: hit.score,
        })),
      });
      hits.forEach((hit, index) => {
        const existing = hitsById.get(hit.memoryId) ?? [];
        existing.push({
          kind: "vector",
          query,
          score: hit.score,
          rank: index + 1,
        });
        hitsById.set(hit.memoryId, existing);
      });
    } catch {
      // Hybrid retrieval is best-effort; BM25/entity signals still run.
    }
  }
  return { hitsById, vectorQueries };
}

function buildBm25Index(docs: DecryptedMemory[]): Bm25Index {
  const bm25Docs = docs.map((doc) => {
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    return { id: doc.id, tokens, tf };
  });
  const df = new Map<string, number>();
  for (const doc of bm25Docs) {
    for (const token of doc.tf.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const totalLength = bm25Docs.reduce((sum, doc) => sum + doc.tokens.length, 0);
  return {
    docs: bm25Docs,
    df,
    avgdl: totalLength / Math.max(1, bm25Docs.length),
    n: bm25Docs.length,
  };
}

function bm25Search(index: Bm25Index, query: string, limit: number): Array<{ id: string; score: number }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || index.n === 0) return [];
  const k1 = 1.5;
  const b = 0.75;
  return index.docs
    .map((doc) => {
      let score = 0;
      for (const token of queryTokens) {
        const freq = doc.tf.get(token) ?? 0;
        if (freq === 0) continue;
        const df = index.df.get(token) ?? 0;
        const idf = Math.log((index.n - df + 0.5) / (df + 0.5) + 1);
        score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (doc.tokens.length / index.avgdl))));
      }
      return { id: doc.id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function entitySearch(docs: DecryptedMemory[], entities: string[], query: string, limit: number): Array<{ id: string; score: number }> {
  const normalizedEntities = entities.map((entity) => entity.toLowerCase()).filter(Boolean);
  const queryTokens = keywordTokens(query).slice(0, 8);
  if (normalizedEntities.length === 0 && queryTokens.length === 0) return [];
  return docs
    .map((doc) => {
      const text = doc.text.toLowerCase();
      let score = 0;
      for (const entity of normalizedEntities) {
        if (text.includes(entity)) score += 2;
      }
      for (const token of queryTokens) {
        if (text.includes(token)) score += 0.5;
      }
      return { id: doc.id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function candidateRrfScore(matches: CandidateMatch[]): number {
  return matches.reduce((sum, match) => sum + (1 / (RRF_K + match.rank)), 0);
}

function signalSimilarity(matches: CandidateMatch[]): number {
  const byKind = new Map<CandidateMatch["kind"], number>();
  for (const match of matches) {
    byKind.set(match.kind, Math.max(byKind.get(match.kind) ?? 0, match.score));
  }
  const values = [...byKind.values()];
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function ageDays(createdAtIso: unknown): number {
  if (typeof createdAtIso !== "string") return 0;
  const parsed = new Date(createdAtIso).getTime();
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, (Date.now() - parsed) / 86_400_000);
}

function metadataBoost(memory: DecryptedMemory): number {
  const referenceCount = Number(memory.metadata.reference_count ?? 1);
  const importance = Number(memory.metadata.importance ?? 0.6);
  const age = ageDays(memory.metadata.createdAt);
  const type = typeof memory.metadata.memory_type === "string" ? memory.metadata.memory_type : "";
  const category = typeof memory.metadata.category === "string" ? memory.metadata.category : "";
  let boost = 1;
  boost *= 1 + Math.min(0.18, Math.log1p(Math.max(0, referenceCount)) * 0.04);
  boost *= 1 + Math.min(0.16, Math.max(0, importance - 0.5) * 0.32);
  if (type === "decision" || type === "lesson") boost *= 1.06;
  if (category === "personal" || category === "identity") boost *= 0.72;
  if ((type === "event" || type === "note") && age > 45) boost *= 0.78;
  if (age <= 21) boost *= 1.08;
  return boost;
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
  return union > 0 ? overlap / union : 0;
}

function inferEvidenceRole(source: CuratedMemorySearchInput, memory: DecryptedMemory): CuratedMemoryEvidenceRole {
  const combined = `${source.goal} ${source.agent.task} ${source.agent.outputContract?.description ?? ""}`.toLowerCase();
  const text = memory.text.toLowerCase();
  const type = typeof memory.metadata.memory_type === "string" ? memory.metadata.memory_type : "";
  if (/\b(style|tone|voice|founder|customer-facing|copy)\b/.test(combined) && /\b(style|tone|voice|founder|customer|blog|copy)\b/.test(text)) {
    return "style";
  }
  if (type === "decision" || /\b(decided|decision|approved|rejected|must|avoid|constraint)\b/.test(text)) {
    return "decision";
  }
  if (/\b(blocker|must|avoid|constraint|watch|support|ops)\b/.test(text)) {
    return "constraint";
  }
  if (/\b(shipped|sprint|progress|rollout|customer|blog|update|fixed|improved)\b/.test(text)) {
    return "past_update";
  }
  return "project_context";
}

function parsedCreatedAt(memory: Pick<DecryptedMemory, "metadata">): Date | null {
  const createdAt = memory.metadata.createdAt;
  if (typeof createdAt !== "string") return null;
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function temporalDecision(input: {
  policy: BlogCyclePolicy;
  role: CuratedMemoryEvidenceRole;
  memory: Pick<DecryptedMemory, "metadata" | "text">;
}): { allowed: boolean; reason: string; bucket: "not_applicable" | "previous_cycle" | "older_prior_context" | "current_cycle_allowed" | "current_cycle_rejected" | "unknown_date" } {
  if (!input.policy.applies) {
    return { allowed: true, reason: "No blog-cycle temporal filter applies.", bucket: "not_applicable" };
  }
  const createdAt = parsedCreatedAt(input.memory);
  if (!createdAt || !input.policy.currentCycleStartIso) {
    return {
      allowed: input.role === "style" || input.role === "decision" || input.role === "constraint",
      reason: "Memory has no reliable createdAt; only reusable style, decision, or constraint evidence may pass.",
      bucket: "unknown_date",
    };
  }
  const currentCycleStart = new Date(input.policy.currentCycleStartIso);
  const previousCycleStart = input.policy.previousCycleStartIso
    ? new Date(input.policy.previousCycleStartIso)
    : null;
  const reusable = input.role === "style" || input.role === "decision" || input.role === "constraint";
  if (createdAt >= currentCycleStart) {
    return reusable
      ? {
          allowed: true,
          reason: "Current-cycle memory accepted only because it is reusable style, decision, or constraint context.",
          bucket: "current_cycle_allowed",
        }
      : {
          allowed: false,
          reason: "Current-cycle product/update memory rejected; this-week blog runs should use pasted sprint notes for current facts.",
          bucket: "current_cycle_rejected",
        };
  }
  if (previousCycleStart && createdAt >= previousCycleStart) {
    return {
      allowed: true,
      reason: "Memory belongs to the previous completed weekly cycle.",
      bucket: "previous_cycle",
    };
  }
  return {
    allowed: true,
    reason: "Memory predates the current cycle and may provide prior context.",
    bucket: "older_prior_context",
  };
}

function buildReason(memory: DecryptedMemory, matches: CandidateMatch[]): string {
  const kinds = [...new Set(matches.map((match) => match.kind))].join(", ");
  const entityHits = matches.filter((match) => match.kind === "entity").length;
  const lexicalHits = matches.filter((match) => match.kind === "bm25").length;
  const vectorHits = matches.filter((match) => match.kind === "vector").length;
  const parts = [`Matched by ${kinds || "hybrid ranking"}`];
  if (entityHits > 0) parts.push(`${entityHits} entity/keyword hit${entityHits === 1 ? "" : "s"}`);
  if (lexicalHits > 0) parts.push(`${lexicalHits} BM25 hit${lexicalHits === 1 ? "" : "s"}`);
  if (vectorHits > 0) parts.push(`${vectorHits} vector hit${vectorHits === 1 ? "" : "s"}`);
  const category = typeof memory.metadata.category === "string" ? memory.metadata.category : null;
  if (category) parts.push(`category: ${category}`);
  return `${parts.join("; ")}.`;
}

function normalizeHitScores(hits: Array<{ id: string; score: number }>): Map<string, number> {
  const max = Math.max(0, ...hits.map((hit) => hit.score));
  return new Map(hits.map((hit) => [hit.id, max > 0 ? hit.score / max : 0]));
}

function rankCandidates(input: {
  run: CuratedMemorySearchInput;
  docs: DecryptedMemory[];
  queryPlan: CuratedMemoryQueryPlan;
  vector: VectorCandidateResult;
}): {
  candidates: CandidateMemory[];
  lexicalMatchCount: number;
  entityMatchCount: number;
} {
  const docsById = new Map(input.docs.map((doc) => [doc.id, doc]));
  const matchMap = new Map<string, CandidateMatch[]>();
  for (const [id, matches] of input.vector.hitsById) {
    if (docsById.has(id)) matchMap.set(id, [...matches]);
  }

  const bm25Index = buildBm25Index(input.docs);
  let lexicalMatchCount = 0;
  let entityMatchCount = 0;
  for (const query of input.queryPlan.queries) {
    const bm25Hits = bm25Search(bm25Index, query, BM25_RESULTS_PER_QUERY);
    lexicalMatchCount += bm25Hits.length;
    const bm25Norm = normalizeHitScores(bm25Hits);
    bm25Hits.forEach((hit, index) => {
      const matches = matchMap.get(hit.id) ?? [];
      matches.push({
        kind: "bm25",
        query,
        score: Number((bm25Norm.get(hit.id) ?? 0).toFixed(6)),
        rank: index + 1,
      });
      matchMap.set(hit.id, matches);
    });

    const entityHits = entitySearch(input.docs, input.queryPlan.entities, query, ENTITY_RESULTS_PER_QUERY);
    entityMatchCount += entityHits.length;
    const entityNorm = normalizeHitScores(entityHits);
    entityHits.forEach((hit, index) => {
      const matches = matchMap.get(hit.id) ?? [];
      matches.push({
        kind: "entity",
        query,
        score: Number((entityNorm.get(hit.id) ?? 0).toFixed(6)),
        rank: index + 1,
      });
      matchMap.set(hit.id, matches);
    });
  }

  const candidates = [...matchMap.entries()].flatMap(([id, matches]) => {
    const doc = docsById.get(id);
    if (!doc || matches.length === 0) return [];
    const similarity = signalSimilarity(matches);
    const score = Number((candidateRrfScore(matches) * metadataBoost(doc) * (1 + similarity)).toFixed(6));
    return [{
      id,
      text: doc.text,
      score,
      similarity,
      matches: matches.sort((a, b) => a.rank - b.rank),
      metadata: doc.metadata,
    }];
  });

  return {
    candidates: dedupeCandidates(
      candidates
        .sort((a, b) => b.score - a.score || b.similarity - a.similarity)
        .slice(0, MAX_CANDIDATES),
    ),
    lexicalMatchCount,
    entityMatchCount,
  };
}

function dedupeCandidates(candidates: CandidateMemory[]): CandidateMemory[] {
  const out: CandidateMemory[] = [];
  for (const candidate of candidates) {
    const duplicate = out.some((existing) => textSimilarity(existing.text, candidate.text) > DEDUP_SIMILARITY_THRESHOLD);
    if (!duplicate) out.push(candidate);
  }
  return out;
}

function acceptedSources(input: {
  run: CuratedMemorySearchInput;
  candidates: CandidateMemory[];
  temporalPolicy: BlogCyclePolicy;
}): CuratedMemorySearchSource[] {
  return input.candidates
    .flatMap((candidate) => {
      const syntheticMemory: DecryptedMemory = {
        id: candidate.id,
        text: candidate.text,
        row: null as never,
        metadata: candidate.metadata,
      };
      const evidenceRole = inferEvidenceRole(input.run, syntheticMemory);
      const temporal = temporalDecision({
        policy: input.temporalPolicy,
        role: evidenceRole,
        memory: syntheticMemory,
      });
      if (!temporal.allowed) return [];
      const confidence = Math.min(0.96, Math.max(0.45, candidate.similarity * 0.72 + candidate.score * 1.7));
      return [{
        id: candidate.id,
        text: candidate.text,
        score: candidate.score,
        confidence: Number(confidence.toFixed(3)),
        reason: `${buildReason(syntheticMemory, candidate.matches)} ${temporal.reason}`,
        evidenceRole,
        metadata: {
          ...candidate.metadata,
          temporalBucket: temporal.bucket,
          temporalReason: temporal.reason,
        },
      }];
    })
    .slice(0, MAX_ACCEPTED);
}

function confidenceFromSources(sources: CuratedMemorySearchSource[]): "high" | "medium" | "low" | "none" {
  if (sources.length === 0) return "none";
  const best = Math.max(...sources.map((source) => source.confidence));
  if (best >= 0.78) return "high";
  if (best >= 0.58) return "medium";
  return "low";
}

function noEvidenceReasonFor(candidates: CandidateMemory[]): string {
  if (candidates.length === 0) {
    return "No vector, BM25, or entity candidates matched the run intent.";
  }
  const best = candidates[0];
  return `No candidate crossed the deterministic relevance floor. Best score ${best?.score ?? 0}, similarity ${best?.similarity ?? 0}.`;
}

function buildValidationPrompt(input: {
  run: CuratedMemorySearchInput;
  queryPlan: CuratedMemoryQueryPlan;
  temporalPolicy: BlogCyclePolicy;
  sources: CuratedMemorySearchSource[];
}) {
  const candidates = input.sources.slice(0, LLM_VALIDATION_CANDIDATES).map((source, index) => ({
    index: index + 1,
    id: source.id,
    score: source.score,
    confidence: source.confidence,
    evidenceRole: source.evidenceRole,
    reason: source.reason,
    metadata: {
      createdAt: source.metadata.createdAt,
      memory_type: source.metadata.memory_type,
      category: source.metadata.category,
      temporalBucket: source.metadata.temporalBucket,
      temporalReason: source.metadata.temporalReason,
    },
    text: source.text.slice(0, MAX_VALIDATION_TEXT_CHARS),
  }));

  return [
    "Fact-check this shortlisted memory set for a loop run. Return JSON only.",
    "Only accept memories that directly help the requested output. Keep useful excerpts short and faithful.",
    "Reject memories that are merely semantically similar, personal/unrelated, stale for the requested task, or current-cycle product facts that should come from pasted sprint notes.",
    "For this-week blog/product-update runs, enforce the temporal policy exactly unless the memory is reusable style, decision, or constraint context.",
    "Use evidenceRole values only from: past_update, style, decision, project_context, constraint.",
    "Return shape: { accepted: [{ id, excerpt, reason, evidenceRole, confidence }], rejectedIds, confidence, noEvidenceReason }.",
    `Loop goal: ${input.run.goal}`,
    `Workflow title: ${input.run.workflowTitle ?? "unknown"}`,
    `Agent task: ${input.run.agent.task}`,
    `Agent output contract: ${input.run.agent.outputContract?.description ?? "none"}`,
    `Retrieval plan: ${JSON.stringify(input.queryPlan)}`,
    `Temporal policy: ${JSON.stringify(input.temporalPolicy)}`,
    `Shortlisted candidates: ${JSON.stringify(candidates)}`,
  ].join("\n\n");
}

async function validateShortlistedSources(input: {
  run: CuratedMemorySearchInput;
  queryPlan: CuratedMemoryQueryPlan;
  temporalPolicy: BlogCyclePolicy;
  sources: CuratedMemorySearchSource[];
  deps: Pick<CuratedMemorySearchDeps, "chat">;
  usage: CleanupAiUsage;
}): Promise<{
  method: CuratedMemorySearchTrace["validation"]["method"];
  sources: CuratedMemorySearchSource[];
  confidence: "high" | "medium" | "low" | "none";
  rejectedCount: number;
  noEvidenceReason?: string;
}> {
  if (input.sources.length === 0) {
    return {
      method: "deterministic_hybrid",
      sources: [],
      confidence: "none",
      rejectedCount: 0,
    };
  }

  const prompt = buildValidationPrompt(input);
  const request = {
    temperature: 0,
    maxTokens: 1200,
    responseFormat: "json_object" as const,
    messages: [
      {
        role: "system" as const,
        content:
          "You are a strict memory relevance and temporal fact checker. Prefer rejecting weak evidence over accepting noisy memory.",
      },
      { role: "user" as const, content: prompt },
    ],
  };

  try {
    const response = await input.deps.chat(request);
    recordCleanupAiUsage(input.usage, request as never, response as never);
    const validation = validationSchema.parse(safeJsonParse(response.text));
    const sourceById = new Map(input.sources.map((source) => [source.id, source]));
    const acceptedSources = validation.accepted.flatMap((accepted) => {
      const source = sourceById.get(accepted.id);
      if (!source) return [];
      return [{
        ...source,
        text: normalizeWhitespace(accepted.excerpt || source.text),
        confidence: accepted.confidence,
        reason: accepted.reason,
        evidenceRole: accepted.evidenceRole,
      }];
    }).slice(0, MAX_ACCEPTED);
    const acceptedIds = new Set(acceptedSources.map((source) => source.id));
    const rejectedCount = Math.max(
      validation.rejectedIds.length,
      input.sources.filter((source) => !acceptedIds.has(source.id)).length,
    );
    const confidence = confidenceFromSources(acceptedSources);
    return {
      method: "llm_shortlist",
      sources: acceptedSources,
      confidence: acceptedSources.length > 0 ? (validation.confidence === "none" ? confidence : validation.confidence) : "none",
      rejectedCount,
      ...(acceptedSources.length === 0
        ? { noEvidenceReason: validation.noEvidenceReason ?? "No shortlisted memories passed LLM validation." }
        : {}),
    };
  } catch {
    return {
      method: "llm_unavailable_fallback",
      sources: input.sources,
      confidence: confidenceFromSources(input.sources),
      rejectedCount: 0,
      noEvidenceReason: undefined,
    };
  }
}

export async function runCuratedMemorySearch(
  input: CuratedMemorySearchInput,
  deps: CuratedMemorySearchDeps = {
    memoryRepository,
    vectorRepository,
    embedText,
    decryptMemoryContent,
    chat: loopExecutorOpenAiChat,
  },
): Promise<CuratedMemorySearchResult> {
  const usage = emptyCleanupAiUsage();
  const queryPlan = buildQueryPlan(input);
  const temporalPolicy = buildBlogCyclePolicy(input);
  const queries = uniqueStrings(queryPlan.queries, MAX_PLAN_QUERIES);
  const [rows, vectorRetrieval] = await Promise.all([
    deps.memoryRepository.listAll(input.auth, { includeSuperseded: false }).catch(() => []),
    vectorCandidates(input.auth, queries, deps),
  ]);
  const docs = decryptRows(rows, deps);
  const ranked = rankCandidates({
    run: input,
    docs,
    queryPlan: {
      ...queryPlan,
      queries,
    },
    vector: vectorRetrieval,
  });
  const sources = acceptedSources({
    run: input,
    candidates: ranked.candidates,
    temporalPolicy,
  });
  const confidence = confidenceFromSources(sources);
  const rejectedCount = Math.max(0, ranked.candidates.length - sources.length);
  const acceptedById = new Map(sources.map((source) => [source.id, source]));
  const noEvidenceReason = sources.length === 0 ? noEvidenceReasonFor(ranked.candidates) : undefined;

  return {
    queryPlan: {
      ...queryPlan,
      queries,
    },
    sources,
    rejectedCount,
    confidence,
    usage: {
      ...usage,
      estimatedCostUsd: Number(usage.estimatedCostUsd.toFixed(6)),
    },
    trace: {
      query: normalizeWhitespace(input.configuredQuery || input.agent.task || input.goal),
      queryPlan: {
        ...queryPlan,
        queries,
      },
      retrieval: {
        mode: "deterministic_hybrid",
        temporalPolicy,
        vectorQueries: vectorRetrieval.vectorQueries,
        lexicalMatchCount: ranked.lexicalMatchCount,
        entityMatchCount: ranked.entityMatchCount,
        mergedCandidateCount: ranked.candidates.length,
      },
      candidates: ranked.candidates.map((candidate) => {
        const accepted = acceptedById.get(candidate.id) ?? null;
        return {
          id: candidate.id,
          text: candidate.text,
          score: candidate.score,
          similarity: Number(candidate.similarity.toFixed(6)),
          metadata: candidate.metadata,
          matches: candidate.matches,
          accepted: Boolean(accepted),
          ...(accepted ? {
            acceptedConfidence: accepted.confidence,
            acceptedReason: accepted.reason,
            evidenceRole: accepted.evidenceRole,
          } : {}),
        };
      }),
      validation: {
        method: "deterministic_hybrid",
        acceptedCount: sources.length,
        acceptedIds: sources.map((source) => source.id),
        rejectedCount,
        confidence,
        ...(noEvidenceReason ? { noEvidenceReason } : {}),
      },
    },
    ...(noEvidenceReason ? { noEvidenceReason } : {}),
  };
}
