import type { AuthContext } from "../../domain/auth/index.js";

import { createHash } from "crypto";
import { config } from "../../config/index.js";
import { embedText } from "../../infrastructure/cache/embedding-cache.js";
import {
  LoopEpisodeGroupedResult,
  LoopEpisodeVectorRepository,
} from "../../infrastructure/repositories/loop-episode-vector.repository.js";
import { LoopMinerRepository as PgLoopMinerRepository } from "../../infrastructure/repositories/loop-miner.repository.js";
import { createLogger } from "../../observability/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import { withTimeout } from "../../resilience/timeout.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage } from "../memory-cleanup/usage.js";
import { DnaGeneratorUseCase } from "./dna-generator.usecase.js";
import { EpisodeBuilderUseCase } from "./episode-builder.usecase.js";
import { LoopDetectorUseCase } from "./loop-detector.usecase.js";
import { LoopEvaluatorUseCase } from "./loop-evaluator.usecase.js";
import type {
  CandidateLoop,
  EpisodeRecord,
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

async function loopMinerChat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  return withTimeout(
    (signal) => aiProviderRegistry.chatDirect({ ...request, signal }),
    config.loopMinerChatTimeoutMs,
    { message: `Loop miner chat timed out after ${config.loopMinerChatTimeoutMs}ms` }
  );
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
  return {
    considered: decisions.length,
    included: decisions.filter((decision) => decision.status === "included").length,
    excluded: decisions.filter((decision) => decision.status === "excluded").length,
    sourceImportsIncluded: decisions.filter((decision) => decision.status === "included" && decision.sourceImport).length,
    unbucketedIncluded: decisions.filter((decision) => decision.status === "included" && !decision.sourceImport && !decision.cleanupBucket).length,
    bucketedExcluded: decisions.filter((decision) => decision.status === "excluded" && decision.reason === "bucketed_memory_deprioritized").length,
    decryptFailures: decisions.filter((decision) => decision.reason === "decrypt_failed").length,
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
  try {
    logger.info("loop miner run started", { runId, runReason, lookbackDays });
    let events = await deps.repository.listRecentEvents(auth, lookbackDays);
    const eventCountsBeforeFallback = countEventsByType(events);
    if (deps.repository.listMemoryDecisionLog) {
      try {
        const memoryDecisionLog = await deps.repository.listMemoryDecisionLog(auth, lookbackDays);
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
      const suggestions = deps.repository.listReusableLoopMinerSuggestions
        ? await deps.repository.listReusableLoopMinerSuggestions(auth)
        : [];
      summary = finalizeSummary({
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
      }, startedAt);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run skipped with no new evidence", { runId, reusedSuggestions: suggestions.length });
      return { id: runId, status: "completed", summary, suggestions };
    }

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

    if (latestIncremental && newMemoryEvents.length === 0) {
      const suggestions = deps.repository.listReusableLoopMinerSuggestions
        ? await deps.repository.listReusableLoopMinerSuggestions(auth)
        : [];
      summary = finalizeSummary({
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
      }, startedAt);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run skipped with no new memory evidence", { runId, reusedSuggestions: suggestions.length });
      return { id: runId, status: "completed", summary, suggestions };
    }

    const built = await deps.episodeBuilder.execute({ auth, runId, events: eventsForEpisodeBuilder });
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
      const suggestions = deps.repository.listReusableLoopMinerSuggestions
        ? await deps.repository.listReusableLoopMinerSuggestions(auth)
        : [];
      if (summary.incremental) {
        summary.incremental.reusedSuggestions = suggestions.length;
      }
      summary = finalizeSummary({
        ...summary,
        skipped: true,
        skipReason: "no_new_loop_episodes",
      }, startedAt);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run skipped because new evidence produced no episodes", { runId, newMemoryEvents: newMemoryEvents.length });
      return { id: runId, status: "completed", summary, suggestions };
    }

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
    if (loopVectorSearchEnabled && deps.repository.updateEpisodeEmbeddingMetadata) {
      for (const episode of built.episodes) {
        const canonicalFacet = deriveCanonicalLoopFacet(episode);
        const embeddingText = episodeEmbeddingText(episode);
        const embeddingHash = episodeEmbeddingTextHash(embeddingText);
        let vector: number[];
        try {
          vector = await embedText(embeddingText);
        } catch (error) {
          summary.warnings = [
            ...(summary.warnings ?? []),
            `Loop episode embedding failed for episode ${episode.id}: ${errorMessage(error)}`,
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

        const shouldUpsert = episode.embeddingTextHash !== embeddingHash || episode.embeddingStatus !== "ready";
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
          for (const hit of similar) {
            if (hit.score >= 0.72) similarEpisodeIds.add(hit.episodeId);
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
    }

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

    const detected = await deps.loopDetector.execute(detectorEpisodes);
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

    const evaluated = await deps.loopEvaluator.execute({
      candidateLoops,
      episodesByLoop,
    });
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

    const generated = await deps.dnaGenerator.execute({ qualifiedLoops });
    mergeCleanupAiUsage(summary.usage, generated.usage);
    summary.aiCalls += generated.aiCalls;
    summary.phaseUsage = {
      ...(summary.phaseUsage ?? {}),
      dnaGenerator: normalizePhaseUsage(generated.phaseUsage),
    };
    if (generated.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...generated.warnings];
    }

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
    summary = finalizeSummary(summary, startedAt);
    await deps.repository.completeRun({ auth, runId, status: "completed", summary });
    logger.info("loop miner run completed", { runId, ...loggableSummary(summary) });
    return { id: runId, status: "completed", summary, suggestions };
  } catch (error) {
    summary = finalizeSummary(summary, startedAt);
    await deps.repository.completeRun({
      auth,
      runId,
      status: "failed",
      summary,
      error: errorJson(error),
    }).catch(() => {});
    logger.error("loop miner run failed", { runId, error: errorJson(error) });
    return { id: runId, status: "failed", summary, suggestions: [] };
  }
}

export async function listLoopMinerRunsForUser(auth: AuthContext, limit = 10): Promise<LoopMinerRunView[]> {
  return new PgLoopMinerRepository().listRunViews(auth, limit);
}

export async function queueLoopMinerRunForUser(
  auth: AuthContext,
  options: RunLoopMinerOptions = {}
): Promise<LoopMinerRunView | null> {
  const runReason = options.runReason ?? "manual";
  const lookbackDays = Math.max(1, Math.min(options.lookbackDays ?? 30, 90));
  const deps = createDefaultDeps();
  const runId = await deps.repository.createRun({ auth, runReason });
  logger.info("loop miner background run queued", { runId, runReason, lookbackDays });

  void runLoopMinerForUser(auth, { ...options, runReason, lookbackDays, runId }, deps)
    .then((result) => {
      logger.info("loop miner background run settled", {
        runId,
        status: result.status,
        durationMs: result.summary.durationMs,
        warnings: result.summary.warnings?.length ?? 0,
        loopsQualified: result.summary.loopsQualified,
        suggestionsCreated: result.summary.suggestionsCreated,
      });
    })
    .catch((error) => {
      logger.error("loop miner background run crashed", {
        runId,
        error: errorJson(error),
      });
    });

  const repo = new PgLoopMinerRepository();
  return repo.getRunView(auth, runId);
}
