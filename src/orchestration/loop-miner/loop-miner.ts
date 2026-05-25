import type { AuthContext } from "../../domain/auth/index.js";

import { createHash } from "crypto";
import { config } from "../../config/index.js";
import { embedText } from "../../infrastructure/cache/embedding-cache.js";
import { sendAdminSlackMessage } from "../../infrastructure/notifications/admin-slack.js";
import {
  LoopEpisodeGroupedResult,
  LoopEpisodeVectorRepository,
} from "../../infrastructure/repositories/loop-episode-vector.repository.js";
import { LoopMinerRepository as PgLoopMinerRepository } from "../../infrastructure/repositories/loop-miner.repository.js";
import { pool } from "../../infrastructure/db/index.js";
import { createLogger } from "../../observability/index.js";
import { aiProviderRegistry, isRetriableProviderError } from "../../providers/ai/index.js";
import { CircuitOpenError } from "../../shared/errors/provider-errors.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import { withTimeout } from "../../resilience/timeout.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage } from "../memory-cleanup/usage.js";
import { DnaGeneratorUseCase } from "./dna-generator.usecase.js";
import { EpisodeBuilderUseCase } from "./episode-builder.usecase.js";
import { LoopDetectorUseCase } from "./loop-detector.usecase.js";
import { LoopEvaluatorUseCase } from "./loop-evaluator.usecase.js";
import { LoopMinerRunProgress } from "./run-progress.js";
import type {
  CandidateLoop,
  EpisodeRecord,
  LoopMinerEpisodeEmbeddingMapView,
  LoopMinerEpisodeEmbeddingPoint,
  LoopEvaluation,
  LoopMinerMemoryDecision,
  MinerEvent,
  PhaseUsageMetrics,
  LoopMinerRepository,
  LoopMinerRunReason,
  LoopMinerRunResult,
  LoopMinerRunView,
  LoopMinerSummary,
  WorkspaceLoopParent,
} from "./types.js";
import {
  LOOP_EPISODE_EXTRACTION_VERSION,
  consolidateWorkspaceGroupedHits,
  capMinerEventsWhenOverloaded,
  deriveCanonicalLoopFacet,
  deriveWorkspaceTracePayload,
  episodeEmbeddingText,
  episodeEmbeddingTextHash,
  sourceFingerprintFromEvent,
  workflowDnaFingerprint,
  workflowDnaPrompt,
} from "./utils.js";

export interface RunLoopMinerOptions {
  runReason?: LoopMinerRunReason;
  lookbackDays?: number;
  runId?: string;
  processAll?: boolean;
  memoryNewestLimit?: number;
  memoryInterestingLimit?: number;
  memoryCandidateLimit?: number;
}

export interface LoopMinerDeps {
  repository: LoopMinerRepository;
  episodeBuilder: EpisodeBuilderUseCase;
  loopDetector: LoopDetectorUseCase;
  loopEvaluator: LoopEvaluatorUseCase;
  dnaGenerator: DnaGeneratorUseCase;
}

const logger = createLogger({ baseFields: { component: "loop_miner" } });
const loopEpisodeVectorRepository = new LoopEpisodeVectorRepository();
const DEFAULT_MEMORY_NEWEST_LIMIT = 150;
const DEFAULT_MEMORY_INTERESTING_LIMIT = 50;
const STALE_RUNNING_MAX_AGE_MS = 60 * 60 * 1000;
const LOOP_EPISODE_EMBED_MAX_ATTEMPTS = 4;
const LOOP_EPISODE_EMBED_BASE_DELAY_MS = 1_000;
const LOOP_EPISODE_EMBED_CIRCUIT_COOLDOWN_MS = 22_000;
const LOOP_EPISODE_EMBED_MAX_DELAY_MS = 16_000;
const LOOP_EPISODE_EMBED_CHUNK_SIZE = 10;
const LOOP_EPISODE_EMBED_CHUNK_GAP_MS = 250;

function errorJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function errorMessage(error: unknown): string {
  const message = errorJson(error).message;
  return typeof message === "string" ? message : String(message ?? "unknown error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function isRetriableEmbeddingError(error: unknown): boolean {
  if (isRetriableProviderError(error)) return true;
  const message = errorMessage(error).toLowerCase();
  return /connection error|fetch failed|network|socket|econn|enotfound|eai_again|timeout|temporar/i.test(message);
}

function embedRetryDelayMs(error: unknown, attempt: number): number {
  if (error instanceof CircuitOpenError) {
    return LOOP_EPISODE_EMBED_CIRCUIT_COOLDOWN_MS;
  }
  return Math.min(
    LOOP_EPISODE_EMBED_MAX_DELAY_MS,
    LOOP_EPISODE_EMBED_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  );
}

async function batchEmbedTextsWithRetry(texts: string[]): Promise<(readonly number[])[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOOP_EPISODE_EMBED_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await aiProviderRegistry.embed({
        model: config.embeddingModel,
        input: texts,
        dimensions: config.embeddingDims,
      });
      if (response.vectors.length !== texts.length) {
        throw new Error(`Embedding provider returned ${response.vectors.length} vectors for ${texts.length} inputs`);
      }
      return [...response.vectors];
    } catch (error) {
      lastError = error;
      if (attempt >= LOOP_EPISODE_EMBED_MAX_ATTEMPTS || !isRetriableEmbeddingError(error)) {
        throw error;
      }
      await sleep(embedRetryDelayMs(error, attempt));
    }
  }
  throw lastError;
}

async function embedSingleTextWithRetry(text: string): Promise<number[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOOP_EPISODE_EMBED_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await embedText(text);
    } catch (error) {
      lastError = error;
      if (attempt >= LOOP_EPISODE_EMBED_MAX_ATTEMPTS || !isRetriableEmbeddingError(error)) {
        throw error;
      }
      await sleep(embedRetryDelayMs(error, attempt));
    }
  }
  throw lastError;
}

async function embedEpisodeTextsResilient(
  texts: string[],
  progress?: LoopMinerRunProgress,
): Promise<{
  vectors: Array<number[] | null>;
  chunkFailures: number;
  itemFailures: number;
}> {
  const vectors: Array<number[] | null> = new Array(texts.length).fill(null);
  let chunkFailures = 0;
  let itemFailures = 0;
  const totalChunks = Math.ceil(texts.length / LOOP_EPISODE_EMBED_CHUNK_SIZE);

  for (let offset = 0; offset < texts.length; offset += LOOP_EPISODE_EMBED_CHUNK_SIZE) {
    const chunkIndex = Math.floor(offset / LOOP_EPISODE_EMBED_CHUNK_SIZE) + 1;
    const chunk = texts.slice(offset, offset + LOOP_EPISODE_EMBED_CHUNK_SIZE);
    const chunkStart = offset;
    progress?.step("embedding episode text chunk", {
      chunkIndex,
      totalChunks,
      chunkSize: chunk.length,
      episodesEmbeddedSoFar: offset,
      episodesTotal: texts.length,
    });
    try {
      const chunkVectors = await batchEmbedTextsWithRetry(chunk);
      for (let index = 0; index < chunkVectors.length; index += 1) {
        vectors[chunkStart + index] = [...chunkVectors[index]];
      }
    } catch {
      chunkFailures += 1;
      for (let index = 0; index < chunk.length; index += 1) {
        try {
          vectors[chunkStart + index] = await embedSingleTextWithRetry(chunk[index]);
        } catch {
          itemFailures += 1;
          vectors[chunkStart + index] = null;
        }
      }
    }

    if (offset + LOOP_EPISODE_EMBED_CHUNK_SIZE < texts.length) {
      await sleep(LOOP_EPISODE_EMBED_CHUNK_GAP_MS);
    }
  }

  return { vectors, chunkFailures, itemFailures };
}

function modelRejectsExplicitTemperature(model: string | undefined): boolean {
  if (!model) return false;
  const normalized = model.toLowerCase();
  return normalized.startsWith("gpt-5");
}

function isUnsupportedTemperatureError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("unsupported value: 'temperature'")
    || (message.includes("temperature") && message.includes("only the default (1) value is supported"));
}

