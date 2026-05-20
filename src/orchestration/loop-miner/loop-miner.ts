import type { AuthContext } from "../../domain/auth/index.js";
import { LoopMinerRepository as PgLoopMinerRepository } from "../../infrastructure/repositories/loop-miner.repository.js";
import { createLogger } from "../../observability/index.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage } from "../memory-cleanup/usage.js";
import { DnaGeneratorUseCase } from "./dna-generator.usecase.js";
import { EpisodeBuilderUseCase } from "./episode-builder.usecase.js";
import { LoopDetectorUseCase } from "./loop-detector.usecase.js";
import { LoopEvaluatorUseCase } from "./loop-evaluator.usecase.js";
import type {
  CandidateLoop,
  EpisodeRecord,
  LoopEvaluation,
  PhaseUsageMetrics,
  LoopMinerRepository,
  LoopMinerRunReason,
  LoopMinerRunResult,
  LoopMinerRunView,
  LoopMinerSummary,
} from "./types.js";
import { workflowDnaFingerprint, workflowDnaPrompt } from "./utils.js";

export interface RunLoopMinerOptions {
  runReason?: LoopMinerRunReason;
  lookbackDays?: number;
}

export interface LoopMinerDeps {
  repository: LoopMinerRepository;
  episodeBuilder: EpisodeBuilderUseCase;
  loopDetector: LoopDetectorUseCase;
  loopEvaluator: LoopEvaluatorUseCase;
  dnaGenerator: DnaGeneratorUseCase;
}

const logger = createLogger({ baseFields: { component: "loop_miner" } });

function errorJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
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

function createDefaultDeps(): LoopMinerDeps {
  const repository = new PgLoopMinerRepository();
  return {
    repository,
    episodeBuilder: new EpisodeBuilderUseCase(repository),
    loopDetector: new LoopDetectorUseCase(),
    loopEvaluator: new LoopEvaluatorUseCase(),
    dnaGenerator: new DnaGeneratorUseCase(),
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

  const runId = await deps.repository.createRun({ auth, runReason });
  let summary = emptySummary();
  try {
    logger.info("loop miner run started", { runId, runReason, lookbackDays });
    const events = await deps.repository.listRecentEvents(auth, lookbackDays);
    const built = await deps.episodeBuilder.execute({ auth, runId, events });
    mergeCleanupAiUsage(summary.usage, built.usage);
    summary.aiCalls += built.aiCalls;
    summary.episodesBuilt = built.episodes.length;
    summary.phaseUsage = {
      ...(summary.phaseUsage ?? {}),
      episodeBuilder: built.phaseUsage,
    };
    if (built.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...built.warnings];
    }

    const detected = await deps.loopDetector.execute(built.episodes);
    mergeCleanupAiUsage(summary.usage, detected.usage);
    summary.aiCalls += detected.aiCalls;
    summary.loopsDetected = detected.loops.length;
    summary.phaseUsage = {
      ...(summary.phaseUsage ?? {}),
      loopDetector: normalizePhaseUsage(detected.phaseUsage),
    };
    if (detected.warnings.length > 0) {
      summary.warnings = [...(summary.warnings ?? []), ...detected.warnings];
    }

    const episodesByLoop = new Map<string, EpisodeRecord[]>();
    for (const loop of detected.loops) {
      episodesByLoop.set(keyForLoop(loop), await deps.repository.listEpisodeContext(auth, loop.episodeIds));
    }

    const evaluated = await deps.loopEvaluator.execute({
      candidateLoops: detected.loops,
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
        const candidateLoop = findCandidateForEvaluation(detected.loops, evaluation);
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
    for (const item of generated.dna) {
      const suggestedPrompt = workflowDnaPrompt(item.workflowDna);
      const suggestion = await deps.repository.createWorkflowSuggestion({
        auth,
        runId,
        candidateLoop: item.candidateLoop,
        evaluation: item.evaluation,
        dna: item.workflowDna,
        suggestedPrompt,
        fingerprint: workflowDnaFingerprint(item.workflowDna),
      });
      if (suggestion) suggestions.push(suggestion);
    }
    summary.suggestionsCreated = suggestions.length;
    summary = finalizeSummary(summary, startedAt);
    await deps.repository.completeRun({ auth, runId, status: "completed", summary });
    logger.info("loop miner run completed", { runId, ...summary });
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
