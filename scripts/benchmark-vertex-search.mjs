#!/usr/bin/env node
import "dotenv/config";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function asInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeLatency(msList) {
  if (msList.length === 0) {
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  }
  const min = Math.min(...msList);
  const max = Math.max(...msList);
  const avg = msList.reduce((acc, item) => acc + item, 0) / msList.length;
  return {
    min: Number(min.toFixed(2)),
    p50: Number(percentile(msList, 50).toFixed(2)),
    p95: Number(percentile(msList, 95).toFixed(2)),
    p99: Number(percentile(msList, 99).toFixed(2)),
    max: Number(max.toFixed(2)),
    avg: Number(avg.toFixed(2)),
  };
}

const args = parseArgs(process.argv);
const baseUrl = (args.baseUrl || process.env.BENCH_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const iterations = asInt(args.iterations || process.env.BENCH_ITERATIONS, 15);
const warmup = asInt(args.warmup || process.env.BENCH_WARMUP, 2);
const tenantId = args.tenantId || process.env.BENCH_TENANT_ID;
const userId = args.userId || process.env.BENCH_USER_ID;
const message = args.message || process.env.BENCH_MESSAGE || "@doc:ketty-airbnb-cbly retrieve this document";
const internalSecret = process.env.TALLEI_HTTP__INTERNAL_API_SECRET || process.env.INTERNAL_API_SECRET;

if (!internalSecret) {
  console.error("Missing INTERNAL_API_SECRET or TALLEI_HTTP__INTERNAL_API_SECRET");
  process.exit(1);
}
if (!tenantId || !userId) {
  console.error("Missing tenant/user. Set BENCH_TENANT_ID and BENCH_USER_ID or pass --tenantId/--userId.");
  process.exit(1);
}

const url = `${baseUrl}/api/chatgpt/actions/prepare_response`;
const payload = {
  message,
  conversation_history: [{ role: "user", content: message }],
  openaiFileIdRefs: [],
};
const headers = {
  "content-type": "application/json",
  "x-internal-secret": internalSecret,
  "x-tenant-id": tenantId,
  "x-user-id": userId,
};

async function oneCall(runIndex) {
  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const elapsed = performance.now() - started;
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    run: runIndex,
    status: res.status,
    ok: res.ok,
    elapsedMs: Number(elapsed.toFixed(2)),
    inlineDocs: Array.isArray(body?.inlineDocuments) ? body.inlineDocuments.length : 0,
    matchedDocs: Array.isArray(body?.matchedDocuments) ? body.matchedDocuments.length : 0,
    referencedDocs: Array.isArray(body?.referencedDocuments) ? body.referencedDocuments.length : 0,
    hasMissingRef: Array.isArray(body?.referencedDocuments)
      ? body.referencedDocuments.some((item) => item && item.kind === "missing")
      : false,
    contextBlockLen: typeof body?.contextBlock === "string" ? body.contextBlock.length : 0,
    error: body?.error || null,
  };
}

console.log(JSON.stringify({
  event: "vertex_search_benchmark_started",
  baseUrl,
  iterations,
  warmup,
  messagePreview: message.slice(0, 120),
}, null, 2));

for (let i = 1; i <= warmup; i += 1) {
  await oneCall(`warmup-${i}`);
}

const runs = [];
for (let i = 1; i <= iterations; i += 1) {
  const result = await oneCall(i);
  runs.push(result);
  console.log(JSON.stringify(result));
}

const okRuns = runs.filter((run) => run.ok);
const latencies = okRuns.map((run) => run.elapsedMs);
const summary = {
  event: "vertex_search_benchmark_summary",
  totalRuns: runs.length,
  okRuns: okRuns.length,
  errorRuns: runs.length - okRuns.length,
  inlineDocHitRate: Number((okRuns.filter((run) => run.inlineDocs > 0).length / Math.max(1, okRuns.length)).toFixed(4)),
  matchedDocHitRate: Number((okRuns.filter((run) => run.matchedDocs > 0).length / Math.max(1, okRuns.length)).toFixed(4)),
  missingRefRate: Number((okRuns.filter((run) => run.hasMissingRef).length / Math.max(1, okRuns.length)).toFixed(4)),
  latencyMs: summarizeLatency(latencies),
};

console.log(JSON.stringify(summary, null, 2));
