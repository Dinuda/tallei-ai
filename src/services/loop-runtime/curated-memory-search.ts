import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { embedText } from "../../infrastructure/cache/embedding-cache.js";
import { decryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { MemoryRepository, type MemoryRecordRow } from "../../infrastructure/repositories/memory.repository.js";
import { VectorRepository } from "../../infrastructure/repositories/vector.repository.js";
import type { LoopRunAgent } from "../loop-executor/types.js";
import { loopExecutorOpenAiChat } from "../loop-executor/openai-chat.js";

const memoryRepository = new MemoryRepository();
const vectorRepository = new VectorRepository();

const MAX_PLAN_QUERIES = 5;
const MIN_PLAN_QUERIES = 3;
const MAX_CANDIDATES = 30;
const MAX_ACCEPTED = 8;
const MAX_CANDIDATE_TEXT_CHARS = 900;
const VECTOR_RESULTS_PER_QUERY = 10;
const LEXICAL_RESULTS_PER_QUERY = 8;

const evidenceRoleSchema = z.enum([
  "past_update",
  "style",
  "decision",
  "project_context",
  "constraint",
]);

export type CuratedMemoryEvidenceRole = z.infer<typeof evidenceRoleSchema>;

const queryPlanSchema = z.object({
  intent: z.string().min(1),
  outputType: z.string().min(1),
  entities: z.array(z.string()).default([]),
  dateHints: z.array(z.string()).default([]),
  queries: z.array(z.string()).min(1).max(MAX_PLAN_QUERIES),
  requiredEvidence: z.array(z.string()).default([]),
});

export type CuratedMemoryQueryPlan = z.infer<typeof queryPlanSchema>;

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

export interface CuratedMemorySearchSource {
  id: string;
  text: string;
  score: number;
  confidence: number;
  reason: string;
  evidenceRole: CuratedMemoryEvidenceRole;
  metadata: Record<string, unknown>;
}

export interface CuratedMemorySearchResult {
  queryPlan: CuratedMemoryQueryPlan;
  sources: CuratedMemorySearchSource[];
  rejectedCount: number;
  confidence: "high" | "medium" | "low" | "none";
  noEvidenceReason?: string;
}

export interface CuratedMemorySearchInput {
  auth: AuthContext;
  goal: string;
  agent: LoopRunAgent;
  configuredQuery?: string | null;
  workflowTitle?: string;
  priorComments?: Array<{ author: string; body: string }>;
}

interface CandidateMemory {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface CuratedMemorySearchDeps {
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

function decryptRow(
  row: MemoryRecordRow,
  score: number,
  deps: Pick<CuratedMemorySearchDeps, "decryptMemoryContent">,
): CandidateMemory | null {
  try {
    const text = normalizeWhitespace(deps.decryptMemoryContent(row.content_ciphertext));
    if (!text) return null;
    return {
      id: row.id,
      text,
      score,
      metadata: rowMetadata(row),
    };
  } catch {
    return null;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])\/([a-z])/g, "$1$2")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function lexicalScore(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(tokenize(text));
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

function buildFallbackPlan(input: CuratedMemorySearchInput): CuratedMemoryQueryPlan {
  const seed = normalizeWhitespace(input.configuredQuery || input.agent.task || input.goal);
  const baseQueries = uniqueStrings([
    seed,
    `${seed} product updates sprint shipped in progress blockers`,
    `${seed} customer-facing founder-style post tone`,
    `${input.goal} ${input.workflowTitle ?? ""}`,
  ], MAX_PLAN_QUERIES);
  while (baseQueries.length < MIN_PLAN_QUERIES) {
    baseQueries.push(`${seed} context ${baseQueries.length + 1}`);
  }
  return {
    intent: seed,
    outputType: "loop_run_memory_context",
    entities: [],
    dateHints: [],
    queries: baseQueries,
    requiredEvidence: ["task-relevant past work", "specific usable context"],
  };
}

function buildIntentPrompt(input: CuratedMemorySearchInput) {
  const configuredQuery = input.configuredQuery ? normalizeWhitespace(input.configuredQuery) : "";
  const priorComments = (input.priorComments ?? [])
    .slice(-4)
    .map((comment) => `${comment.author}: ${normalizeWhitespace(comment.body).slice(0, 500)}`)
    .join("\n");

  return [
    "Create a focused memory retrieval plan for a loop-run memory search.",
    "Return JSON only with keys: intent, outputType, entities, dateHints, queries, requiredEvidence.",
    `Loop goal: ${input.goal}`,
    `Workflow title: ${input.workflowTitle ?? "unknown"}`,
    `Agent name: ${input.agent.name}`,
    `Agent task: ${input.agent.task}`,
    `Agent goal: ${input.agent.goal ?? "none"}`,
    `Configured query: ${configuredQuery || "none"}`,
    `Output contract: ${input.agent.outputContract?.description ?? "none"}`,
    priorComments ? `Recent prior comments:\n${priorComments}` : "Recent prior comments: none",
    "Rules:",
    "- Generate 3 to 5 concise search queries.",
    "- Include entity names and output intent words.",
    "- Do not broaden into personal memories unless the requested output needs personal context.",
    "- Include style/tone only when the requested output explicitly needs writing style.",
  ].join("\n\n");
}

async function buildQueryPlan(
  input: CuratedMemorySearchInput,
  deps: Pick<CuratedMemorySearchDeps, "chat">,
): Promise<CuratedMemoryQueryPlan> {
  try {
    const response = await deps.chat({
      temperature: 0,
      maxTokens: 900,
      responseFormat: "json_object",
      messages: [
        {
          role: "system",
          content: "You are a precise retrieval planner. Return strict JSON and no prose.",
        },
        { role: "user", content: buildIntentPrompt(input) },
      ],
    });
    const parsed = queryPlanSchema.parse(safeJsonParse(response.text));
    const queries = uniqueStrings([
      input.configuredQuery ?? "",
      ...parsed.queries,
    ], MAX_PLAN_QUERIES);
    return {
      ...parsed,
      queries: queries.length >= MIN_PLAN_QUERIES
        ? queries
        : buildFallbackPlan(input).queries,
    };
  } catch {
    return buildFallbackPlan(input);
  }
}

async function vectorCandidates(
  auth: AuthContext,
  queries: string[],
  deps: Pick<CuratedMemorySearchDeps, "embedText" | "vectorRepository" | "memoryRepository" | "decryptMemoryContent">,
): Promise<CandidateMemory[]> {
  const bestScoreById = new Map<string, number>();
  for (const query of queries) {
    try {
      const vector = await deps.embedText(query);
      const hits = await deps.vectorRepository.searchVectors(auth, vector, VECTOR_RESULTS_PER_QUERY);
      for (const hit of hits) {
        bestScoreById.set(hit.memoryId, Math.max(bestScoreById.get(hit.memoryId) ?? 0, hit.score));
      }
    } catch {
      // Vector search is a candidate source only; lexical retrieval still covers the tool.
    }
  }

  const ids = [...bestScoreById.keys()].slice(0, MAX_CANDIDATES);
  const rows = await deps.memoryRepository.getByIds(auth, ids, false).catch(() => []);
  return rows
    .map((row) => decryptRow(row, bestScoreById.get(row.id) ?? 0, deps))
    .filter((row): row is CandidateMemory => row !== null);
}

async function lexicalCandidates(
  auth: AuthContext,
  queries: string[],
  deps: Pick<CuratedMemorySearchDeps, "memoryRepository" | "decryptMemoryContent">,
): Promise<CandidateMemory[]> {
  const rows = await deps.memoryRepository.listAll(auth, { includeSuperseded: false }).catch(() => []);
  const decrypted = rows
    .map((row) => decryptRow(row, 0, deps))
    .filter((row): row is CandidateMemory => row !== null);

  const scored: CandidateMemory[] = [];
  for (const candidate of decrypted) {
    const score = Math.max(...queries.map((query) => lexicalScore(query, candidate.text)), 0);
    if (score <= 0) continue;
    scored.push({
      ...candidate,
      score: Math.max(candidate.score, score),
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, LEXICAL_RESULTS_PER_QUERY * Math.max(1, queries.length));
}

function mergeCandidates(candidates: CandidateMemory[]): CandidateMemory[] {
  const byId = new Map<string, CandidateMemory>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    if (!existing || candidate.score > existing.score) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

function buildValidationPrompt(input: {
  run: CuratedMemorySearchInput;
  queryPlan: CuratedMemoryQueryPlan;
  candidates: CandidateMemory[];
}) {
  const candidates = input.candidates.map((candidate, index) => ({
    index: index + 1,
    id: candidate.id,
    score: candidate.score,
    metadata: {
      memory_type: candidate.metadata.memory_type,
      category: candidate.metadata.category,
      platform: candidate.metadata.platform,
      createdAt: candidate.metadata.createdAt,
    },
    text: candidate.text.slice(0, MAX_CANDIDATE_TEXT_CHARS),
  }));

  return [
    "Validate memory candidates for this loop run. Return JSON only.",
    "Accepted memories must directly help produce the expected output.",
    "Reject unrelated personal memories, stale one-off chats, broad preferences, and style-only memories unless the output explicitly requires style/tone.",
    "Use evidenceRole values only from: past_update, style, decision, project_context, constraint.",
    "Return shape: { accepted: [{ id, excerpt, reason, evidenceRole, confidence }], rejectedIds, confidence, noEvidenceReason }.",
    `Loop goal: ${input.run.goal}`,
    `Agent task: ${input.run.agent.task}`,
    `Agent output contract: ${input.run.agent.outputContract?.description ?? "none"}`,
    `Retrieval plan: ${JSON.stringify(input.queryPlan)}`,
    `Candidates: ${JSON.stringify(candidates)}`,
  ].join("\n\n");
}

async function validateCandidates(
  input: CuratedMemorySearchInput,
  queryPlan: CuratedMemoryQueryPlan,
  candidates: CandidateMemory[],
  deps: Pick<CuratedMemorySearchDeps, "chat">,
) {
  if (candidates.length === 0) {
    return validationSchema.parse({
      accepted: [],
      rejectedIds: [],
      confidence: "none",
      noEvidenceReason: "No vector or lexical candidates matched the run intent.",
    });
  }

  try {
    const response = await deps.chat({
      temperature: 0,
      maxTokens: 1600,
      responseFormat: "json_object",
      messages: [
        {
          role: "system",
          content: "You are a strict memory evidence validator. Prefer rejecting weak evidence over accepting noisy memory.",
        },
        { role: "user", content: buildValidationPrompt({ run: input, queryPlan, candidates }) },
      ],
    });
    return validationSchema.parse(safeJsonParse(response.text));
  } catch {
    return validationSchema.parse({
      accepted: [],
      rejectedIds: candidates.map((candidate) => candidate.id),
      confidence: "none",
      noEvidenceReason: "Memory validation was unavailable, so no unvalidated memories were returned.",
    });
  }
}

function confidenceFromSources(
  requested: "high" | "medium" | "low" | "none",
  sources: CuratedMemorySearchSource[],
): "high" | "medium" | "low" | "none" {
  if (sources.length === 0) return "none";
  if (requested !== "none") return requested;
  const best = Math.max(...sources.map((source) => source.confidence));
  if (best >= 0.8) return "high";
  if (best >= 0.55) return "medium";
  return "low";
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
  const queryPlan = await buildQueryPlan(input, deps);
  const queries = uniqueStrings(queryPlan.queries, MAX_PLAN_QUERIES);
  const candidates = mergeCandidates([
    ...await vectorCandidates(input.auth, queries, deps),
    ...await lexicalCandidates(input.auth, queries, deps),
  ]);
  const validation = await validateCandidates(input, queryPlan, candidates, deps);
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const sources = validation.accepted
    .map((accepted) => {
      const candidate = candidateById.get(accepted.id);
      if (!candidate || seen.has(candidate.id)) return null;
      seen.add(candidate.id);
      return {
        id: candidate.id,
        text: normalizeWhitespace(accepted.excerpt || candidate.text),
        score: candidate.score,
        confidence: accepted.confidence,
        reason: accepted.reason,
        evidenceRole: accepted.evidenceRole,
        metadata: candidate.metadata,
      };
    })
    .filter((source): source is CuratedMemorySearchSource => source !== null)
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.score - a.score;
    })
    .slice(0, MAX_ACCEPTED);

  const rejectedIds = new Set(validation.rejectedIds);
  const rejectedCount = Math.max(
    rejectedIds.size,
    candidates.length - sources.length,
  );

  return {
    queryPlan: {
      ...queryPlan,
      queries,
    },
    sources,
    rejectedCount,
    confidence: confidenceFromSources(validation.confidence, sources),
    ...(sources.length === 0
      ? { noEvidenceReason: validation.noEvidenceReason ?? "No candidate memories passed validation." }
      : {}),
  };
}
