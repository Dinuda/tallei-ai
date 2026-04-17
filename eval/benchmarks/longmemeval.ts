/**
 * LongMemEval benchmark runner.
 *
 * Dataset: 500 questions across multi-session chat histories.
 * Uses the "short" (longmemeval_s) variant (~10-50 sessions per history).
 * Metric: LLM judge (GPT-4o-mini), 0-1 per question.
 * Breakdown by: info-extraction, multi-session, temporal, knowledge-update, abstention.
 */

import { randomUUID } from "crypto";
import { downloadLongMemEval, type LongMemEvalItem } from "../datasets/download.js";
import { saveMemory, recallMemories } from "../tallei-client.js";
import { llmJudge, extractAnswerFromContext } from "../metrics.js";

export interface LongMemEvalResult {
  benchmark: "longmemeval";
  questions: number;
  accuracy: number;
  byType: Record<string, { count: number; accuracy: number }>;
  avgTokensUsed: number;
  p50LatencyMs: number;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function runLongMemEval(opts: {
  maxItems?: number;
  verbose?: boolean;
}): Promise<LongMemEvalResult> {
  const { maxItems = 500, verbose = false } = opts;
  console.log("[longmemeval] downloading dataset...");
  const items = (await downloadLongMemEval()).slice(0, maxItems);
  console.log(`[longmemeval] running ${items.length} questions`);

  const scores: number[] = [];
  const byType: Record<string, { count: number; total: number }> = {};
  const latencies: number[] = [];
  let totalTokens = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const userId = randomUUID();

    // Save all sessions as memories
    for (let si = 0; si < item.sessions.length; si++) {
      const session = item.sessions[si];
      const sessionText = session
        .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
        .join("\n");
      await saveMemory(`[Session ${si + 1}]\n${sessionText}`, userId).catch(() => {});
      await sleep(30);
    }

    // Query
    const t0 = Date.now();
    const contextBlock = await recallMemories(item.question, userId, 10);
    const latencyMs = Date.now() - t0;
    latencies.push(latencyMs);

    totalTokens += Math.ceil(contextBlock.length / 4);

    const predicted = await extractAnswerFromContext(item.question, contextBlock);
    const score = await llmJudge(item.question, predicted, item.answer);
    scores.push(score);

    const qType = item.question_type ?? "unknown";
    if (!byType[qType]) byType[qType] = { count: 0, total: 0 };
    byType[qType].count++;
    byType[qType].total += score;

    if (verbose) {
      console.log(`  [q${i}] type=${qType} score=${score.toFixed(2)} pred="${predicted.slice(0, 60)}" gold="${item.answer.slice(0, 60)}"`);
    }

    if ((i + 1) % 25 === 0) {
      const partialAcc = scores.reduce((a, b) => a + b, 0) / scores.length;
      console.log(`[longmemeval] ${i + 1}/${items.length} done, accuracy=${partialAcc.toFixed(3)}`);
    }
  }

  const accuracy = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  const byTypeOut: Record<string, { count: number; accuracy: number }> = {};
  for (const [type, { count, total }] of Object.entries(byType)) {
    byTypeOut[type] = { count, accuracy: count > 0 ? total / count : 0 };
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const avgTokens = scores.length > 0 ? Math.round(totalTokens / scores.length) : 0;

  return {
    benchmark: "longmemeval",
    questions: scores.length,
    accuracy,
    byType: byTypeOut,
    avgTokensUsed: avgTokens,
    p50LatencyMs: p50,
  };
}
