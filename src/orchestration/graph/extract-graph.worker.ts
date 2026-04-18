import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import type { ConversationSummary } from "../ai/summarize.usecase.js";
import { decryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { MemoryRepository } from "../../infrastructure/repositories/memory.repository.js";
import { MemoryGraphRepository } from "../../infrastructure/repositories/memory-graph.repository.js";
import { MemoryGraphJobRepository } from "../../infrastructure/repositories/memory-graph-job.repository.js";
import { extractMemoryGraph } from "./extract-graph.usecase.js";
import { buildUserSnapshot, queueSnapshotRefresh } from "./precomputed-recall.usecase.js";

const memoryRepository = new MemoryRepository();
const graphRepository = new MemoryGraphRepository();
const jobRepository = new MemoryGraphJobRepository();

let timer: NodeJS.Timeout | null = null;
let running = false;
let backfillInitialized = false;

const RETRY_DELAYS_SECONDS = [60, 300, 1200];

function parseSummary(raw: unknown): ConversationSummary {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title : "Untitled Memory";
    const keyPoints = Array.isArray(obj.keyPoints)
      ? obj.keyPoints.filter((x): x is string => typeof x === "string")
      : [];
    const decisions = Array.isArray(obj.decisions)
      ? obj.decisions.filter((x): x is string => typeof x === "string")
      : [];
    const summary = typeof obj.summary === "string" ? obj.summary : title;
    return { title, keyPoints, decisions, summary };
  }
  return {
    title: "Untitled Memory",
    keyPoints: [],
    decisions: [],
    summary: "No summary available.",
  };
}

async function processExtractOrBackfillJob(job: {
  id: string;
  tenant_id: string;
  user_id: string;
  memory_id: string | null;
  attempt_count: number;
}): Promise<void> {
  if (!job.memory_id) {
    await jobRepository.markDone(job.id);
    return;
  }

  const auth: AuthContext = {
    tenantId: job.tenant_id,
    userId: job.user_id,
    authMode: "internal",
    plan: "free",
  };

  const memory = await memoryRepository.getByIdScoped(auth, job.memory_id);
  if (!memory) {
    await jobRepository.markDone(job.id);
    return;
  }

  let memoryText = "";
  try {
    memoryText = decryptMemoryContent(memory.content_ciphertext);
  } catch {
    memoryText = "";
  }

  const summary = parseSummary(memory.summary_json);
  const extracted = await extractMemoryGraph({ memoryText, summary });

  const entityIds = new Map<string, { id: string; source: "deterministic" | "llm"; confidence: number }>();

  for (const entity of extracted.entities) {
    const row = await graphRepository.upsertEntity({
      auth,
      canonicalLabel: entity.label,
      entityType: entity.entityType,
      sourceConfidence: entity.confidence,
    });
    const key = graphRepository.normalizeLabel(entity.label);
    entityIds.set(key, { id: row.id, source: entity.source, confidence: entity.confidence });
    await graphRepository.upsertMention({
      auth,
      memoryId: memory.id,
      entityId: row.id,
      mentionText: entity.label,
      startOffset: entity.startOffset,
      endOffset: entity.endOffset,
      confidence: entity.confidence,
      extractionSource: entity.source,
    });
  }

  for (const relation of extracted.relations) {
    const sourceKey = graphRepository.normalizeLabel(relation.sourceLabel);
    const targetKey = graphRepository.normalizeLabel(relation.targetLabel);
    if (!sourceKey || !targetKey || sourceKey === targetKey) continue;

    const sourceEntity = entityIds.get(sourceKey);
    const targetEntity = entityIds.get(targetKey);

    let sourceEntityId = sourceEntity?.id;
    if (!sourceEntityId) {
      const row = await graphRepository.upsertEntity({
        auth,
        canonicalLabel: relation.sourceLabel,
        entityType: "topic",
        sourceConfidence: relation.confidenceScore,
      });
      sourceEntityId = row.id;
      entityIds.set(sourceKey, { id: row.id, source: relation.source, confidence: relation.confidenceScore });
    }

    let targetEntityId = targetEntity?.id;
    if (!targetEntityId) {
      const row = await graphRepository.upsertEntity({
        auth,
        canonicalLabel: relation.targetLabel,
        entityType: "topic",
        sourceConfidence: relation.confidenceScore,
      });
      targetEntityId = row.id;
      entityIds.set(targetKey, { id: row.id, source: relation.source, confidence: relation.confidenceScore });
    }

    await graphRepository.upsertRelation({
      auth,
      sourceEntityId,
      targetEntityId,
      relationType: relation.relationType,
      confidenceLabel: relation.confidenceLabel,
      confidenceScore: relation.confidenceScore,
      evidenceMemoryId: memory.id,
    });
  }

  await jobRepository.markDone(job.id);
  await queueSnapshotRefresh(auth, "graph_extract_done", 1_000);
}

async function processSnapshotRefreshJob(job: {
  id: string;
  tenant_id: string;
  user_id: string;
}): Promise<void> {
  const auth: AuthContext = {
    tenantId: job.tenant_id,
    userId: job.user_id,
    authMode: "internal",
    plan: "free",
  };
  const built = await buildUserSnapshot(auth);
  await memoryRepository.logEvent({
    auth,
    action: "snapshot_refresh",
    metadata: {
      source: "worker",
      snapshot_build_ms: built.snapshot_build_ms,
      source_window: built.snapshot.source_window,
      version: built.snapshot.version,
    },
  });
  await jobRepository.markDone(job.id);
}

async function processJob(job: {
  id: string;
  tenant_id: string;
  user_id: string;
  memory_id: string | null;
  job_type: "extract" | "backfill" | "snapshot_refresh";
  attempt_count: number;
}): Promise<void> {
  if (job.job_type === "snapshot_refresh") {
    await processSnapshotRefreshJob(job);
    return;
  }
  await processExtractOrBackfillJob(job);
}

async function runTick(): Promise<void> {
  if (!config.graphExtractionEnabled) return;
  if (running) return;
  running = true;
  try {
    if (!backfillInitialized) {
      backfillInitialized = true;
      const inserted = await jobRepository.enqueueBackfillForAllActiveMemories(10_000);
      if (config.nodeEnv !== "production") {
        console.log(`[graph] seeded backfill jobs: ${inserted}`);
      }
    }

    // Drain queue batches in one tick so follow-up jobs (e.g. snapshot_refresh)
    // created by extract/backfill are also processed without waiting.
    for (;;) {
      const jobs = await jobRepository.claimJobs(config.memoryGraphWorkerBatchSize);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        try {
          await processJob(job);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown_graph_worker_error";
          const retryIndex = Math.max(0, Math.min(job.attempt_count - 1, RETRY_DELAYS_SECONDS.length - 1));
          const shouldFail = job.attempt_count >= RETRY_DELAYS_SECONDS.length + 1;
          if (shouldFail) {
            await jobRepository.markFailed(job.id, "worker_error", message);
          } else {
            await jobRepository.markRetry(job.id, RETRY_DELAYS_SECONDS[retryIndex], "worker_error", message);
          }
        }
      }
    }
  } finally {
    running = false;
  }
}

export function startMemoryGraphWorker(): void {
  if (!config.graphExtractionEnabled) return;
  if (timer) return;

  void runTick();
  timer = setInterval(() => {
    void runTick();
  }, Math.max(500, config.memoryGraphWorkerPollMs));
  timer.unref();
}

export function stopMemoryGraphWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  running = false;
  backfillInitialized = false;
}