async function sendLoopMinerCompletionSlack(input: {
  auth: AuthContext;
  runId: string;
  status: string;
  summary: LoopMinerSummary;
}): Promise<void> {
  const dashboardUrl = new URL("/dashboard/memory-cleanup", config.dashboardBaseUrl).toString();
  const warnings = input.summary.warnings?.length ?? 0;
  const text = [
    `Tallei Loop Miner ${input.status}`,
    `Tenant: ${input.auth.tenantId}`,
    `User: ${input.auth.userId}`,
    `Run: ${input.runId}`,
    `Duration: ${input.summary.durationMs ?? 0}ms`,
    `Episodes: ${input.summary.episodesBuilt}`,
    `Loops detected: ${input.summary.loopsDetected}`,
    `Loops qualified: ${input.summary.loopsQualified}`,
    `Suggestions: ${input.summary.suggestionsCreated}`,
    `Warnings: ${warnings}`,
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");
  const result = await sendAdminSlackMessage({ text });
  if (!result.sent && !result.skipped) {
    logger.warn("loop miner slack notification failed", { runId: input.runId, error: result.error, status: result.status });
  }
}

function vectorNormSquared(vector: number[]): number {
  return vector.reduce((sum, value) => sum + value * value, 0);
}

function emptySummary(overrides: Partial<LoopMinerSummary> = {}): LoopMinerSummary {
  return {
    episodesBuilt: 0,
    loopsDetected: 0,
    loopsQualified: 0,
    suggestionsCreated: 0,
    durationMs: 0,
    aiCalls: 0,
    usage: emptyCleanupAiUsage(),
    phaseUsage: {},
    ...overrides,
  };
}

function finalizeSummary(summary: LoopMinerSummary, startedAt: number): LoopMinerSummary {
  return {
    ...summary,
    durationMs: Date.now() - startedAt,
    usage: {
      ...summary.usage,
      estimatedCostUsd: Number(summary.usage.estimatedCostUsd.toFixed(6)),
    },
  };
}

function attachProgressTrace(summary: LoopMinerSummary, progress: LoopMinerRunProgress): LoopMinerSummary {
  const snapshot = progress.snapshot();
  return {
    ...summary,
    debugTrace: {
      ...(summary.debugTrace ?? {}),
      phaseTimings: snapshot.phaseTimings,
      totalElapsedMs: snapshot.totalElapsedMs,
    },
  };
}

function flushProgress(
  deps: LoopMinerDeps,
  auth: AuthContext,
  runId: string,
  progress: LoopMinerRunProgress
): void {
  if (!deps.repository.patchRunLiveProgress) return;
  void deps.repository.patchRunLiveProgress(auth, runId, progress.snapshot()).catch(() => {});
}

async function loopMinerChat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  const baseRequest = modelRejectsExplicitTemperature(request.model)
    ? { ...request, temperature: undefined }
    : request;
  try {
    return await withTimeout(
      (signal) => aiProviderRegistry.chatDirect({ ...baseRequest, signal }),
      config.loopMinerChatTimeoutMs,
      { message: `Loop miner chat timed out after ${config.loopMinerChatTimeoutMs}ms` }
    );
  } catch (error) {
    if (!isUnsupportedTemperatureError(error)) throw error;
    const fallbackRequest: ChatCompletionRequest = { ...baseRequest, temperature: undefined };
    return withTimeout(
      (signal) => aiProviderRegistry.chatDirect({ ...fallbackRequest, signal }),
      config.loopMinerChatTimeoutMs,
      { message: `Loop miner chat timed out after ${config.loopMinerChatTimeoutMs}ms` }
    );
  }
}

function createDefaultDeps(): LoopMinerDeps {
  const repository = new PgLoopMinerRepository();
  const chat = loopMinerChat;
  return {
    repository,
    episodeBuilder: new EpisodeBuilderUseCase(repository, chat),
    loopDetector: new LoopDetectorUseCase(chat),
    loopEvaluator: new LoopEvaluatorUseCase(),
    dnaGenerator: new DnaGeneratorUseCase(chat),
  };
}

function normalizePhaseUsage(usage: PhaseUsageMetrics | undefined): PhaseUsageMetrics | undefined {
  if (!usage) return undefined;
  return {
    ...usage,
    estimatedCostUsd: Number(usage.estimatedCostUsd.toFixed(6)),
  };
}

function summarizeMemoryDecisions(decisions: LoopMinerMemoryDecision[]): NonNullable<LoopMinerSummary["memorySelection"]> {
  const firstSelection = decisions.find((decision) => decision.selectionConsidered !== undefined);
  return {
    considered: firstSelection?.selectionConsidered ?? decisions.length,
    included: decisions.filter((decision) => decision.status === "included").length,
    excluded: decisions.filter((decision) => decision.status === "excluded").length,
    sourceImportsIncluded: decisions.filter((decision) => decision.status === "included" && decision.sourceImport).length,
    unbucketedIncluded: decisions.filter((decision) => decision.status === "included" && !decision.sourceImport && !decision.cleanupBucket).length,
    bucketedExcluded: decisions.filter((decision) => decision.status === "excluded" && decision.reason === "bucketed_memory_deprioritized").length,
    decryptFailures: decisions.filter((decision) => decision.reason === "decrypt_failed").length,
    newestSelected: decisions.filter((decision) => decision.selectionRole === "newest").length,
    interestingSelected: decisions.filter((decision) => decision.selectionRole === "interesting").length,
    candidateLimit: firstSelection?.selectionCandidateLimit,
    truncated: firstSelection?.selectionTruncated,
  };
}

function countEventsByType(events: MinerEvent[]): { total: number; aiActivity: number; collabTask: number; memoryRecord: number } {
  return {
    total: events.length,
    aiActivity: events.filter((event) => event.sourceEventType === "ai_activity_event").length,
    collabTask: events.filter((event) => event.sourceEventType === "collab_task").length,
    memoryRecord: events.filter((event) => event.sourceEventType === "memory_record").length,
  };
}

function memoryDecisionToFallbackEvent(decision: LoopMinerMemoryDecision): MinerEvent | null {
  if (decision.status !== "included") return null;
  if (!decision.contentPreview || decision.contentPreview === "[Encrypted memory unavailable]") return null;
  return {
    id: decision.memoryId,
    sourceEventType: "memory_record",
    createdAt: decision.selectedAt || decision.createdAt,
    platform: decision.sourcePlatform ?? "chatgpt",
    role: "user",
    contentSummary: [
      decision.sourceImport ? "Imported ChatGPT memory" : "Memory",
      `Type: ${decision.detectedMemoryType ?? decision.memoryType}`,
      decision.category ? `Category: ${decision.category}` : null,
      decision.sourceDateTime ? `Source datetime: ${decision.sourceDateTime}` : null,
      decision.contentPreview,
    ].filter((part): part is string => Boolean(part)).join("\n"),
    metadata: {
      memoryType: decision.memoryType,
      detectedMemoryType: decision.detectedMemoryType,
      category: decision.category,
      isPinned: decision.isPinned,
      sourceImport: decision.sourceImport,
      sourceImportBatchId: decision.sourceImportBatchId,
      sourceImportMode: decision.sourceImportMode,
      sourceDateTime: decision.sourceDateTime,
      observedAt: decision.observedAt,
      cleanupAppliedAt: decision.cleanupAppliedAt,
      cleanupAction: decision.cleanupAction,
      cleanupTargetMemoryId: decision.cleanupTargetMemoryId,
      cleanupSourceMemoryIds: decision.cleanupSourceMemoryIds,
      cleanupBucket: decision.cleanupBucket,
      minerImportance: decision.minerImportance,
      memoryImportance: decision.memoryImportance,
      fallbackFromDecisionLog: true,
    },
  };
}

function applyMemoryDecisionFallbackEvents(
  events: MinerEvent[],
  decisions: LoopMinerMemoryDecision[] | undefined
): { events: MinerEvent[]; added: number; replaced: number } {
  if (!decisions || decisions.length === 0) return { events, added: 0, replaced: 0 };
  const fallbackEvents = decisions
    .map(memoryDecisionToFallbackEvent)
    .filter((event): event is MinerEvent => {
      if (!event) return false;
      return true;
    });
  if (fallbackEvents.length === 0) return { events, added: 0, replaced: 0 };

  const fallbackById = new Map(fallbackEvents.map((event) => [event.id, event]));
  let replaced = 0;
  const canonicalEvents = events.map((event) => {
    const fallback = fallbackById.get(event.id);
    if (!fallback) return event;
    fallbackById.delete(event.id);
    if (event.sourceEventType === "memory_record") {
      replaced += 1;
      return fallback;
    }
    return event;
  });
  const addedEvents = [...fallbackById.values()];
  return {
    events: addedEvents.length > 0 ? [...canonicalEvents, ...addedEvents] : canonicalEvents,
    added: addedEvents.length,
    replaced,
  };
}

function keyForLoop(loop: CandidateLoop): string {
  return [...loop.episodeIds].sort().join("|");
}

