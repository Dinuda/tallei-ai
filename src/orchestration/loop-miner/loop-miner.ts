import type { AuthContext } from "../../domain/auth/index.js";

import { config } from "../../config/index.js";
import { sendAdminSlackMessage } from "../../infrastructure/notifications/admin-slack.js";
import { LoopMinerRepository as PgLoopMinerRepository } from "../../infrastructure/repositories/loop-miner.repository.js";
import { pool } from "../../infrastructure/db/index.js";
import { createLogger } from "../../observability/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import { withTimeout } from "../../resilience/timeout.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage } from "../memory-cleanup/usage.js";
import { DnaGeneratorUseCase } from "./dna-generator.usecase.js";
import { EpisodeBuilderUseCase } from "./episode-builder.usecase.js";
import { LoopImplementabilityFilterUseCase } from "./implementability-filter.usecase.js";
import { LoopDetectorUseCase } from "./loop-detector.usecase.js";
import { LoopEvaluatorUseCase } from "./loop-evaluator.usecase.js";
import { LoopMinerRunProgress } from "./run-progress.js";
import type {
  CandidateLoop,
  EpisodeRecord,
  LoopMinerEpisodeEmbeddingMapView,
  LoopEvaluation,
  PhaseUsageMetrics,
  LoopMinerRepository,
  LoopMinerRunReason,
  LoopMinerRunResult,
  LoopMinerRunView,
  LoopMinerSummary,
} from "./types.js";
import {
  workflowDnaFingerprint,
  workflowDnaPrompt,
} from "./utils.js";
import { buildLoopMinerEpisodeEmbeddingMap, projectEpisodesLexically } from "./episode-embedding-map.js";

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
  implementabilityFilter?: LoopImplementabilityFilterUseCase;
  dnaGenerator: DnaGeneratorUseCase;
}

const logger = createLogger({ baseFields: { component: "loop_miner" } });
const STALE_RUNNING_MAX_AGE_MS = 60 * 60 * 1000;

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

function modelRejectsExplicitTemperature(model: string | undefined): boolean {
  if (!model) return false;
  return model.toLowerCase().startsWith("gpt-5");
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
    liveProgress: snapshot,
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
    implementabilityFilter: new LoopImplementabilityFilterUseCase(),
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

function memoryIdsFromLoopGroups(groups: Array<{ episodeIds: string[] }>): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const id of group.episodeIds) ids.add(id);
  }
  return ids;
}

function memoriesCoveredByEpisodes(memoryIds: Set<string>, episodes: EpisodeRecord[]): Set<string> {
  const covered = new Set<string>();
  for (const episode of episodes) {
    for (const id of episode.eventIds) {
      if (memoryIds.has(id)) covered.add(id);
    }
    for (const turn of episode.turns) {
      if (memoryIds.has(turn.sourceEventId)) covered.add(turn.sourceEventId);
    }
  }
  return covered;
}

