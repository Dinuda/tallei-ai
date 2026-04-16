/**
 * LLM-based reranker for recall results.
 *
 * After a bi-encoder vector search retrieves candidates, this runs a single
 * gpt-4o-mini call that sees both the query and every candidate together —
 * the same "cross-encoder" pattern used by Cohere Rerank / BGE reranker.
 *
 * Why this works where threshold alone doesn't:
 *   Bi-encoders embed query and document independently, so "favorite ice cream"
 *   and "favorite programming language" score high just because they share the
 *   "favorite X preference" concept.  A cross-encoder reads them *together* and
 *   can tell that asking about food preferences is unrelated to coding preferences.
 */

import OpenAI from "openai";
import { config } from "../config.js";

const openai = new OpenAI({ apiKey: config.openaiApiKey });

export interface RerankCandidate {
  id: string;
  text: string;
  score: number; // original vector score
  metadata: Record<string, unknown>;
}

export interface RerankResult extends RerankCandidate {
  rerankScore: number; // 0–1 LLM relevance score
}

const RERANKER_SYSTEM = `You are a relevance judge for a personal memory system.
Given a user query and a numbered list of memory snippets, output ONLY a JSON array of numbers (0–10) — one score per memory, in the same order.
Score 10 = highly relevant, directly answers the query.
Score 5  = tangentially related (same broad topic).
Score 0  = completely unrelated.
No explanation. No keys. Just the array, e.g. [8, 0, 3].`;

export interface RagCandidate {
  id: string;
  text: string;
  platform: string;
  createdAt: string;
}

export interface RagResult {
  id: string;
  text: string;
  platform: string;
  createdAt: string;
  score: number; // 0–1 relevance score assigned by LLM
}

const RAG_SYSTEM = `You are a relevance judge for a personal memory system.
Given a user query and a numbered list of ALL memories the user has stored, identify which ones are relevant to the query.
For each memory, output a relevance score 0–10.
Score 10 = directly answers the query. Score 5 = related context. Score 0 = completely unrelated.
Output ONLY a JSON array of numbers in the same order as the input, e.g. [0, 9, 2, 0].
No keys. No explanation. Just the array.`;

/**
 * Full-scan RAG search: loads every memory and asks gpt-4o-mini which ones are
 * relevant to the query. Used as a last-resort fallback when vector search +
 * threshold filtering returns nothing (stale index, missing embeddings, etc.).
 */
export async function ragSearchMemories(
  query: string,
  candidates: RagCandidate[],
  minScore = 0.4
): Promise<RagResult[]> {
  if (candidates.length === 0) return [];

  const memoriesBlock = candidates
    .map((c, i) => `${i}: ${c.text.slice(0, 400)}`)
    .join("\n\n");

  const userMessage = `Query: "${query}"\n\nAll stored memories:\n${memoriesBlock}`;

  let raw: string;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: RAG_SYSTEM },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      max_tokens: candidates.length * 4 + 16,
    });
    raw = response.choices[0]?.message?.content?.trim() ?? "[]";
  } catch (error) {
    console.warn("[rag] LLM call failed", error);
    return [];
  }

  let scores: number[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    scores = parsed.map((s) => {
      const n = Number(s);
      return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) / 10 : 0;
    });
  } catch {
    console.warn("[rag] failed to parse scores, raw:", raw);
    return [];
  }

  return candidates
    .map((c, i) => ({ ...c, score: scores[i] ?? 0 }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

export async function rerankMemories(
  query: string,
  candidates: RerankCandidate[]
): Promise<RerankResult[]> {
  if (candidates.length === 0) return [];

  const memoriesBlock = candidates
    .map((c, i) => `${i}: ${c.text.slice(0, 400)}`)
    .join("\n\n");

  const userMessage = `Query: "${query}"\n\nMemories:\n${memoriesBlock}`;

  let raw: string;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: RERANKER_SYSTEM },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      max_tokens: 64,
    });
    raw = response.choices[0]?.message?.content?.trim() ?? "[]";
  } catch (error) {
    // Reranker is best-effort — fall back to original ordering on failure.
    console.warn("[reranker] LLM call failed, skipping rerank", error);
    return candidates.map((c) => ({ ...c, rerankScore: c.score }));
  }

  let scores: number[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    scores = parsed.map((s) => {
      const n = Number(s);
      return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) / 10 : 0;
    });
  } catch {
    console.warn("[reranker] failed to parse scores, raw response:", raw);
    return candidates.map((c) => ({ ...c, rerankScore: c.score }));
  }

  return candidates.map((candidate, i) => ({
    ...candidate,
    rerankScore: scores[i] ?? 0,
  }));
}
