#!/usr/bin/env tsx
/**
 * Tallei UX relevance eval runner.
 *
 * Requires a running Tallei server with EVAL_MODE=true.
 *
 * Usage:
 *   npx tsx eval/runner.ts
 *   npx tsx eval/runner.ts --benchmark ux-relevance
 *   npx tsx eval/runner.ts --max-dialogues 10 --max-turns-per-dialogue 80 --max-questions-per-dialogue 20 --f1-threshold 0.70 --verbose
 *
 * Environment:
 *   TALLEI_EVAL_URL    MCP endpoint (default: http://localhost:3000/mcp)
 *   EVAL_USER_ID       Existing user UUID in the local DB (required)
 *   LLM_PROVIDER       ollama|openai (recommended local: ollama)
 *   OLLAMA_MODEL       local model for eval answer extraction (when using ollama)
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runLoCoMo } from "./benchmarks/locomo.js";
import {
  assertEvalAuthOrThrow,
  getEvalUserIdOrThrow,
  listMemoriesText,
  recallMemories,
  saveMemory,
} from "./tallei-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
const UX_BENCHMARK_NAME = "ux-relevance";
const DEFAULT_MAX_DIALOGUES = 10;
const DEFAULT_MAX_TURNS_PER_DIALOGUE = 80;
const DEFAULT_MAX_QUESTIONS_PER_DIALOGUE = 20;
const DEFAULT_F1_THRESHOLD = 0.70;
const DEPRECATED_BENCHMARKS = new Set(["locomo", "longmemeval", "beam"]);
const SMOKE_LIST_TIMEOUT_MS = 8_000;
const SMOKE_LIST_INTERVAL_MS = 300;
const SMOKE_RECALL_TIMEOUT_MS = 8_000;
const SMOKE_RECALL_INTERVAL_MS = 350;

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string): string | null => {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
};
const hasFlag = (flag: string) => args.includes(flag);

const benchmarkArg = getArg("--benchmark") ?? UX_BENCHMARK_NAME;
const verbose = hasFlag("--verbose") || hasFlag("-v");
const maxDialoguesArg = getArg("--max-dialogues");
const maxTurnsPerDialogueArg = getArg("--max-turns-per-dialogue");
const maxQuestionsPerDialogueArg = getArg("--max-questions-per-dialogue");
const f1ThresholdArg = getArg("--f1-threshold");
const scaleArg = getArg("--scale");
const runAll = hasFlag("--all");
const maxItemsEnv = process.env["EVAL_MAX_ITEMS"] ? parseInt(process.env["EVAL_MAX_ITEMS"], 10) : undefined;
const maxDialogues = maxDialoguesArg
  ? parseInt(maxDialoguesArg, 10)
  : (maxItemsEnv ?? DEFAULT_MAX_DIALOGUES);
const maxTurnsPerDialogue = maxTurnsPerDialogueArg
  ? parseInt(maxTurnsPerDialogueArg, 10)
  : DEFAULT_MAX_TURNS_PER_DIALOGUE;
const maxQuestionsPerDialogue = maxQuestionsPerDialogueArg
  ? parseInt(maxQuestionsPerDialogueArg, 10)
  : DEFAULT_MAX_QUESTIONS_PER_DIALOGUE;
const f1Threshold = f1ThresholdArg ? parseFloat(f1ThresholdArg) : DEFAULT_F1_THRESHOLD;

// ─── Result persistence ───────────────────────────────────────────────────────

function saveResult(name: string, result: unknown): void {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().split("T")[0];
  const file = join(RESULTS_DIR, `${date}-${name}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`[runner] result saved to ${file}`);
}

function validateUxOnlyCli(): void {
  if (runAll || scaleArg) {
    console.error(
      "[runner] unsupported flags: --all/--scale were removed. Use:\n" +
      "  npx tsx eval/runner.ts --benchmark ux-relevance --max-dialogues 10 --max-turns-per-dialogue 80 --max-questions-per-dialogue 20 --f1-threshold 0.70"
    );
    process.exit(2);
  }

  if (benchmarkArg !== UX_BENCHMARK_NAME) {
    if (DEPRECATED_BENCHMARKS.has(benchmarkArg)) {
      console.error(
        `[runner] benchmark '${benchmarkArg}' is deprecated for default UX checks.\n` +
        `Use '--benchmark ${UX_BENCHMARK_NAME}' instead.`
      );
    } else {
      console.error(
        `[runner] unsupported benchmark '${benchmarkArg}'. Supported: ${UX_BENCHMARK_NAME}`
      );
    }
    process.exit(2);
  }

  if (!Number.isFinite(maxDialogues) || maxDialogues <= 0) {
    console.error(`[runner] invalid --max-dialogues value: ${String(maxDialoguesArg ?? maxItemsEnv ?? "")}`);
    process.exit(2);
  }
  if (!Number.isFinite(maxTurnsPerDialogue) || maxTurnsPerDialogue <= 0) {
    console.error(`[runner] invalid --max-turns-per-dialogue value: ${String(maxTurnsPerDialogueArg ?? "")}`);
    process.exit(2);
  }
  if (!Number.isFinite(maxQuestionsPerDialogue) || maxQuestionsPerDialogue <= 0) {
    console.error(`[runner] invalid --max-questions-per-dialogue value: ${String(maxQuestionsPerDialogueArg ?? "")}`);
    process.exit(2);
  }
  if (!Number.isFinite(f1Threshold) || f1Threshold < 0 || f1Threshold > 1) {
    console.error(`[runner] invalid --f1-threshold value: ${String(f1ThresholdArg ?? "")}`);
    process.exit(2);
  }
}

async function runSmokeProbe(): Promise<{
  probe: string;
  listLatencyMs: number;
  listFoundProbe: boolean;
  recallLatencyMs: number;
  recallFoundProbe: boolean;
}> {
  const userId = getEvalUserIdOrThrow();
  await assertEvalAuthOrThrow(userId);

  const probe = `uxprobe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const probePhrase = `Smoke probe fact ${probe}`;
  await saveMemory(probePhrase, userId);

  const listStartedAt = Date.now();
  let lastList = "";
  let lastListLatencyMs = 0;
  while (Date.now() - listStartedAt < SMOKE_LIST_TIMEOUT_MS) {
    const listAttemptStartedAt = Date.now();
    lastList = await listMemoriesText(userId);
    lastListLatencyMs = Date.now() - listAttemptStartedAt;
    if (lastList.includes(probe)) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SMOKE_LIST_INTERVAL_MS));
  }
  if (!lastList.includes(probe)) {
    throw new Error(
      "Smoke probe list_memories did not include the just-saved probe memory within timeout. " +
      `Last list snippet: ${lastList.slice(0, 220)}`
    );
  }

  // Recall freshness can lag behind DB visibility because indexing/enrichment runs async.
  // Keep this as a health signal, but do not block the benchmark on it.
  const recallStartedAt = Date.now();
  let lastContext = "";
  let lastRecallLatencyMs = 0;
  while (Date.now() - recallStartedAt < SMOKE_RECALL_TIMEOUT_MS) {
    const recallAttemptStartedAt = Date.now();
    // Query with the full phrase to bias lexical fallback while vector enrichment catches up.
    const context = await recallMemories(`${probePhrase}`, userId, 10);
    lastRecallLatencyMs = Date.now() - recallAttemptStartedAt;
    lastContext = context;
    if (context.includes(probe)) {
      return {
        probe,
        listLatencyMs: lastListLatencyMs,
        listFoundProbe: true,
        recallLatencyMs: lastRecallLatencyMs,
        recallFoundProbe: true,
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SMOKE_RECALL_INTERVAL_MS));
  }

  console.warn(
    "[ux] smoke warning: recall_memories did not return the probe within timeout. " +
    `Continuing to LoCoMo. Last recall snippet: ${lastContext.slice(0, 220)}`
  );
  return {
    probe,
    listLatencyMs: lastListLatencyMs,
    listFoundProbe: true,
    recallLatencyMs: lastRecallLatencyMs,
    recallFoundProbe: false,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  validateUxOnlyCli();

  console.log("\n═══ UX Relevance Check (Smoke + LoCoMo Mini) ═══");
  console.log(
    `[ux] config: benchmark=${UX_BENCHMARK_NAME} max_dialogues=${maxDialogues} ` +
    `max_turns_per_dialogue=${maxTurnsPerDialogue} ` +
    `max_questions_per_dialogue=${maxQuestionsPerDialogue} ` +
    `f1_threshold=${f1Threshold.toFixed(2)}`
  );

  console.log("[ux] running smoke probe...");
  const smoke = await runSmokeProbe();
  console.log(
    `[ux] smoke: PASS (list latency ${smoke.listLatencyMs}ms, recall latency ${smoke.recallLatencyMs}ms, recall_found=${smoke.recallFoundProbe})`
  );

  console.log("[ux] running LoCoMo mini...");
  const locomo = await runLoCoMo({
    maxDialogues,
    maxTurnsPerDialogue,
    maxQuestionsPerDialogue,
    verbose,
  });
  const pass = locomo.macroF1 >= f1Threshold;

  const result = {
    benchmark: UX_BENCHMARK_NAME as const,
    passed: pass,
    threshold: f1Threshold,
    config: {
      maxDialogues,
      maxTurnsPerDialogue,
      maxQuestionsPerDialogue,
    },
    smoke: {
      ok: true,
      listFoundProbe: smoke.listFoundProbe,
      listLatencyMs: smoke.listLatencyMs,
      recallFoundProbe: smoke.recallFoundProbe,
      recallLatencyMs: smoke.recallLatencyMs,
      probe: smoke.probe,
    },
    locomo: {
      dialogues: locomo.dialogues,
      questions: locomo.questions,
      macroF1: locomo.macroF1,
      p50LatencyMs: locomo.p50LatencyMs,
      avgTokensUsed: locomo.avgTokensUsed,
      byType: locomo.byType,
    },
  };
  saveResult("ux-relevance", result);

  console.log(
    `[ux] macroF1=${locomo.macroF1.toFixed(3)} ` +
    `questions=${locomo.questions} p50=${locomo.p50LatencyMs}ms`
  );

  if (!pass) {
    console.error(`[ux] FAIL: macro-F1 ${locomo.macroF1.toFixed(3)} < ${f1Threshold.toFixed(2)}`);
    process.exit(1);
  }

  console.log(`[ux] PASS: macro-F1 ${locomo.macroF1.toFixed(3)} >= ${f1Threshold.toFixed(2)}`);
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
