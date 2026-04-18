/**
 * BEAM benchmark runner (Beyond a Million Tokens).
 *
 * Dataset: 100 conversations, ~2000 questions at 1M token scale (or 10M).
 * Metrics:
 *   - Most categories: nugget-based scoring via GPT-4o-mini judge
 *   - Event ordering: Kendall tau-b coefficient
 * Breakdown by: abstention, contradiction_resolution, event_ordering,
 *   information_extraction, instruction_following, knowledge_updates,
 *   multi_hop_reasoning, preference_following, summarization, temporal_reasoning
 */

import { randomUUID } from "crypto";
import { downloadBeam, type BeamConversation } from "../datasets/download.js";
import {
  saveMemory,
  recallMemories,
  getEvalUserIdOrThrow,
  assertEvalAuthOrThrow,
} from "../tallei-client.js";
import { nuggetScore, kendallTauB, extractAnswerFromContext } from "../metrics.js";

export interface BeamResult {
  benchmark: "beam";
  scale: "1m" | "10m";
  conversations: number;
  questions: number;
  overallScore: number;
  byType: Record<string, { count: number; score: number }>;
  avgTokensUsed: number;
  p50LatencyMs: number;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function runBeam(opts: {
  scale?: "1m" | "10m";
  maxConversations?: number;
  verbose?: boolean;
}): Promise<BeamResult> {
  const { scale = "1m", maxConversations = 100, verbose = false } = opts;
  console.log(`[beam] downloading dataset (${scale})...`);
  const conversations = (await downloadBeam(scale)).slice(0, maxConversations);
  console.log(`[beam] running ${conversations.length} conversations`);
  const evalUserId = getEvalUserIdOrThrow();
  await assertEvalAuthOrThrow(evalUserId);

  const allScores: number[] = [];
  const byType: Record<string, { count: number; total: number }> = {};
  const latencies: number[] = [];
  let totalTokens = 0;

  for (let ci = 0; ci < conversations.length; ci++) {
    const conv = conversations[ci];
    const scopeId = `beam-${scale}-${ci + 1}-${randomUUID().slice(0, 8)}`;
    const scopePrefix = `[eval_scope:${scopeId}]`;

    // Save all conversation turns
    const batchSize = 20;
    for (let ti = 0; ti < conv.turns.length; ti += batchSize) {
      const batch = conv.turns.slice(ti, ti + batchSize);
      const batchText = batch
        .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
        .join("\n");
      await saveMemory(`${scopePrefix}\n${batchText}`, evalUserId);
      await sleep(30);
    }

    // Answer each question
    for (const q of conv.questions) {
      const t0 = Date.now();
      const contextBlock = await recallMemories(`${scopePrefix} ${q.question}`, evalUserId, 10);
      const latencyMs = Date.now() - t0;
      latencies.push(latencyMs);

      totalTokens += Math.ceil(contextBlock.length / 4);

      let score = 0;

      if (q.question_type === "event_ordering" && q.gold_event_order) {
        // Use Kendall tau-b for ordering questions
        const predicted = await extractAnswerFromContext(q.question, contextBlock);
        const predictedIds = predicted.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
        score = Math.max(0, (kendallTauB(predictedIds, q.gold_event_order) + 1) / 2);
      } else if (q.nuggets && q.nuggets.length > 0) {
        const predicted = await extractAnswerFromContext(q.question, contextBlock);
        score = await nuggetScore(predicted, q.nuggets.map((n) => n.text));
      } else {
        // Fallback: use extractAnswerFromContext + nugget on answer string
        const predicted = await extractAnswerFromContext(q.question, contextBlock);
        score = await nuggetScore(predicted, [q.answer]);
      }

      allScores.push(score);

      const qType = q.question_type ?? "unknown";
      if (!byType[qType]) byType[qType] = { count: 0, total: 0 };
      byType[qType].count++;
      byType[qType].total += score;

      if (verbose) {
        console.log(`  [c${ci} q] type=${qType} score=${score.toFixed(2)}`);
      }
    }

    if ((ci + 1) % 10 === 0) {
      const partial = allScores.reduce((a, b) => a + b, 0) / allScores.length;
      console.log(`[beam] ${ci + 1}/${conversations.length} conversations done, score=${partial.toFixed(3)}`);
    }
  }

  const overallScore = allScores.length > 0
    ? allScores.reduce((a, b) => a + b, 0) / allScores.length
    : 0;

  const byTypeOut: Record<string, { count: number; score: number }> = {};
  for (const [type, { count, total }] of Object.entries(byType)) {
    byTypeOut[type] = { count, score: count > 0 ? total / count : 0 };
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const avgTokens = allScores.length > 0 ? Math.round(totalTokens / allScores.length) : 0;

  return {
    benchmark: "beam",
    scale,
    conversations: conversations.length,
    questions: allScores.length,
    overallScore,
    byType: byTypeOut,
    avgTokensUsed: avgTokens,
    p50LatencyMs: p50,
  };
}
