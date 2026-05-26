import { config } from "../../config/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import type { CleanupAiUsage } from "../memory-cleanup/types.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage, recordCleanupAiUsage } from "../memory-cleanup/usage.js";
import { loopMinerModelForPhase } from "./core/loop-miner-models.js";
import { LOOP_EVALUATOR_PROMPT } from "./core/loop-miner-prompts.js";
import type { CandidateLoop, EpisodeRecord, LoopEvaluation, PhaseUsageMetrics } from "./core/loop-miner.types.js";
import type { LoopMinerRunProgress } from "./core/loop-miner-run-progress.js";
import {
  compactEpisodeForPrompt,
  estimatePromptTokensFromRequest,
  estimateTokens,
  normalizeLoopEvaluation,
  packByEstimatedPromptBudget,
  readJsonObject,
  readString,
  readStringArray,
} from "./core/loop-miner-helpers.js";

type ChatFn = (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function loopKey(loop: CandidateLoop): string {
  return [...loop.episodeIds].sort().join("|");
}

function resolveFallbackLoop(value: unknown, loops: CandidateLoop[]): CandidateLoop | null {
  if (loops.length === 0) return null;
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const loopName = readString(row.loopName ?? row.loop_name, "");
  const ids = readStringArray(row.episodeIds ?? row.episode_ids);
  if (ids.length >= 2) {
    const key = [...ids].sort().join("|");
    const exact = loops.find((loop) => loopKey(loop) === key);
    if (exact) return exact;
    const overlap = loops.find((loop) => ids.every((id) => loop.episodeIds.includes(id)));
    if (overlap) return overlap;
  }
  if (loopName) {
    const byName = loops.find((loop) => loop.loopName.toLowerCase() === loopName.toLowerCase());
    if (byName) return byName;
  }
  return loops[0] ?? null;
}

export class LoopEvaluatorUseCase {
  constructor(private readonly chat: ChatFn = (request) => aiProviderRegistry.chat(request)) {}

  async execute(input: {
    candidateLoops: CandidateLoop[];
    episodesByLoop: Map<string, EpisodeRecord[]>;
    progress?: LoopMinerRunProgress;
  }): Promise<{
    evaluations: LoopEvaluation[];
    raw: unknown[];
    aiCalls: number;
    usage: CleanupAiUsage;
    warnings: string[];
    phaseUsage: PhaseUsageMetrics;
  }> {
    const usage = emptyCleanupAiUsage();
    const evaluations: LoopEvaluation[] = [];
    const rawResponses: unknown[] = [];
    const warnings: string[] = [];
    let aiCalls = 0;

    const loopPayloads = input.candidateLoops
      .map((loop) => {
        const episodes = input.episodesByLoop.get(loopKey(loop)) ?? [];
        if (episodes.length < 2) return null;
        return {
          candidateLoop: loop,
          episodes: episodes.slice(0, 8).map((episode) => compactEpisodeForPrompt(episode, {
            maxTurns: 6,
            maxTurnSummaryChars: 500,
          })),
        };
      })
      .filter((item): item is { candidateLoop: CandidateLoop; episodes: Record<string, unknown>[] } => Boolean(item));

    if (loopPayloads.length === 0) {
      return {
        evaluations: [],
        raw: [],
        aiCalls: 0,
        usage,
        warnings,
        phaseUsage: {
          calls: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedTotalTokens: 0,
          estimatedCostUsd: 0,
          batchesProcessed: 0,
          batchesSkipped: 0,
          loopsInput: 0,
          loopsOutput: 0,
        },
      };
    }

    const packed = packByEstimatedPromptBudget(loopPayloads, {
      maxTokens: Math.max(1200, config.loopMinerPromptBudgetTokens),
      baseTokens: estimateTokens(LOOP_EVALUATOR_PROMPT) + 260,
      estimateItemTokens: (item) => estimateTokens(JSON.stringify(item)) + 20,
    });
    let batchesSkipped = 0;

    for (const [batchIndex, batch] of packed.batches.entries()) {
      const batchStartedAt = Date.now();
      input.progress?.step("loop evaluator batch started", {
        batchIndex: batchIndex + 1,
        batchTotal: packed.batches.length,
        loopCount: batch.length,
      });
      const request: ChatCompletionRequest = {
        model: loopMinerModelForPhase("evaluator"),
        temperature: 0,
        maxTokens: 1700,
        responseFormat: "json_object",
        messages: [
          { role: "system", content: LOOP_EVALUATOR_PROMPT },
          {
            role: "user",
            content: JSON.stringify({ loops: batch }),
          },
        ],
      };
      const estimatedPromptTokens = estimatePromptTokensFromRequest(request);
      let response: ChatCompletionResponse;
      try {
        response = await this.chat(request);
      } catch (error) {
        batchesSkipped += 1;
        input.progress?.step("loop evaluator batch failed", {
          batchIndex: batchIndex + 1,
          durationMs: Date.now() - batchStartedAt,
          reason: errorMessage(error),
        });
        warnings.push(`phase=loop_evaluator batch=${batchIndex + 1}/${packed.batches.length} items=${batch.length} estimatedPromptTokens=${estimatedPromptTokens} reason=${errorMessage(error)}`);
        rawResponses.push({
          skipped: "loop_evaluator_batch_failed",
          batchIndex,
          loopNames: batch.map((item) => item.candidateLoop.loopName),
          estimatedPromptTokens,
          error: errorMessage(error),
        });
        continue;
      }

      const callUsage = emptyCleanupAiUsage();
      recordCleanupAiUsage(callUsage, request, response);
      mergeCleanupAiUsage(usage, callUsage);
      aiCalls += 1;
      input.progress?.step("loop evaluator batch completed", {
        batchIndex: batchIndex + 1,
        durationMs: Date.now() - batchStartedAt,
        qualifiedSoFar: evaluations.length,
      });

      const raw = readJsonObject(response.text);
      rawResponses.push(raw);
      const rows = Array.isArray(raw.evaluations)
        ? raw.evaluations
        : Object.keys(raw).length > 0
          ? [raw]
          : [];
      const fallbackLoops = batch.map((item) => item.candidateLoop);
      for (const row of rows) {
        const fallback = resolveFallbackLoop(row, fallbackLoops);
        if (!fallback) continue;
        const evaluation = normalizeLoopEvaluation(row, fallback);
        if (evaluation.verdict !== "discard") evaluations.push(evaluation);
      }
    }

    return {
      evaluations,
      raw: rawResponses,
      aiCalls,
      usage,
      warnings,
      phaseUsage: {
        calls: aiCalls,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        estimatedTotalTokens: usage.estimatedTotalTokens,
        estimatedCostUsd: Number(usage.estimatedCostUsd.toFixed(6)),
        batchesProcessed: packed.batches.length,
        batchesSkipped,
        loopsInput: loopPayloads.length,
        loopsOutput: evaluations.length,
      },
    };
  }
}