function findCandidateForEvaluation(candidates: CandidateLoop[], evaluation: LoopEvaluation): CandidateLoop | null {
  const evaluationKey = [...evaluation.episodeIds].sort().join("|");
  return candidates.find((candidate) => keyForLoop(candidate) === evaluationKey)
    ?? candidates.find((candidate) => evaluation.episodeIds.every((id) => candidate.episodeIds.includes(id)))
    ?? null;
}

function loggableSummary(summary: LoopMinerSummary): Omit<LoopMinerSummary, "memoryDecisionLog"> & { memoryDecisionLogCount: number } {
  const { memoryDecisionLog: _memoryDecisionLog, ...rest } = summary;
  return {
    ...rest,
    memoryDecisionLogCount: summary.memoryDecisionLog?.length ?? 0,
  };
}

function dedupeEpisodesById(episodes: EpisodeRecord[]): EpisodeRecord[] {
  const byId = new Map<string, EpisodeRecord>();
  for (const episode of episodes) {
    byId.set(episode.id, episode);
  }
  return [...byId.values()].sort((left, right) => Date.parse(left.sealedAt) - Date.parse(right.sealedAt));
}

function memoryEvidenceEvents(events: MinerEvent[]): MinerEvent[] {
  return events.filter((event) => event.sourceEventType === "memory_record");
}

function evidenceFingerprintFor(fingerprints: string[]): string {
  const normalized = [...new Set(fingerprints)].sort();
  return createHash("sha256").update(JSON.stringify({
    extractionVersion: LOOP_EPISODE_EXTRACTION_VERSION,
    fingerprints: normalized,
  })).digest("hex");
}

function relatedReusedEpisodeContext(newEpisodes: EpisodeRecord[], reusedEpisodes: EpisodeRecord[]): EpisodeRecord[] {
  if (newEpisodes.length === 0) return reusedEpisodes;
  const outputTypes = new Set(newEpisodes.map((episode) => episode.outputType.trim().toLowerCase()).filter(Boolean));
  const sources = new Set(newEpisodes.flatMap((episode) => episode.sources.map((source) => source.trim().toLowerCase())).filter(Boolean));
  return reusedEpisodes
    .filter((episode) => {
      if (outputTypes.has(episode.outputType.trim().toLowerCase())) return true;
      return episode.sources.some((source) => sources.has(source.trim().toLowerCase()));
    })
    .slice(0, 20);
}

function filterPatternTraceToNewEvidence(
  trace: LoopMinerSummary["patternTrace"],
  newEpisodeIds: Set<string>
): LoopMinerSummary["patternTrace"] {
  if (!trace || newEpisodeIds.size === 0) return trace;
  const keepGroup = (episodeIds: string[]) => episodeIds.some((id) => newEpisodeIds.has(id));
  const keptCandidateIds = new Set(trace.candidateGroups.filter((group) => keepGroup(group.episodeIds)).map((group) => group.id));
  return {
    candidateGroups: trace.candidateGroups.filter((group) => keptCandidateIds.has(group.id)),
    approvedGroups: trace.approvedGroups.filter((id) => keptCandidateIds.has(id)),
    rejectedGroups: trace.rejectedGroups.filter((group) => keptCandidateIds.has(group.candidateGroupId)),
    adversaryFindings: trace.adversaryFindings.filter((finding) => keptCandidateIds.has(finding.candidateGroupId)),
    judgeDecisions: trace.judgeDecisions.filter((decision) => keptCandidateIds.has(decision.candidateGroupId)),
  };
}

function mergeGroupedResults(current: LoopEpisodeGroupedResult[], incoming: LoopEpisodeGroupedResult[]): LoopEpisodeGroupedResult[] {
  const byAnchor = new Map<string, LoopEpisodeGroupedResult>();
  for (const row of [...current, ...incoming]) {
    const key = row.subjectAnchor.trim().toLowerCase() || "unlabeled loop";
    const existing = byAnchor.get(key);
    if (!existing) {
      byAnchor.set(key, {
        subjectAnchor: row.subjectAnchor,
        runs: [...row.runs],
      });
      continue;
    }
    const byRunId = new Map(existing.runs.map((run) => [run.episodeId, run]));
    for (const run of row.runs) {
      const prior = byRunId.get(run.episodeId);
      if (!prior || run.score > prior.score) byRunId.set(run.episodeId, run);
    }
    byAnchor.set(key, {
      subjectAnchor: existing.subjectAnchor,
      runs: [...byRunId.values()],
    });
  }
  return [...byAnchor.values()];
}

function pickLoopParentForCandidate(
  candidateLoop: CandidateLoop,
  loopParents: WorkspaceLoopParent[]
): WorkspaceLoopParent | undefined {
  const episodeIds = new Set(candidateLoop.episodeIds);
  const direct = loopParents.find((parent) =>
    parent.historicalRuns.some((run) => episodeIds.has(run.episodeId))
  );
  if (direct) return direct;
  const sourceKey = candidateLoop.sharedSources[0]?.trim().toLowerCase();
  if (!sourceKey) return undefined;
  return loopParents.find((parent) => parent.subjectAnchor.trim().toLowerCase() === sourceKey);
}

