#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const SOFT_LIMIT = Number(process.env.FILE_SIZE_SOFT_LIMIT ?? 350);
const HARD_LIMIT = Number(process.env.FILE_SIZE_HARD_LIMIT ?? 500);
const STRICT = process.argv.includes("--strict") || process.env.FILE_SIZE_STRICT === "true";

// Baseline oversized files we are actively decomposing in phases.
// Guardrail: these must not keep growing while we simplify.
const LEGACY_BASELINE = {
  "src/services/workflow-automation.ts": 2797,
  "src/transport/http/routes/chatgpt.ts": 2643,
  "src/infrastructure/db/index.ts": 2023,
  "src/infrastructure/repositories/loop-miner.repository.ts": 2011,
  "src/services/collab.ts": 1776,
  "src/transport/shared/chat-actions.ts": 1761,
  "src/orchestration/memory/chatgpt-import.usecase.ts": 1688,
  "src/services/documents.ts": 1659,
  "src/infrastructure/browser/claude-browser-worker.ts": 1525,
  "src/orchestration/loop-miner/utils.ts": 1116,
  "src/orchestration/loop-miner/loop-detector.usecase.ts": 1034,
  "src/transport/mcp/tools/index.ts": 1004,
  "src/orchestration/loop-miner/loop-miner.ts": 954,
  "src/services/orchestrator.ts": 897,
  "src/infrastructure/auth/auth.ts": 886,
  "src/transport/http/routes/memories.ts": 842,
  "src/transport/http/routes/billing.ts": 835,
  "src/services/uploaded-file-ingest-jobs.ts": 691,
  "src/orchestration/memory/chatgpt-bulk-parser.ts": 663,
  "src/orchestration/loop-miner/types.ts": 658,
  "src/services/chatgpt-import-jobs.ts": 657,
  "src/services/planner.ts": 656,
  "src/transport/http/routes/oauth.ts": 645,
  "src/infrastructure/repositories/document-search.repository.ts": 642,
  "src/infrastructure/recall/hybrid-retrieval.ts": 604,
  "src/services/memory.ts": 593,
  "src/transport/http/routes/integrations.ts": 582,
  "src/config/load.ts": 558,
  "src/transport/mcp/oauth.ts": 555,
  "src/orchestration/loop-miner/episode-embedding-map.ts": 546,
  "src/services/memory-cleanup.ts": 540,
  "src/orchestration/memory/save.usecase.ts": 517,
  "src/infrastructure/recall/fast-recall.ts": 497,
  "src/orchestration/memory/chatgpt-import-signal.usecase.ts": 494,
  "src/services/workflow-builder.ts": 484,
  "src/orchestration/loop-miner/episode-builder.usecase.ts": 482,
  "src/infrastructure/repositories/memory-cleanup.repository.ts": 479,
  "src/transport/mcp/server.ts": 473,
  "src/orchestration/browser/run-automation.usecase.ts": 433,
  "src/infrastructure/repositories/memory.repository.ts": 421,
  "src/infrastructure/repositories/loop-episode-vector.repository.ts": 384,
  "src/orchestration/memory/chatgpt-bulk-stream-ingest.ts": 383,
  "src/infrastructure/recall/bucket-recall.ts": 372,
  "src/services/workflow-automation/daily-intelligence.ts": 368,
  "src/infrastructure/browser/browser-worker.client.ts": 362,
};
const LEGACY_GROWTH_TOLERANCE = Number(process.env.LEGACY_FILE_GROWTH_TOLERANCE ?? 25);

async function collectTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTsFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    files.push(full);
  }
  return files;
}

function toRepoPath(abs) {
  return abs.slice(ROOT.length + 1).replaceAll("\\", "/");
}

async function lineCount(file) {
  const info = await stat(file);
  // Quick and cheap estimate fallback for very large files.
  // We intentionally avoid reading content to keep this check fast.
  return info.size;
}

async function exactLineCount(file) {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(file, "utf8");
  return text.split("\n").length;
}

async function main() {
  const files = await collectTsFiles(SRC_DIR);
  const warnings = [];
  const errors = [];

  for (const abs of files) {
    const rel = toRepoPath(abs);
    const approx = await lineCount(abs);
    if (approx < 8_000) continue;
    const lines = await exactLineCount(abs);

    const baseline = LEGACY_BASELINE[rel];
    if (baseline !== undefined) {
      if (lines > baseline + LEGACY_GROWTH_TOLERANCE) {
        warnings.push(`${rel}: ${lines} lines (baseline ${baseline}, tolerance +${LEGACY_GROWTH_TOLERANCE})`);
      }
      continue;
    }

    if (lines > HARD_LIMIT) {
      const message = `${rel}: ${lines} lines (hard limit ${HARD_LIMIT})`;
      if (STRICT) errors.push(message);
      else warnings.push(message);
      continue;
    }

    if (lines > SOFT_LIMIT) {
      warnings.push(`${rel}: ${lines} lines (soft limit ${SOFT_LIMIT})`);
    }
  }

  if (warnings.length > 0) {
    console.warn("[size-check] warnings:");
    for (const w of warnings) console.warn(`- ${w}`);
  } else {
    console.log("[size-check] no warnings");
  }

  if (errors.length > 0) {
    console.error("[size-check] errors:");
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[size-check] failed:", error);
  process.exit(1);
});
