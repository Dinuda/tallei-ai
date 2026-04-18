#!/usr/bin/env tsx
/**
 * Tallei memory eval runner.
 *
 * Requires a running Tallei server with EVAL_MODE=true.
 *
 * Usage:
 *   npx tsx eval/runner.ts --benchmark locomo
 *   npx tsx eval/runner.ts --benchmark longmemeval
 *   npx tsx eval/runner.ts --benchmark beam --scale 1m
 *   npx tsx eval/runner.ts --benchmark beam --scale 10m
 *   npx tsx eval/runner.ts --all
 *
 * Environment:
 *   TALLEI_EVAL_URL   MCP endpoint (default: http://localhost:3000/mcp)
 *   EVAL_USER_ID      Existing user UUID in the local DB (required)
 *   OPENAI_API_KEY    Required for LLM judge scoring
 *   EVAL_MAX_ITEMS    Cap items per benchmark (useful for quick smoke tests)
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runLoCoMo } from "./benchmarks/locomo.js";
import { runLongMemEval } from "./benchmarks/longmemeval.js";
import { runBeam } from "./benchmarks/beam.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string): string | null => {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
};
const hasFlag = (flag: string) => args.includes(flag);

const benchmarkArg = getArg("--benchmark");
const scaleArg = (getArg("--scale") ?? "1m") as "1m" | "10m";
const runAll = hasFlag("--all");
const verbose = hasFlag("--verbose") || hasFlag("-v");
const maxItems = process.env["EVAL_MAX_ITEMS"] ? parseInt(process.env["EVAL_MAX_ITEMS"], 10) : undefined;

// ─── Result persistence ───────────────────────────────────────────────────────

function saveResult(name: string, result: unknown): void {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().split("T")[0];
  const file = join(RESULTS_DIR, `${date}-${name}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`[runner] result saved to ${file}`);
}

// ─── Summary table ────────────────────────────────────────────────────────────

function printSummaryTable(
  rows: Array<{ benchmark: string; score: number; tokens: number; p50Ms: number }>
): void {
  console.log("\n╔══════════════════╦═══════╦══════════╦═════════════╗");
  console.log("║ Benchmark        ║ Score ║ Tokens   ║ Latency p50 ║");
  console.log("╠══════════════════╬═══════╬══════════╬═════════════╣");
  for (const row of rows) {
    const bench = row.benchmark.padEnd(16);
    const score = (row.score * 100).toFixed(1).padStart(5);
    const tokens = `${(row.tokens / 1000).toFixed(1)}K`.padStart(8);
    const latency = `${(row.p50Ms / 1000).toFixed(2)}s`.padStart(11);
    console.log(`║ ${bench} ║ ${score} ║ ${tokens} ║ ${latency} ║`);
  }
  console.log("╚══════════════════╩═══════╩══════════╩═════════════╝");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!benchmarkArg && !runAll) {
    console.error("Usage: npx tsx eval/runner.ts --benchmark <locomo|longmemeval|beam> [--scale 1m|10m] [--all] [-v]");
    process.exit(1);
  }

  const summaryRows: Array<{ benchmark: string; score: number; tokens: number; p50Ms: number }> = [];

  const runLocomo = runAll || benchmarkArg === "locomo";
  const runLongMem = runAll || benchmarkArg === "longmemeval";
  const runBeamBench = runAll || benchmarkArg === "beam";

  if (runLocomo) {
    console.log("\n═══ LoCoMo ═══");
    const result = await runLoCoMo({ maxDialogues: maxItems ?? 50, verbose });
    saveResult("locomo", result);
    console.log(`[locomo] macro-F1: ${(result.macroF1 * 100).toFixed(1)}`);
    summaryRows.push({
      benchmark: "LoCoMo",
      score: result.macroF1,
      tokens: result.avgTokensUsed,
      p50Ms: result.p50LatencyMs,
    });
  }

  if (runLongMem) {
    console.log("\n═══ LongMemEval ═══");
    const result = await runLongMemEval({ maxItems: maxItems ?? 500, verbose });
    saveResult("longmemeval", result);
    console.log(`[longmemeval] accuracy: ${(result.accuracy * 100).toFixed(1)}`);
    summaryRows.push({
      benchmark: "LongMemEval",
      score: result.accuracy,
      tokens: result.avgTokensUsed,
      p50Ms: result.p50LatencyMs,
    });
  }

  if (runBeamBench) {
    console.log(`\n═══ BEAM (${scaleArg}) ═══`);
    const result = await runBeam({ scale: scaleArg, maxConversations: maxItems ?? 100, verbose });
    saveResult(`beam-${scaleArg}`, result);
    console.log(`[beam-${scaleArg}] overall score: ${(result.overallScore * 100).toFixed(1)}`);
    summaryRows.push({
      benchmark: `BEAM (${scaleArg})`,
      score: result.overallScore,
      tokens: result.avgTokensUsed,
      p50Ms: result.p50LatencyMs,
    });
  }

  if (summaryRows.length > 0) {
    printSummaryTable(summaryRows);
  }
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