export async function runLoopMinerForUser(
  auth: AuthContext,
  options: RunLoopMinerOptions = {},
  deps: LoopMinerDeps = createDefaultDeps()
): Promise<LoopMinerRunResult> {
  const runReason = options.runReason ?? "manual";
  const lookbackDays = Math.max(1, Math.min(options.lookbackDays ?? 30, 90));
  const processAll = options.processAll ?? false;
  const memorySelectionOptions = processAll
    ? { processAll: true as const }
    : {
        newestLimit: Math.max(1, options.memoryNewestLimit ?? DEFAULT_MEMORY_NEWEST_LIMIT),
        interestingLimit: Math.max(0, options.memoryInterestingLimit ?? DEFAULT_MEMORY_INTERESTING_LIMIT),
        candidateLimit: Math.max(
          (options.memoryNewestLimit ?? DEFAULT_MEMORY_NEWEST_LIMIT) + (options.memoryInterestingLimit ?? DEFAULT_MEMORY_INTERESTING_LIMIT),
          options.memoryCandidateLimit ?? 2_000
        ),
      };
  const startedAt = Date.now();

  if (runReason === "daily_intelligence") {
    if (await deps.repository.hasRunningDailyRun(auth)) {
      return {
        id: "skipped-running",
        status: "completed",
        summary: emptySummary({ skipped: true, skipReason: "running_loop_miner_exists" }),
        suggestions: [],
      };
    }
    if (await deps.repository.hasCompletedDailyRunToday(auth)) {
      return {
        id: "skipped-completed-today",
        status: "completed",
        summary: emptySummary({ skipped: true, skipReason: "completed_loop_miner_exists_today" }),
        suggestions: [],
      };
    }
  }

  const runId = options.runId ?? await deps.repository.createRun({ auth, runReason });
  let summary = emptySummary();
  const progress = new LoopMinerRunProgress(runId);
  try {
    logger.info("loop miner run started", { runId, runReason, lookbackDays });
    progress.startPhase("event_ingest", { lookbackDays });
    let events = await deps.repository.listRecentEvents(auth, lookbackDays, memorySelectionOptions);
    const eventCountsBeforeFallback = countEventsByType(events);
    progress.endPhase("event_ingest", {
      eventCount: events.length,
      memoryRecords: eventCountsBeforeFallback.memoryRecord,
      aiActivity: eventCountsBeforeFallback.aiActivity,
    });
    flushProgress(deps, auth, runId, progress);

    progress.startPhase("memory_decisions");
    if (deps.repository.listMemoryDecisionLog) {
      try {
        const memoryDecisionLog = await deps.repository.listMemoryDecisionLog(auth, lookbackDays, memorySelectionOptions);
        summary.memoryDecisionLog = memoryDecisionLog;
        summary.memorySelection = summarizeMemoryDecisions(memoryDecisionLog);
        summary.cleanupSuppressedSeeds = memoryDecisionLog.filter((decision) =>
          decision.status === "excluded" && decision.reason === "bucketed_memory_deprioritized"
        ).length;
        logger.info("loop miner memory decision trace", {
          runId,
          ...summary.memorySelection,
          reasonCounts: memoryDecisionLog.reduce<Record<string, number>>((counts, decision) => {
            counts[decision.reason] = (counts[decision.reason] ?? 0) + 1;
            return counts;
          }, {}),
        });
        const memoryFallback = applyMemoryDecisionFallbackEvents(events, memoryDecisionLog);
        events = memoryFallback.events;
        const eventCountsAfterFallback = countEventsByType(events);
        summary.memorySelection = {
          ...summary.memorySelection,
          fallbackEventsAdded: memoryFallback.added,
          fallbackEventsReplaced: memoryFallback.replaced,
          eventFeedAfterFallback: events.length,
        };
        summary.debugTrace = {
          ...(summary.debugTrace ?? {}),
          eventIngest: {
            beforeFallback: eventCountsBeforeFallback,
            afterFallback: eventCountsAfterFallback,
            fallbackEventsAdded: memoryFallback.added,
            fallbackEventsReplaced: memoryFallback.replaced,
            includedMemoryIdsSample: memoryDecisionLog
              .filter((decision) => decision.status === "included")
              .slice(0, 12)
              .map((decision) => decision.memoryId),
            memoryEventIdsSample: events
              .filter((event) => event.sourceEventType === "memory_record")
              .slice(0, 12)
              .map((event) => event.id),
          },
        };
      } catch (memoryDecisionError) {
        summary.warnings = [
          ...(summary.warnings ?? []),
          `Memory decision log unavailable: ${errorJson(memoryDecisionError).message ?? "unknown error"}`,
        ];
      }
    }
    progress.endPhase("memory_decisions", {
      included: summary.memorySelection?.included ?? 0,
      excluded: summary.memorySelection?.excluded ?? 0,
      eventCountAfterFallback: events.length,
    });
    flushProgress(deps, auth, runId, progress);

    const evidenceCap = processAll || config.loopMinerMaxEventsPerRun <= 0
      ? { events, capped: false, beforeCap: events.length, afterCap: events.length, droppedByDate: 0, droppedByCount: 0, cutoffDate: new Date().toISOString() }
      : capMinerEventsWhenOverloaded(events, {
          maxEvidenceDays: config.loopMinerMaxEvidenceDays,
          maxEventsPerRun: config.loopMinerMaxEventsPerRun,
        });
    events = evidenceCap.events;
    if (evidenceCap.capped) {
      summary.warnings = [
        ...(summary.warnings ?? []),
        `Loop miner evidence capped to ${evidenceCap.afterCap} newest events within the last ${config.loopMinerMaxEvidenceDays} days (dropped ${evidenceCap.droppedByDate} older, ${evidenceCap.droppedByCount} over limit).`,
      ];
      progress.step("loop miner evidence capped by date", {
        beforeCap: evidenceCap.beforeCap,
        afterCap: evidenceCap.afterCap,
        maxEvidenceDays: config.loopMinerMaxEvidenceDays,
        maxEventsPerRun: config.loopMinerMaxEventsPerRun,
        cutoffDate: evidenceCap.cutoffDate,
        droppedByDate: evidenceCap.droppedByDate,
        droppedByCount: evidenceCap.droppedByCount,
      });
      logger.info("loop miner evidence capped", {
        runId,
        lookbackDays,
        ...evidenceCap,
        maxEvidenceDays: config.loopMinerMaxEvidenceDays,
        maxEventsPerRun: config.loopMinerMaxEventsPerRun,
      });
    }
    summary.debugTrace = {
      ...(summary.debugTrace ?? {}),
      eventIngest: {
        beforeFallback: summary.debugTrace?.eventIngest?.beforeFallback ?? eventCountsBeforeFallback,
        afterFallback: summary.debugTrace?.eventIngest?.afterFallback ?? eventCountsBeforeFallback,
        fallbackEventsAdded: summary.debugTrace?.eventIngest?.fallbackEventsAdded ?? 0,
        fallbackEventsReplaced: summary.debugTrace?.eventIngest?.fallbackEventsReplaced ?? 0,
        includedMemoryIdsSample: summary.debugTrace?.eventIngest?.includedMemoryIdsSample ?? [],
        memoryEventIdsSample: events
          .filter((event) => event.sourceEventType === "memory_record")
          .slice(0, 12)
          .map((event) => event.id),
        evidenceCap: {
          requestedLookbackDays: lookbackDays,
          maxEvidenceDays: config.loopMinerMaxEvidenceDays,
          maxEventsPerRun: config.loopMinerMaxEventsPerRun,
          beforeCap: evidenceCap.beforeCap,
          afterCap: evidenceCap.afterCap,
          droppedByDate: evidenceCap.droppedByDate,
          droppedByCount: evidenceCap.droppedByCount,
          cutoffDate: evidenceCap.cutoffDate,
        },
      },
    };

    progress.startPhase("incremental_check");
    const memoryEvents = memoryEvidenceEvents(events);
    const memoryEventFingerprints = new Map(memoryEvents.map((event) => [
      event.id,
      sourceFingerprintFromEvent(event, LOOP_EPISODE_EXTRACTION_VERSION),
    ]));
    const evidenceFingerprint = evidenceFingerprintFor([...memoryEventFingerprints.values()]);
    const latestIncremental = deps.repository.getLatestCompletedIncrementalState
      ? await deps.repository.getLatestCompletedIncrementalState(auth, lookbackDays)
      : null;

    if (latestIncremental?.evidenceFingerprint === evidenceFingerprint) {
      progress.skipPhase("incremental_check", "no_new_loop_evidence", { evidenceFingerprint });
      const suggestions = deps.repository.listReusableLoopMinerSuggestions
        ? await deps.repository.listReusableLoopMinerSuggestions(auth)
        : [];
      summary = attachProgressTrace(finalizeSummary({
        ...summary,
        skipped: true,
        skipReason: "no_new_loop_evidence",
        incremental: {
          mode: "skipped_no_new_evidence",
          evidenceFingerprint,
          extractionVersion: LOOP_EPISODE_EXTRACTION_VERSION,
          totalEvidenceEvents: memoryEvents.length,
          newEvidenceEvents: 0,
          reusedEpisodes: latestIncremental.summary.incremental?.reusedEpisodes ?? 0,
          newEpisodes: 0,
          reusedSuggestions: suggestions.length,
          suggestionsUpdated: 0,
        },
      }, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run skipped with no new evidence", { runId, reusedSuggestions: suggestions.length, ...progress.snapshot() });
      return { id: runId, status: "completed", summary, suggestions };
    }

    progress.startPhase("episode_reuse_lookup");

    const reusableEpisodeByFingerprint = deps.repository.findEpisodesBySourceFingerprints
      ? await deps.repository.findEpisodesBySourceFingerprints({
          auth,
          sourceFingerprints: [...memoryEventFingerprints.values()],
          extractionVersion: LOOP_EPISODE_EXTRACTION_VERSION,
        })
      : new Map<string, EpisodeRecord>();
    const reusableEpisodeBySourceEventId = deps.repository.findEpisodesBySourceEventIds
      ? await deps.repository.findEpisodesBySourceEventIds({
          auth,
          sourceEventIds: memoryEvents.map((event) => event.id),
          sourceEventType: "memory_record",
        })
      : new Map<string, EpisodeRecord>();
    const reusedEpisodes = dedupeEpisodesById([
      ...reusableEpisodeByFingerprint.values(),
      ...reusableEpisodeBySourceEventId.values(),
    ]);
    const newMemoryEvents = memoryEvents.filter((event) => {
      const fingerprint = memoryEventFingerprints.get(event.id);
      return (!fingerprint || !reusableEpisodeByFingerprint.has(fingerprint))
        && !reusableEpisodeBySourceEventId.has(event.id);
    });
    const incrementalMode = latestIncremental ? "incremental" : "full";
    const eventsForEpisodeBuilder = latestIncremental ? newMemoryEvents : events;
    progress.endPhase("incremental_check", {
      mode: incrementalMode,
      totalMemoryEvents: memoryEvents.length,
      newMemoryEvents: newMemoryEvents.length,
      reusedEpisodes: reusedEpisodes.length,
    });
    progress.endPhase("episode_reuse_lookup", {
      reusableByFingerprint: reusableEpisodeByFingerprint.size,
      reusableBySourceEventId: reusableEpisodeBySourceEventId.size,
    });
    flushProgress(deps, auth, runId, progress);

    if (latestIncremental && newMemoryEvents.length === 0) {
      progress.skipPhase("episode_builder", "no_new_memory_evidence");
      const suggestions = deps.repository.listReusableLoopMinerSuggestions
        ? await deps.repository.listReusableLoopMinerSuggestions(auth)
        : [];
      summary = attachProgressTrace(finalizeSummary({
        ...summary,
        skipped: true,
        skipReason: "no_new_loop_evidence",
        incremental: {
          mode: "skipped_no_new_evidence",
          evidenceFingerprint,
          extractionVersion: LOOP_EPISODE_EXTRACTION_VERSION,
          totalEvidenceEvents: memoryEvents.length,
          newEvidenceEvents: 0,
          reusedEpisodes: reusedEpisodes.length,
          newEpisodes: 0,
          reusedSuggestions: suggestions.length,
          suggestionsUpdated: 0,
        },
      }, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run skipped with no new memory evidence", { runId, reusedSuggestions: suggestions.length, ...progress.snapshot() });
      return { id: runId, status: "completed", summary, suggestions };
    }

    progress.startPhase("episode_builder", { inputEvents: eventsForEpisodeBuilder.length, mode: incrementalMode });
    flushProgress(deps, auth, runId, progress);
    const built = await deps.episodeBuilder.execute({ auth, runId, events: eventsForEpisodeBuilder, progress });
    progress.endPhase("episode_builder", {
      episodesBuilt: built.episodes.length,
      aiCalls: built.aiCalls,
      batchesProcessed: built.phaseUsage.batchesProcessed,
      batchesSkipped: built.phaseUsage.batchesSkipped,
    });
    flushProgress(deps, auth, runId, progress);
    mergeCleanupAiUsage(summary.usage, built.usage);
    summary.aiCalls += built.aiCalls;
    summary.episodesBuilt = built.episodes.length;
    summary.incremental = {
      mode: incrementalMode,
      evidenceFingerprint,
      extractionVersion: LOOP_EPISODE_EXTRACTION_VERSION,
      totalEvidenceEvents: memoryEvents.length,
      newEvidenceEvents: latestIncremental ? newMemoryEvents.length : memoryEvents.length,
      reusedEpisodes: reusedEpisodes.length,
      newEpisodes: built.episodes.length,
      reusedSuggestions: 0,
      suggestionsUpdated: 0,
    };
    summary.phaseUsage = {
      ...(summary.phaseUsage ?? {}),
      episodeBuilder: built.phaseUsage,
    };
    if (built.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...built.warnings];
    }
    const deterministicSamples = built.raw
      .filter((row): row is Record<string, unknown> => {
        return Boolean(row)
          && typeof row === "object"
          && !Array.isArray(row)
          && (row as Record<string, unknown>).source === "deterministic_memory_workflow_extraction";
      })
      .slice(0, 12)
      .map((row) => ({
        eventId: typeof row.eventId === "string" ? row.eventId : "",
        title: typeof row.title === "string" ? row.title : undefined,
        outputType: typeof row.outputType === "string" ? row.outputType : undefined,
        cadence: typeof row.cadence === "string" ? row.cadence : undefined,
      }));
    summary.debugTrace = {
      ...(summary.debugTrace ?? {}),
      episodeBuilder: {
        inputEvents: eventsForEpisodeBuilder.length,
        deterministicMemoryExtractions: deterministicSamples.length,
        llmInputEvents: eventsForEpisodeBuilder.length - deterministicSamples.length,
        rawDeterministicSamples: deterministicSamples,
        builtEpisodeSamples: built.episodes.slice(0, 12).map((episode) => ({
          id: episode.id,
          title: episode.title ?? episode.intent,
          outputType: episode.outputType,
          sourceEventTypes: [...new Set(episode.turns.map((turn) => turn.sourceEventType))],
          eventIds: episode.eventIds.slice(0, 12),
        })),
      },
    };

    if (latestIncremental && newMemoryEvents.length > 0 && built.episodes.length === 0) {
      progress.skipPhase("loop_detector", "no_new_loop_episodes");
      const suggestions = deps.repository.listReusableLoopMinerSuggestions
        ? await deps.repository.listReusableLoopMinerSuggestions(auth)
        : [];
      if (summary.incremental) {
        summary.incremental.reusedSuggestions = suggestions.length;
      }
      summary = attachProgressTrace(finalizeSummary({
        ...summary,
        skipped: true,
        skipReason: "no_new_loop_episodes",
      }, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run skipped because new evidence produced no episodes", { runId, newMemoryEvents: newMemoryEvents.length, ...progress.snapshot() });
      return { id: runId, status: "completed", summary, suggestions };
    }

    progress.startPhase("vector_setup");

    const similarEpisodeIds = new Set<string>();
    let groupedLoopResults: LoopEpisodeGroupedResult[] = [];
    let loopVectorSearchEnabled = false;
    if (config.qdrantUrl && deps.repository.updateEpisodeEmbeddingMetadata) {
      try {
        await loopEpisodeVectorRepository.ensureReady();
        loopVectorSearchEnabled = true;
      } catch (error) {
        const message = errorMessage(error);
        logger.warn("loop episode vector retrieval skipped", { runId, error: message });
        summary.warnings = [
          ...(summary.warnings ?? []),
          `Loop episode vector retrieval skipped: ${message}`,
        ];
        summary.debugTrace = {
          ...(summary.debugTrace ?? {}),
          vectorRetrieval: {
            status: "skipped",
            reason: message,
          },
        };
      }
    }
    progress.endPhase("vector_setup", { vectorSearchEnabled: loopVectorSearchEnabled });
    flushProgress(deps, auth, runId, progress);
    if (loopVectorSearchEnabled && deps.repository.updateEpisodeEmbeddingMetadata) {
      // Determine which episodes need (re)embedding
      type EpisodePlan = {
        episode: EpisodeRecord;
        text: string;
        hash: string;
        shouldUpsert: boolean;
      };
      const plans: EpisodePlan[] = built.episodes.map((episode) => {
        const text = episodeEmbeddingText(episode);
        const hash = episodeEmbeddingTextHash(text);
        return {
          episode,
          text,
          hash,
          shouldUpsert: episode.embeddingTextHash !== hash || episode.embeddingStatus !== "ready",
        };
      });
      const toEmbed = plans.filter((plan) => plan.shouldUpsert);
      progress.startPhase("episode_embedding", {
        episodesTotal: plans.length,
        episodesToEmbed: toEmbed.length,
        episodesCached: plans.length - toEmbed.length,
      });

      const vectorByEpisodeId = new Map<string, number[]>();
      if (toEmbed.length > 0) {
        const embedResult = await embedEpisodeTextsResilient(toEmbed.map((plan) => plan.text), progress);
        let embeddedCount = 0;
        for (const [index, plan] of toEmbed.entries()) {
          const vector = embedResult.vectors[index];
          if (vector && vector.length > 0) {
            vectorByEpisodeId.set(plan.episode.id, vector);
            embeddedCount += 1;
            continue;
          }
          summary.warnings = [
            ...(summary.warnings ?? []),
            `Loop episode embedding failed for episode ${plan.episode.id}`,
          ];
          try {
            await deps.repository.updateEpisodeEmbeddingMetadata!({
              auth,
              episodeId: plan.episode.id,
              embeddingTextHash: plan.hash,
              status: "failed",
              embeddedAt: null,
            });
          } catch {
            // Non-fatal metadata write failure.
          }
        }
        if (embedResult.chunkFailures > 0) {
          summary.warnings = [
            ...(summary.warnings ?? []),
            `Loop episode embedding used single-item fallback after ${embedResult.chunkFailures} batch chunk failure(s).`,
          ];
        }
        if (embedResult.itemFailures > 0) {
          summary.warnings = [
            ...(summary.warnings ?? []),
            `Loop episode embedding failed for ${embedResult.itemFailures} episode(s) after retries.`,
          ];
        }
        if (embeddedCount === 0 && toEmbed.length > 0) {
          summary.warnings = [
            ...(summary.warnings ?? []),
            `Loop episode vector retrieval skipped: all ${toEmbed.length} embedding attempt(s) failed.`,
          ];
        }
        progress.endPhase("episode_embedding", {
          embeddedCount,
          chunkFailures: embedResult.chunkFailures,
          itemFailures: embedResult.itemFailures,
        });
      } else {
        progress.endPhase("episode_embedding", { embeddedCount: 0, skipped: true });
      }
      flushProgress(deps, auth, runId, progress);

      progress.startPhase("vector_index_and_search", { episodesTotal: plans.length });
      let vectorUpserts = 0;
      let vectorSearches = 0;
      let vectorSearchHits = 0;

      for (const [planIndex, { episode, hash: embeddingHash, shouldUpsert }] of plans.entries()) {
        if (planIndex === 0 || planIndex % 5 === 0 || planIndex === plans.length - 1) {
          progress.step("vector index/search progress", {
            episodeIndex: planIndex + 1,
            episodesTotal: plans.length,
            vectorUpserts,
            vectorSearches,
            similarEpisodeCount: similarEpisodeIds.size,
          });
        }
        const canonicalFacet = deriveCanonicalLoopFacet(episode);
        let vector = vectorByEpisodeId.get(episode.id) ?? [];

        if (!shouldUpsert && vector.length === 0) {
          try {
            const storedVector = await loopEpisodeVectorRepository.getEpisodeVector({
              auth,
              episodeId: episode.id,
            });
            if (storedVector && storedVector.length > 0) {
              vector = storedVector;
              vectorByEpisodeId.set(episode.id, storedVector);
            }
          } catch (error) {
            summary.warnings = [
              ...(summary.warnings ?? []),
              `Loop episode vector load failed for episode ${episode.id}: ${errorMessage(error)}`,
            ];
          }
        }

        if (shouldUpsert && vector.length === 0) {
          continue;
        }
        if (vector.length === 0) {
          continue;
        }
        const invalidVectorReason = (() => {
          if (vector.length !== config.embeddingDims) {
            return `dimension_mismatch expected=${config.embeddingDims} got=${vector.length}`;
          }
          if (vector.some((value) => !Number.isFinite(value))) {
            return "non_finite_vector_values";
          }
          if (vectorNormSquared(vector) <= 1e-12) {
            return "zero_norm_vector";
          }
          return null;
        })();
        if (invalidVectorReason) {
          const reason = invalidVectorReason;
          summary.warnings = [
            ...(summary.warnings ?? []),
            `Loop episode embedding invalid for episode ${episode.id}: ${reason}`,
          ];
          try {
            await deps.repository.updateEpisodeEmbeddingMetadata({
              auth,
              episodeId: episode.id,
              embeddingTextHash: embeddingHash,
              status: "failed",
              embeddedAt: null,
            });
          } catch {
            // Non-fatal metadata write failure.
          }
          continue;
        }

        const workspacePayload = deriveWorkspaceTracePayload(episode, vector);
        if (shouldUpsert) {
          try {
            await loopEpisodeVectorRepository.upsertEpisodeVector({
              auth,
              episodeId: episode.id,
              outputType: episode.outputType,
              canonicalDomain: canonicalFacet.operationalDomain,
              mechanismSignature: canonicalFacet.mechanismSignature,
              abstractedJtbd: canonicalFacet.abstractedJtbd,
              subjectAnchor: workspacePayload.metadata.subject_anchor,
              operationalDomain: workspacePayload.metadata.operational_domain,
              inputArtifactClasses: workspacePayload.metadata.input_artifact_classes,
              outputArtifactClasses: workspacePayload.metadata.output_artifact_classes,
              category: workspacePayload.metadata.category,
              platform: workspacePayload.provenance.platform,
              writtenAt: workspacePayload.provenance.written_at,
              sealedAt: episode.sealedAt,
              sources: episode.sources,
              tools: episode.toolNames,
              sourceFingerprint: episode.sourceFingerprint,
              extractionVersion: episode.extractionVersion,
              vector,
            });
            await deps.repository.updateEpisodeEmbeddingMetadata({
              auth,
              episodeId: episode.id,
              embeddingTextHash: embeddingHash,
              status: "ready",
              embeddedAt: new Date().toISOString(),
            });
            vectorUpserts += 1;
          } catch (error) {
            const message = errorMessage(error);
            summary.warnings = [
              ...(summary.warnings ?? []),
              `Loop episode vector upsert failed for episode ${episode.id}: ${message}`,
            ];
            logger.warn("loop episode vector upsert failed", {
              runId,
              episodeId: episode.id,
              error: message,
              vectorDims: vector.length,
              vectorNormSquared: vectorNormSquared(vector),
              subjectAnchor: workspacePayload.metadata.subject_anchor,
              operationalDomain: workspacePayload.metadata.operational_domain,
              outputType: episode.outputType,
            });
            try {
              await deps.repository.updateEpisodeEmbeddingMetadata({
                auth,
                episodeId: episode.id,
                embeddingTextHash: embeddingHash,
                status: "failed",
                embeddedAt: null,
              });
            } catch {
              // Non-fatal metadata write failure.
            }
            continue;
          }
        }

        try {
          const similar = await loopEpisodeVectorRepository.searchSimilarEpisodes({
            auth,
            vector,
            limit: 20,
            outputType: episode.outputType,
            canonicalDomain: canonicalFacet.operationalDomain,
            mechanismSignature: canonicalFacet.mechanismSignature,
            excludeEpisodeId: episode.id,
          });
          vectorSearches += 1;
          for (const hit of similar) {
            if (hit.score >= 0.72) {
              similarEpisodeIds.add(hit.episodeId);
              vectorSearchHits += 1;
            }
          }
        } catch (error) {
          const message = errorMessage(error);
          summary.warnings = [
            ...(summary.warnings ?? []),
            `Loop episode vector search failed for episode ${episode.id}: ${message}`,
          ];
          logger.warn("loop episode vector search failed", {
            runId,
            episodeId: episode.id,
            error: message,
            vectorDims: vector.length,
            vectorNormSquared: vectorNormSquared(vector),
            outputType: episode.outputType,
            canonicalDomain: canonicalFacet.operationalDomain,
            mechanismSignature: canonicalFacet.mechanismSignature,
          });
        }

        try {
          const grouped = await loopEpisodeVectorRepository.searchGroupedEpisodesBySubjectAnchor({
            auth,
            vector,
            limit: 20,
            groupSize: 20,
            scoreThreshold: 0.65,
            excludeEpisodeId: episode.id,
          });
          groupedLoopResults = mergeGroupedResults(groupedLoopResults, grouped);
          for (const group of grouped) {
            for (const run of group.runs) {
              similarEpisodeIds.add(run.episodeId);
            }
          }
        } catch (error) {
          const message = errorMessage(error);
          summary.warnings = [
            ...(summary.warnings ?? []),
            `Loop episode vector grouped search failed for episode ${episode.id}: ${message}`,
          ];
          logger.warn("loop episode vector grouped search failed", {
            runId,
            episodeId: episode.id,
            error: message,
            vectorDims: vector.length,
            vectorNormSquared: vectorNormSquared(vector),
          });
        }
      }
      progress.endPhase("vector_index_and_search", {
        vectorUpserts,
        vectorSearches,
        vectorSearchHits,
        similarEpisodeCount: similarEpisodeIds.size,
        groupedAnchorCount: groupedLoopResults.length,
      });
    } else {
      progress.skipPhase("episode_embedding", "vector_search_disabled");
      progress.skipPhase("vector_index_and_search", "vector_search_disabled");
    }
    flushProgress(deps, auth, runId, progress);

    progress.step("preparing loop detector input", {
      builtEpisodes: built.episodes.length,
      reusedEpisodes: reusedEpisodes.length,
      similarEpisodesFromVectors: similarEpisodeIds.size,
    });
    const allEvidenceEpisodes = dedupeEpisodesById([...reusedEpisodes, ...built.episodes]);
    const newEpisodeIds = new Set(built.episodes.map((episode) => episode.id));
    const baseDetectorEpisodes = latestIncremental && built.episodes.length > 0
      ? dedupeEpisodesById([...built.episodes, ...relatedReusedEpisodeContext(built.episodes, reusedEpisodes)])
      : allEvidenceEpisodes;
    const additionalContextIds = [...similarEpisodeIds].filter((id) => !baseDetectorEpisodes.some((episode) => episode.id === id));
    const additionalEpisodes = additionalContextIds.length > 0
      ? await deps.repository.listEpisodeContext(auth, additionalContextIds)
      : [];
    const detectorEpisodes = dedupeEpisodesById([...baseDetectorEpisodes, ...additionalEpisodes]);
    const loopParents = consolidateWorkspaceGroupedHits(
      groupedLoopResults.map((group) => ({
        subjectAnchor: group.subjectAnchor,
        runs: group.runs.map((run) => ({
          id: run.pointId,
          episodeId: run.episodeId,
          text: run.text,
          score: run.score,
          metadata: {
            subject_anchor: run.metadata.subjectAnchor,
            operational_domain: run.metadata.operationalDomain as "Copywriting" | "System_Design" | "Calculations" | "Visual_Enhancement",
            input_artifact_classes: run.metadata.inputArtifactClasses,
            output_artifact_classes: run.metadata.outputArtifactClasses,
            category: run.metadata.category,
          },
          provenance: {
            platform: run.provenance.platform,
            written_at: run.provenance.writtenAt,
          },
        })),
      }))
    );

    progress.startPhase("loop_detector", {
      inputEpisodes: detectorEpisodes.length,
      additionalContextEpisodes: additionalEpisodes.length,
      vectorGroupedParents: loopParents.length,
    });
    const detected = await deps.loopDetector.execute(detectorEpisodes, { runId, progress });
    progress.endPhase("loop_detector", {
      candidateGroups: detected.patternTrace.candidateGroups.length,
      approvedLoops: detected.loops.length,
      aiCalls: detected.aiCalls,
      batchesProcessed: detected.phaseUsage.batchesProcessed,
      batchesSkipped: detected.phaseUsage.batchesSkipped,
    });
    flushProgress(deps, auth, runId, progress);
    const restrictToNewEvidence = latestIncremental !== null && newEpisodeIds.size > 0;
    const candidateLoops = restrictToNewEvidence
      ? detected.loops.filter((loop) => loop.episodeIds.some((id) => newEpisodeIds.has(id)))
      : detected.loops;
    const patternTrace = restrictToNewEvidence
      ? filterPatternTraceToNewEvidence(detected.patternTrace, newEpisodeIds)
      : detected.patternTrace;
    mergeCleanupAiUsage(summary.usage, detected.usage);
    summary.aiCalls += detected.aiCalls;
    summary.loopsDetected = candidateLoops.length;
    summary.loopsProposed = patternTrace?.candidateGroups.length ?? 0;
    summary.loopsApproved = patternTrace?.approvedGroups.length ?? 0;
    summary.loopsRejected = patternTrace?.rejectedGroups.length ?? 0;
    summary.loopsContested = patternTrace?.adversaryFindings.filter((finding) => finding.contested).length ?? 0;
    summary.loopsAutoApproved = patternTrace?.judgeDecisions.filter((decision) => decision.status === "approved_loop" && decision.confidence >= 0.85).length ?? 0;
    summary.cleanupEvidenceUsed = built.episodes.filter((episode) =>
      episode.turns.some((turn) => turn.sourceEventType === "memory_record")
    ).length;
    summary.timeSignalsUsed = built.episodes.filter((episode) =>
      episode.turns.some((turn) => /Source datetime:/i.test(turn.contentSummary))
    ).length;
    summary.patternTrace = patternTrace;
    summary.phaseUsage = {
      ...(summary.phaseUsage ?? {}),
      loopDetector: normalizePhaseUsage(detected.phaseUsage),
    };
    if (detected.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...detected.warnings];
    }
    summary.debugTrace = {
      ...(summary.debugTrace ?? {}),
      detector: {
        inputEpisodes: detectorEpisodes.length,
        candidateGroups: patternTrace?.candidateGroups.length ?? 0,
        approvedGroups: patternTrace?.approvedGroups.length ?? 0,
        rejectedGroups: patternTrace?.rejectedGroups.length ?? 0,
        warningCount: detected.warnings.length,
      },
      vectorRetrieval: loopParents.length > 0
        ? {
            status: "grouped",
            groupCount: loopParents.length,
            runCount: loopParents.reduce((sum, parent) => sum + parent.historicalRuns.length, 0),
          }
        : (summary.debugTrace?.vectorRetrieval ?? undefined),
    };

    const episodesByLoop = new Map<string, EpisodeRecord[]>();
    for (const loop of candidateLoops) {
      episodesByLoop.set(keyForLoop(loop), await deps.repository.listEpisodeContext(auth, loop.episodeIds));
    }

    progress.startPhase("loop_evaluator", { candidateLoops: candidateLoops.length });
    const evaluated = await deps.loopEvaluator.execute({
      candidateLoops,
      episodesByLoop,
      progress,
    });
    progress.endPhase("loop_evaluator", {
      qualifiedLoops: evaluated.evaluations.length,
      aiCalls: evaluated.aiCalls,
      batchesProcessed: evaluated.phaseUsage.batchesProcessed,
      batchesSkipped: evaluated.phaseUsage.batchesSkipped,
    });
    flushProgress(deps, auth, runId, progress);
    mergeCleanupAiUsage(summary.usage, evaluated.usage);
    summary.aiCalls += evaluated.aiCalls;
    summary.loopsQualified = evaluated.evaluations.length;
    summary.phaseUsage = {
      ...(summary.phaseUsage ?? {}),
      loopEvaluator: normalizePhaseUsage(evaluated.phaseUsage),
    };
    if (evaluated.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...evaluated.warnings];
    }

    const qualifiedLoops = evaluated.evaluations
      .map((evaluation) => {
        const candidateLoop = findCandidateForEvaluation(candidateLoops, evaluation);
        if (!candidateLoop) return null;
        return {
          candidateLoop,
          evaluation,
          episodes: episodesByLoop.get(keyForLoop(candidateLoop)) ?? [],
        };
      })
      .filter((item): item is { candidateLoop: CandidateLoop; evaluation: LoopEvaluation; episodes: EpisodeRecord[] } => {
        return item !== null && item.episodes.length >= 2;
      });

    progress.startPhase("dna_generator", { qualifiedLoops: qualifiedLoops.length });
    const generated = await deps.dnaGenerator.execute({ qualifiedLoops, progress });
    progress.endPhase("dna_generator", {
      workflowsGenerated: generated.dna.length,
      aiCalls: generated.aiCalls,
      batchesProcessed: generated.phaseUsage.batchesProcessed,
      batchesSkipped: generated.phaseUsage.batchesSkipped,
    });
    flushProgress(deps, auth, runId, progress);
    mergeCleanupAiUsage(summary.usage, generated.usage);
    summary.aiCalls += generated.aiCalls;
    summary.phaseUsage = {
      ...(summary.phaseUsage ?? {}),
      dnaGenerator: normalizePhaseUsage(generated.phaseUsage),
    };
    if (generated.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...generated.warnings];
    }

    progress.startPhase("persist_suggestions", { workflowsToPersist: generated.dna.length });
    const suggestions = [];
    let suggestionsUpdated = 0;
    for (const item of generated.dna) {
      const suggestedPrompt = workflowDnaPrompt(item.workflowDna);
      const writeResult = deps.repository.createOrUpdateWorkflowSuggestion
        ? await deps.repository.createOrUpdateWorkflowSuggestion({
            auth,
            runId,
            candidateLoop: item.candidateLoop,
            evaluation: item.evaluation,
            dna: item.workflowDna,
            suggestedPrompt,
            fingerprint: workflowDnaFingerprint(item.workflowDna),
            loopParent: pickLoopParentForCandidate(item.candidateLoop, loopParents),
          })
        : {
            suggestion: await deps.repository.createWorkflowSuggestion({
              auth,
              runId,
              candidateLoop: item.candidateLoop,
              evaluation: item.evaluation,
              dna: item.workflowDna,
              suggestedPrompt,
              fingerprint: workflowDnaFingerprint(item.workflowDna),
              loopParent: pickLoopParentForCandidate(item.candidateLoop, loopParents),
            }),
            created: false,
            updated: false,
          };
      if (writeResult.suggestion) suggestions.push(writeResult.suggestion);
      if (writeResult.updated) suggestionsUpdated += 1;
    }
    summary.suggestionsCreated = suggestions.length - suggestionsUpdated;
    if (summary.incremental) {
      summary.incremental.suggestionsUpdated = suggestionsUpdated;
    }
    progress.endPhase("persist_suggestions", {
      suggestionsPersisted: suggestions.length,
      suggestionsUpdated,
    });
    summary = attachProgressTrace(finalizeSummary(summary, startedAt), progress);
    await deps.repository.completeRun({ auth, runId, status: "completed", summary });
    logger.info("loop miner run completed", { runId, ...loggableSummary(summary), ...progress.snapshot() });
    return { id: runId, status: "completed", summary, suggestions };
  } catch (error) {
    summary = attachProgressTrace(finalizeSummary(summary, startedAt), progress);
    await deps.repository.completeRun({
      auth,
      runId,
      status: "failed",
      summary,
      error: errorJson(error),
    }).catch(() => {});
    logger.error("loop miner run failed", { runId, error: errorJson(error), ...progress.snapshot() });
    return { id: runId, status: "failed", summary, suggestions: [] };
  }
}

function projectEpisodesTo2d(episodes: Array<{ episode: EpisodeRecord; vector: number[] }>): LoopMinerEpisodeEmbeddingPoint[] {
  if (episodes.length === 0) return [];
  if (episodes.length === 1) {
    const only = episodes[0];
    return [{
      episodeId: only.episode.id,
      intent: only.episode.intent,
      outputType: only.episode.outputType,
      sealedAt: only.episode.sealedAt,
      turnCount: only.episode.turnCount,
      sources: only.episode.sources,
      embeddingStatus: only.episode.embeddingStatus,
      x: 0,
      y: 0,
    }];
  }

  const sampleCount = episodes.length;
  const dims = Math.max(...episodes.map(({ vector }) => vector.length));
  if (dims <= 0) return [];

  const matrix = episodes.map(({ vector }) => {
    const row = new Array<number>(dims).fill(0);
    for (let index = 0; index < vector.length; index += 1) row[index] = vector[index] ?? 0;
    return row;
  });

  const means = new Array<number>(dims).fill(0);
  for (const row of matrix) {
    for (let dim = 0; dim < dims; dim += 1) means[dim] += row[dim];
  }
  for (let dim = 0; dim < dims; dim += 1) means[dim] /= sampleCount;
  for (const row of matrix) {
    for (let dim = 0; dim < dims; dim += 1) row[dim] -= means[dim];
  }

  const multiplyCovariance = (vector: number[]): number[] => {
    const result = new Array<number>(dims).fill(0);
    const scale = sampleCount > 1 ? 1 / (sampleCount - 1) : 1;
    for (const row of matrix) {
      let dot = 0;
      for (let dim = 0; dim < dims; dim += 1) dot += row[dim] * vector[dim];
      if (Math.abs(dot) <= 1e-12) continue;
      for (let dim = 0; dim < dims; dim += 1) result[dim] += row[dim] * dot;
    }
    for (let dim = 0; dim < dims; dim += 1) result[dim] *= scale;
    return result;
  };

  const normalizeVector = (vector: number[]): number[] => {
    let normSquared = 0;
    for (const value of vector) normSquared += value * value;
    const norm = Math.sqrt(normSquared);
    if (!Number.isFinite(norm) || norm <= 1e-12) return vector.map(() => 0);
    return vector.map((value) => value / norm);
  };

  const powerIteration = (orthogonalTo?: number[]): number[] => {
    let candidate = normalizeVector(new Array<number>(dims).fill(1 / Math.sqrt(Math.max(1, dims))));
    for (let iteration = 0; iteration < 40; iteration += 1) {
      let next = multiplyCovariance(candidate);
      if (orthogonalTo) {
        let projection = 0;
        for (let dim = 0; dim < dims; dim += 1) projection += next[dim] * orthogonalTo[dim];
        for (let dim = 0; dim < dims; dim += 1) next[dim] -= projection * orthogonalTo[dim];
      }
      candidate = normalizeVector(next);
    }
    return candidate;
  };

  const componentX = powerIteration();
  const componentY = powerIteration(componentX);
  const xValues = matrix.map((row) => row.reduce((sum, value, dim) => sum + (value * componentX[dim]), 0));
  const yValues = matrix.map((row) => row.reduce((sum, value, dim) => sum + (value * componentY[dim]), 0));
  const maxAbsX = Math.max(...xValues.map((value) => Math.abs(value)), 1e-9);
  const maxAbsY = Math.max(...yValues.map((value) => Math.abs(value)), 1e-9);

  return episodes.map(({ episode }, index) => ({
    episodeId: episode.id,
    intent: episode.intent,
    outputType: episode.outputType,
    sealedAt: episode.sealedAt,
    turnCount: episode.turnCount,
    sources: episode.sources,
    embeddingStatus: episode.embeddingStatus,
    x: xValues[index] / maxAbsX,
    y: yValues[index] / maxAbsY,
  }));
}

export async function getLoopMinerRunForUser(auth: AuthContext, runId: string): Promise<LoopMinerRunView | null> {
  const repo = new PgLoopMinerRepository();
  return repo.getRunView(auth, runId);
}

export async function getLoopMinerRunEmbeddingMapForUser(
  auth: AuthContext,
  runId: string
): Promise<LoopMinerEpisodeEmbeddingMapView | null> {
  const run = await getLoopMinerRunForUser(auth, runId);
  if (!run) return null;

  const episodes = run.episodes;
  const episodeIds = episodes.map((episode) => episode.id);
  if (!config.qdrantUrl) {
    return {
      runId,
      points: [],
      meta: {
        totalEpisodes: episodes.length,
        mappedEpisodes: 0,
        missingEpisodeIds: episodeIds,
        vectorStoreEnabled: false,
        reason: "Loop vector store is disabled.",
      },
    };
  }

  try {
    await loopEpisodeVectorRepository.ensureReady();
    const vectors = await loopEpisodeVectorRepository.getEpisodeVectors({ auth, episodeIds });
    const projected = projectEpisodesTo2d(
      episodes
        .map((episode) => {
          const vector = vectors.get(episode.id) ?? null;
          if (!vector || vector.length === 0) return null;
          return { episode, vector };
        })
        .filter((value): value is { episode: EpisodeRecord; vector: number[] } => value !== null)
    );
    const mappedIds = new Set(projected.map((point) => point.episodeId));
    return {
      runId,
      points: projected,
      meta: {
        totalEpisodes: episodes.length,
        mappedEpisodes: projected.length,
        missingEpisodeIds: episodeIds.filter((id) => !mappedIds.has(id)),
        vectorStoreEnabled: true,
      },
    };
  } catch (error) {
    return {
      runId,
      points: [],
      meta: {
        totalEpisodes: episodes.length,
        mappedEpisodes: 0,
        missingEpisodeIds: episodeIds,
        vectorStoreEnabled: true,
        reason: `Failed to load episode vectors: ${errorMessage(error)}`,
      },
    };
  }
}

export async function listLoopMinerRunsForUser(auth: AuthContext, limit = 10): Promise<LoopMinerRunView[]> {
  const repo = new PgLoopMinerRepository();
  return repo.listRunViews(auth, limit);
}

export interface LoopMinerRunStatus {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  episodesBuilt: number;
  loopsDetected: number;
  loopsQualified: number;
  suggestionsCreated: number;
  liveProgress: LoopMinerSummary["liveProgress"] | null;
  warnings: string[];
}

export async function getLoopMinerRunStatusForUser(auth: AuthContext, runId: string): Promise<LoopMinerRunStatus | null> {
  const result = await pool.query<{
    id: string;
    status: string;
    created_at: string;
    completed_at: string | null;
    episodes_built: number;
    loops_detected: number;
    loops_qualified: number;
    suggestions_created: number;
    summary_json: unknown;
  }>(
    `SELECT id, status, created_at, completed_at,
            episodes_built, loops_detected, loops_qualified, suggestions_created,
            summary_json
     FROM loop_miner_runs
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [runId, auth.tenantId, auth.userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const rawSummary = row.summary_json && typeof row.summary_json === "object" && !Array.isArray(row.summary_json)
    ? row.summary_json as Record<string, unknown>
    : {};
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    episodesBuilt: Number(row.episodes_built ?? 0),
    loopsDetected: Number(row.loops_detected ?? 0),
    loopsQualified: Number(row.loops_qualified ?? 0),
    suggestionsCreated: Number(row.suggestions_created ?? 0),
    liveProgress: (rawSummary.liveProgress as LoopMinerSummary["liveProgress"]) ?? null,
    warnings: Array.isArray(rawSummary.warnings) ? rawSummary.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}

export async function queueLoopMinerRunForUser(
  auth: AuthContext,
  options: RunLoopMinerOptions = {}
): Promise<LoopMinerRunView | null> {
  const runReason = options.runReason ?? "manual";
  const lookbackDays = Math.max(1, Math.min(options.lookbackDays ?? 30, 90));
  const deps = createDefaultDeps();
  await deps.repository.markStaleRunningRunsFailed?.(auth, STALE_RUNNING_MAX_AGE_MS).catch(() => {});
  const runId = await deps.repository.createRun({ auth, runReason });
  logger.info("loop miner background run queued", { runId, runReason, lookbackDays });

  void runLoopMinerForUser(auth, { ...options, runReason, lookbackDays, runId }, deps)
    .then(async (result) => {
      logger.info("loop miner background run settled", {
        runId,
        status: result.status,
        durationMs: result.summary.durationMs,
        warnings: result.summary.warnings?.length ?? 0,
        loopsQualified: result.summary.loopsQualified,
        suggestionsCreated: result.summary.suggestionsCreated,
      });
      await sendLoopMinerCompletionSlack({
        auth,
        runId,
        status: result.status,
        summary: result.summary,
      }).catch((error) => {
        logger.warn("loop miner slack notification crashed", { runId, error: errorJson(error) });
      });
    })
    .catch((error) => {
      logger.error("loop miner background run crashed", {
        runId,
        error: errorJson(error),
      });
      void sendAdminSlackMessage({
        text: [
          "Tallei Loop Miner crashed",
          `Tenant: ${auth.tenantId}`,
          `User: ${auth.userId}`,
          `Run: ${runId}`,
          `Error: ${errorMessage(error)}`,
          `Dashboard: ${new URL("/dashboard/memory-cleanup", config.dashboardBaseUrl).toString()}`,
        ].join("\n"),
      }).catch(() => {});
    });

  const repo = new PgLoopMinerRepository();
  return repo.getRunView(auth, runId);
}
