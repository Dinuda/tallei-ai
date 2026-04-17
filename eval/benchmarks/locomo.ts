/**
 * LoCoMo benchmark runner.
 *
 * Dataset: 50 long-conversation dialogues with ~30 QA pairs each.
 * Metric: token-level F1 (same as LoCoMo paper).
 * Score breakdown by type: single-hop, multi-hop, temporal, adversarial.
 *
 * Usage: imported by eval/runner.ts
 */

import { randomUUID } from "crypto";
import { downloadLoCoMo, type LoCoMoDialogue } from "../datasets/download.js";
import { saveMemory, recallMemories } from "../tallei-client.js";
import { f1Score, extractAnswerFromContext } from "../metrics.js";

export interface LoCoMoResult {
  benchmark: "locomo";
  dialogues: number;
  questions: number;
  macroF1: number;
  byType: Record<string, { count: number; f1: number }>;
  avgTokensUsed: number;
  p50LatencyMs: number;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function runLoCoMo(opts: {
  maxDialogues?: number;
  verbose?: boolean;
}): Promise<LoCoMoResult> {
  const { maxDialogues = 50, verbose = false } = opts;
  console.log("[locomo] downloading dataset...");
  const dialogues = (await downloadLoCoMo()).slice(0, maxDialogues);
  console.log(`[locomo] running ${dialogues.length} dialogues`);

  const f1Scores: number[] = [];
  const byType: Record<string, { count: number; totalF1: number }> = {};
  const latencies: number[] = [];
  let totalTokens = 0;

  for (let di = 0; di < dialogues.length; di++) {
    const dialogue = dialogues[di];
    const userId = randomUUID();

    // Feed conversation turns as memories
    for (const turn of dialogue.conversations) {
      const text = `${turn.speaker}: ${turn.utterance}`;
      await saveMemory(text, userId).catch(() => {});
      await sleep(50); // gentle rate limit
    }

    // Answer each QA pair
    for (const qa of dialogue.qa) {
      const t0 = Date.now();
      const contextBlock = await recallMemories(qa.question, userId, 10);
      const latencyMs = Date.now() - t0;
      latencies.push(latencyMs);

      totalTokens += Math.ceil(contextBlock.length / 4); // rough token estimate

      const predicted = await extractAnswerFromContext(qa.question, contextBlock);
      const f1 = f1Score(predicted, qa.answer);
      f1Scores.push(f1);

      const qType = qa.type ?? "unknown";
      if (!byType[qType]) byType[qType] = { count: 0, totalF1: 0 };
      byType[qType].count++;
      byType[qType].totalF1 += f1;

      if (verbose) {
        console.log(`  [d${di} q] type=${qType} f1=${f1.toFixed(3)} pred="${predicted.slice(0, 60)}" gold="${qa.answer.slice(0, 60)}"`);
      }
    }

    if ((di + 1) % 5 === 0) {
      const partialF1 = f1Scores.reduce((a, b) => a + b, 0) / f1Scores.length;
      console.log(`[locomo] ${di + 1}/${dialogues.length} dialogues done, macro-F1=${partialF1.toFixed(3)}`);
    }
  }

  const macroF1 = f1Scores.length > 0
    ? f1Scores.reduce((a, b) => a + b, 0) / f1Scores.length
    : 0;

  const byTypeOut: Record<string, { count: number; f1: number }> = {};
  for (const [type, { count, totalF1 }] of Object.entries(byType)) {
    byTypeOut[type] = { count, f1: count > 0 ? totalF1 / count : 0 };
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const avgTokens = f1Scores.length > 0 ? Math.round(totalTokens / f1Scores.length) : 0;

  return {
    benchmark: "locomo",
    dialogues: dialogues.length,
    questions: f1Scores.length,
    macroF1,
    byType: byTypeOut,
    avgTokensUsed: avgTokens,
    p50LatencyMs: p50,
  };
}