function candidateLoopsFromMemoryGroups(
  groups: Array<{
    episodeIds: string[];
    loopName: string;
    sharedIntent: string;
    sharedSources: string[];
    sharedOutputType: string;
    reasoning: string;
    loopLayer?: CandidateLoop["loopLayer"];
    confidence: number;
    status: CandidateLoop["patternStatus"];
  }>,
  episodes: EpisodeRecord[],
): CandidateLoop[] {
  const loops: CandidateLoop[] = [];
  for (const group of groups) {
    const memoryIdSet = new Set(group.episodeIds);
    const matchingEpisodes = episodes.filter((episode) =>
      episode.eventIds.some((id) => memoryIdSet.has(id))
      || episode.turns.some((turn) => memoryIdSet.has(turn.sourceEventId))
    );
    const uniqueEpisodes = [...new Map(matchingEpisodes.map((episode) => [episode.id, episode])).values()];
    const coveredMemories = memoriesCoveredByEpisodes(memoryIdSet, uniqueEpisodes);
    if (uniqueEpisodes.length < 2 && coveredMemories.size < 2) continue;
    loops.push({
      loopName: group.loopName,
      episodeIds: uniqueEpisodes.map((episode) => episode.id),
      sharedIntent: group.sharedIntent,
      sharedSources: group.sharedSources,
      sharedOutputType: group.sharedOutputType,
      reasoning: group.reasoning,
      loopLayer: group.loopLayer,
      patternConfidence: group.confidence,
      patternStatus: group.status,
    });
  }
  return loops;
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
  const progress = new LoopMinerRunProgress(runId);

  try {
    logger.info("loop miner run started", { runId, runReason, lookbackDays });

    // Phase 1: Ingest memories (source of truth)
    progress.startPhase("memory_ingest", { lookbackDays });
    const memories = await deps.repository.listRecentEvents(auth, lookbackDays, { processAll: true });
    progress.endPhase("memory_ingest", { memoryCount: memories.length });
    flushProgress(deps, auth, runId, progress);
    logger.info("loop miner memories ingested", { runId, memoryCount: memories.length });

    if (memories.length === 0) {
      summary = attachProgressTrace(finalizeSummary({
        ...summary,
        skipped: true,
        skipReason: "no_memories",
      }, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run skipped: no memories", { runId });
      return { id: runId, status: "completed", summary, suggestions: [] };
    }

    if (memories.length < 2) {
      summary = attachProgressTrace(finalizeSummary({
        ...summary,
        skipped: true,
        skipReason: "insufficient_memories_for_loops",
      }, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run skipped: need at least 2 memories", { runId, memoryCount: memories.length });
      return { id: runId, status: "completed", summary, suggestions: [] };
    }

    // Phase 2: Detect loops directly in memories
    progress.startPhase("loop_detector", { inputMemories: memories.length });
    flushProgress(deps, auth, runId, progress);
    const detectedFromMemories = await deps.loopDetector.executeOnMemories(memories, { runId, progress });
    progress.endPhase("loop_detector", {
      candidateGroups: detectedFromMemories.patternTrace.candidateGroups.length,
      approvedLoops: detectedFromMemories.approvedGroups.length,
      aiCalls: detectedFromMemories.aiCalls,
      batchesProcessed: detectedFromMemories.phaseUsage.batchesProcessed,
      batchesSkipped: detectedFromMemories.phaseUsage.batchesSkipped,
    });
    flushProgress(deps, auth, runId, progress);
    mergeCleanupAiUsage(summary.usage, detectedFromMemories.usage);
    summary.aiCalls += detectedFromMemories.aiCalls;
    summary.loopsDetected = detectedFromMemories.approvedGroups.length;
    summary.loopsProposed = detectedFromMemories.patternTrace.candidateGroups.length;
    summary.loopsApproved = detectedFromMemories.patternTrace.approvedGroups.length;
    summary.loopsRejected = detectedFromMemories.patternTrace.rejectedGroups.length;
    summary.loopsContested = detectedFromMemories.patternTrace.adversaryFindings.filter((f) => f.contested).length;
    summary.loopsAutoApproved = detectedFromMemories.patternTrace.judgeDecisions.filter((d) => d.status === "approved_loop" && d.confidence >= 0.85).length;
    summary.patternTrace = detectedFromMemories.patternTrace;
    summary.phaseUsage = { ...(summary.phaseUsage ?? {}), loopDetector: normalizePhaseUsage(detectedFromMemories.phaseUsage) };
    if (detectedFromMemories.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...detectedFromMemories.warnings];
    }

    if (detectedFromMemories.approvedGroups.length === 0) {
      summary = attachProgressTrace(finalizeSummary(summary, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run completed: no loops found in memories", { runId, memoryCount: memories.length });
      return { id: runId, status: "completed", summary, suggestions: [] };
    }

    const loopMemoryIds = memoryIdsFromLoopGroups(detectedFromMemories.approvedGroups);
    const loopMemories = memories.filter((memory) => loopMemoryIds.has(memory.id));
    progress.step("loop memories selected for episode building", {
      loopMemories: loopMemories.length,
      totalMemories: memories.length,
    });
    flushProgress(deps, auth, runId, progress);

    // Phase 3: Build episodes only for memories in detected loops
    progress.startPhase("episode_builder", { inputEvents: loopMemories.length, loopCount: detectedFromMemories.approvedGroups.length });
    flushProgress(deps, auth, runId, progress);
    const built = await deps.episodeBuilder.execute({
      auth,
      runId,
      events: loopMemories,
      progress,
      disableEpisodeReuse: true,
      forceDeterministicPerMemory: true,
    });
    progress.endPhase("episode_builder", {
      episodesBuilt: built.episodes.length,
      aiCalls: built.aiCalls,
      batchesProcessed: built.phaseUsage.batchesProcessed,
      batchesSkipped: built.phaseUsage.batchesSkipped,
    });
    flushProgress(deps, auth, runId, progress);
    mergeCleanupAiUsage(summary.usage, built.usage);
    summary.aiCalls += built.aiCalls;
    summary.episodesBuilt = new Set(built.episodes.map((episode) => episode.id)).size;
    summary.phaseUsage = { ...(summary.phaseUsage ?? {}), episodeBuilder: built.phaseUsage };
    if (built.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...built.warnings];
    }

    if (built.episodes.length === 0) {
      summary = attachProgressTrace(finalizeSummary({
        ...summary,
        skipped: true,
        skipReason: "no_episodes_from_loop_memories",
      }, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run skipped: no episodes built from loop memories", { runId, loopMemories: loopMemories.length });
      return { id: runId, status: "completed", summary, suggestions: [] };
    }

    const candidateLoops = candidateLoopsFromMemoryGroups(detectedFromMemories.approvedGroups, built.episodes);
    summary.loopsEpisodeAligned = candidateLoops.length;
    if (candidateLoops.length === 0) {
      summary = attachProgressTrace(finalizeSummary(summary, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run completed: loops found in memories but episodes did not align", { runId, episodesBuilt: built.episodes.length });
      return { id: runId, status: "completed", summary, suggestions: [] };
    }

    // Phase 4: Evaluate and qualify loops
    const episodesByLoop = new Map<string, EpisodeRecord[]>();
    for (const loop of candidateLoops) {
      episodesByLoop.set(keyForLoop(loop), await deps.repository.listEpisodeContext(auth, loop.episodeIds));
    }

    progress.startPhase("loop_evaluator", { candidateLoops: candidateLoops.length });
    flushProgress(deps, auth, runId, progress);
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
    summary.phaseUsage = { ...(summary.phaseUsage ?? {}), loopEvaluator: normalizePhaseUsage(evaluated.phaseUsage) };
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

    if (qualifiedLoops.length === 0) {
      summary = attachProgressTrace(finalizeSummary(summary, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run completed: no qualified loops", { runId, loopsDetected: candidateLoops.length });
      return { id: runId, status: "completed", summary, suggestions: [] };
    }

    // Phase 5: Filter out loops that cannot be implemented with available integrations.
    const activeCapabilities = deps.repository.listActiveImplementationCapabilities
      ? await deps.repository.listActiveImplementationCapabilities(auth)
      : [];
    const implementabilityFilter = deps.implementabilityFilter ?? new LoopImplementabilityFilterUseCase();
    progress.startPhase("implementability_filter", {
      qualifiedLoops: qualifiedLoops.length,
      activeCapabilities: activeCapabilities.length,
    });
    const implementability = implementabilityFilter.execute({
      qualifiedLoops,
      activeCapabilities,
    });
    progress.endPhase("implementability_filter", {
      implementableLoops: implementability.implementable.length,
      blockedLoops: implementability.blocked.length,
    });
    flushProgress(deps, auth, runId, progress);

    summary.loopsImplementable = implementability.implementable.length;
    summary.loopsBlocked = implementability.blocked.length;
    summary.debugTrace = {
      ...(summary.debugTrace ?? {}),
      implementability: {
        activeCapabilities,
        loopsInput: qualifiedLoops.length,
        loopsImplementable: implementability.implementable.length,
        loopsBlocked: implementability.blocked.length,
        blocked: implementability.blocked.slice(0, 12).map((item) => ({
          loopName: item.candidateLoop.loopName,
          missingCapabilities: item.implementability.missingCapabilities,
          blockers: item.implementability.blockers,
        })),
      },
    };

    if (implementability.implementable.length === 0) {
      summary = attachProgressTrace(finalizeSummary(summary, startedAt), progress);
      await deps.repository.completeRun({ auth, runId, status: "completed", summary });
      logger.info("loop miner run completed: no implementable loops", {
        runId,
        qualifiedLoops: qualifiedLoops.length,
        blockedLoops: implementability.blocked.length,
      });
      return { id: runId, status: "completed", summary, suggestions: [] };
    }

    const implementabilityByLoopKey = new Map(
      implementability.implementable.map((item) => [keyForLoop(item.candidateLoop), item.implementability])
    );

    // Phase 6: Generate workflow DNA
    progress.startPhase("dna_generator", { qualifiedLoops: implementability.implementable.length });
    flushProgress(deps, auth, runId, progress);
    const generated = await deps.dnaGenerator.execute({ qualifiedLoops: implementability.implementable, progress });
    progress.endPhase("dna_generator", {
      workflowsGenerated: generated.dna.length,
      aiCalls: generated.aiCalls,
      batchesProcessed: generated.phaseUsage.batchesProcessed,
      batchesSkipped: generated.phaseUsage.batchesSkipped,
    });
    flushProgress(deps, auth, runId, progress);
    mergeCleanupAiUsage(summary.usage, generated.usage);
    summary.aiCalls += generated.aiCalls;
    summary.phaseUsage = { ...(summary.phaseUsage ?? {}), dnaGenerator: normalizePhaseUsage(generated.phaseUsage) };
    if (generated.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...generated.warnings];
    }

    // Phase 7: Persist suggestions
    progress.startPhase("persist_suggestions", { workflowsToPersist: generated.dna.length });
    const suggestions = [];
    let suggestionsUpdated = 0;
    for (const item of generated.dna) {
      const suggestedPrompt = workflowDnaPrompt(item.workflowDna);
      const fingerprint = workflowDnaFingerprint(item.workflowDna);
      const writeResult = deps.repository.createOrUpdateWorkflowSuggestion
        ? await deps.repository.createOrUpdateWorkflowSuggestion({
            auth,
            runId,
            candidateLoop: item.candidateLoop,
            evaluation: item.evaluation,
            dna: item.workflowDna,
            suggestedPrompt,
            fingerprint,
            implementability: implementabilityByLoopKey.get(keyForLoop(item.candidateLoop)),
          })
        : {
            suggestion: await deps.repository.createWorkflowSuggestion({
              auth,
              runId,
              candidateLoop: item.candidateLoop,
              evaluation: item.evaluation,
              dna: item.workflowDna,
              suggestedPrompt,
              fingerprint,
              implementability: implementabilityByLoopKey.get(keyForLoop(item.candidateLoop)),
            }),
            created: false,
            updated: false,
          };
      if (writeResult.suggestion) suggestions.push(writeResult.suggestion);
      if (writeResult.updated) suggestionsUpdated += 1;
    }
    summary.suggestionsCreated = suggestions.length - suggestionsUpdated;
    progress.endPhase("persist_suggestions", {
      suggestionsPersisted: suggestions.length,
      suggestionsUpdated,
    });
    flushProgress(deps, auth, runId, progress);

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

export async function getLoopMinerRunForUser(auth: AuthContext, runId: string): Promise<LoopMinerRunView | null> {
  const repo = new PgLoopMinerRepository();
  return repo.getRunView(auth, runId);
}

export async function getLoopMinerRunEmbeddingMapForUser(
  auth: AuthContext,
  runId: string
): Promise<LoopMinerEpisodeEmbeddingMapView | null> {
  const repo = new PgLoopMinerRepository();
  const episodes = await repo.listEpisodesForMinerRun(auth, runId);
  if (episodes === null) return null;

  try {
    return await buildLoopMinerEpisodeEmbeddingMap({
      auth,
      runId,
      episodes,
      repository: repo,
    });
  } catch (error) {
    const lexicalPoints = projectEpisodesLexically(episodes);
    return {
      runId,
      points: lexicalPoints,
      meta: {
        totalEpisodes: episodes.length,
        mappedEpisodes: lexicalPoints.length,
        missingEpisodeIds: [],
        vectorStoreEnabled: Boolean(config.qdrantUrl),
        reason: lexicalPoints.length > 0
          ? `Failed to build episode embedding map: ${errorMessage(error)}; showing lexical layout fallback.`
          : `Failed to build episode embedding map: ${errorMessage(error)}`,
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
  loopsFound: boolean | null;
  currentPhase: string | null;
  memoryCount: number;
  suggestionsCreated: number;
  liveProgress: LoopMinerSummary["liveProgress"] | null;
  warnings: string[];
}

function readNumericField(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(numeric) ? numeric : 0;
}

function latestLivePhase(
  liveProgress: LoopMinerSummary["liveProgress"] | null,
  phaseName: string
): NonNullable<LoopMinerSummary["liveProgress"]>["phaseTimings"][number] | null {
  const phases = liveProgress?.phaseTimings ?? [];
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (phase?.phase === phaseName) return phase;
  }
  return null;
}

function currentLivePhase(liveProgress: LoopMinerSummary["liveProgress"] | null): string | null {
  const phases = liveProgress?.phaseTimings ?? [];
  const running = [...phases].reverse().find((phase) => phase.status === "running");
  return running?.phase ?? phases.at(-1)?.phase ?? null;
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
  const liveProgress = (rawSummary.liveProgress as LoopMinerSummary["liveProgress"]) ?? null;
  const memoryIngestPhase = latestLivePhase(liveProgress, "memory_ingest");
  const loopDetectorPhase = latestLivePhase(liveProgress, "loop_detector");
  const loopEvaluatorPhase = latestLivePhase(liveProgress, "loop_evaluator");
  const liveLoopsDetected = Math.max(
    Number(row.loops_detected ?? 0),
    readNumericField(loopDetectorPhase?.details, "approvedLoops"),
    readNumericField(rawSummary, "loopsDetected")
  );
  const liveLoopsQualified = Math.max(
    Number(row.loops_qualified ?? 0),
    readNumericField(loopEvaluatorPhase?.details, "qualifiedLoops"),
    readNumericField(rawSummary, "loopsQualified")
  );
  const loopsFound = row.status === "running" ? null : liveLoopsDetected > 0;
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    episodesBuilt: Number(row.episodes_built ?? 0),
    loopsDetected: liveLoopsDetected,
    loopsQualified: liveLoopsQualified,
    loopsFound,
    currentPhase: currentLivePhase(liveProgress),
    memoryCount: readNumericField(memoryIngestPhase?.details, "memoryCount"),
    suggestionsCreated: Number(row.suggestions_created ?? 0),
    liveProgress,
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
