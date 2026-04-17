/**
 * Scoring utilities for LoCoMo, LongMemEval, and BEAM benchmarks.
 */

import OpenAI from "openai";

let _openai: OpenAI | null = null;
function openai(): OpenAI {
  if (!_openai) {
    const provider = process.env["LLM_PROVIDER"] ?? "openai";
    _openai = provider === "ollama"
      ? new OpenAI({ baseURL: process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1", apiKey: "ollama" })
      : new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
  }
  return _openai;
}

// ─── Token-level F1 (LoCoMo) ─────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function f1Score(predicted: string, gold: string): number {
  const predTokens = tokenize(predicted);
  const goldTokens = tokenize(gold);
  if (predTokens.length === 0 || goldTokens.length === 0) {
    return predTokens.length === goldTokens.length ? 1.0 : 0.0;
  }
  const predSet = new Map<string, number>();
  for (const t of predTokens) predSet.set(t, (predSet.get(t) ?? 0) + 1);
  const goldSet = new Map<string, number>();
  for (const t of goldTokens) goldSet.set(t, (goldSet.get(t) ?? 0) + 1);

  let common = 0;
  for (const [t, cnt] of predSet) {
    common += Math.min(cnt, goldSet.get(t) ?? 0);
  }
  if (common === 0) return 0;
  const precision = common / predTokens.length;
  const recall = common / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

export function exactMatch(predicted: string, gold: string): boolean {
  return tokenize(predicted).join(" ") === tokenize(gold).join(" ");
}

// ─── LLM judge (LongMemEval) ─────────────────────────────────────────────────

export async function llmJudge(
  question: string,
  predicted: string,
  gold: string
): Promise<number> {
  const prompt = `Question: ${question}
Gold answer: ${gold}
Predicted answer: ${predicted}

Score the predicted answer from 0.0 to 1.0, where:
1.0 = fully correct and complete
0.5 = partially correct, key facts present but incomplete or imprecise
0.0 = wrong or no relevant content

Return ONLY a number between 0.0 and 1.0.`;

  try {
    const res = await openai().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 8,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.choices[0]?.message?.content?.trim() ?? "0";
    const score = parseFloat(text);
    return isNaN(score) ? 0 : Math.max(0, Math.min(1, score));
  } catch {
    return 0;
  }
}

// ─── Nugget-based scoring (BEAM) ─────────────────────────────────────────────

export async function nuggetScore(
  predicted: string,
  nuggets: string[]
): Promise<number> {
  if (nuggets.length === 0) return 0;

  const nuggetsJson = JSON.stringify(nuggets);
  const prompt = `Predicted answer: ${predicted}

Atomic facts (nuggets) to check:
${nuggetsJson}

For each nugget, return a score:
1.0 = fully satisfied
0.5 = partially satisfied
0.0 = not satisfied

Return ONLY a JSON array of numbers, one per nugget. Example: [1.0, 0.5, 0.0]`;

  try {
    const res = await openai().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: nuggets.length * 8 + 16,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.choices[0]?.message?.content?.trim() ?? "[]";
    const scores = JSON.parse(text) as number[];
    if (!Array.isArray(scores)) return 0;
    const valid = scores.slice(0, nuggets.length).map((s) => Math.max(0, Math.min(1, Number(s) || 0)));
    return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  } catch {
    return 0;
  }
}

// ─── Kendall tau-b for event ordering (BEAM) ─────────────────────────────────

export function kendallTauB(predicted: string[], gold: string[]): number {
  const n = gold.length;
  if (n < 2) return 1;
  const goldIdx = new Map(gold.map((id, i) => [id, i]));
  const predIdx = new Map(predicted.map((id, i) => [id, i]));

  let concordant = 0;
  let discordant = 0;
  let tied = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const gi = goldIdx.get(gold[i]) ?? 0;
      const gj = goldIdx.get(gold[j]) ?? 0;
      const pi = predIdx.get(gold[i]);
      const pj = predIdx.get(gold[j]);
      if (pi === undefined || pj === undefined) { tied++; continue; }
      const goldSign = Math.sign(gj - gi);
      const predSign = Math.sign(pj - pi);
      if (goldSign === predSign) concordant++;
      else if (predSign === 0) tied++;
      else discordant++;
    }
  }

  const total = concordant + discordant + tied;
  if (total === 0) return 1;
  return (concordant - discordant) / Math.sqrt((concordant + discordant + tied) * (concordant + discordant));
}

// ─── Extract short answer from context block ─────────────────────────────────

export async function extractAnswerFromContext(
  question: string,
  contextBlock: string
): Promise<string> {
  const prompt = `Context:
${contextBlock}

Question: ${question}

Answer concisely in 1-2 sentences using only information from the context. If the answer is not in the context, respond with "not found".`;

  try {
    const res = await openai().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }],
    });
    return res.choices[0]?.message?.content?.trim() ?? "not found";
  } catch {
    return "not found";
  }
}
