import { config } from "../../config/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import type { CleanupAiUsage } from "../memory-cleanup/types.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage, recordCleanupAiUsage } from "../memory-cleanup/usage.js";
import { loopMinerModelForPhase } from "./core/loop-miner-models.js";
import { DNA_GENERATOR_PROMPT } from "./core/loop-miner-prompts.js";
import type { CandidateLoop, EpisodeRecord, LoopEvaluation, PhaseUsageMetrics, WorkflowDNA } from "./core/loop-miner.types.js";
import type { LoopMinerRunProgress } from "./core/loop-miner-run-progress.js";
import {
  compactEpisodeForPrompt,
  estimatePromptTokensFromRequest,
  estimateTokens,
  normalizeWorkflowDna,
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

interface QualifiedLoopPayload {
  candidateLoop: CandidateLoop;
  evaluation: LoopEvaluation;
  episodes: EpisodeRecord[];
}

function resolveFallbackLoop(value: unknown, loops: QualifiedLoopPayload[]): QualifiedLoopPayload | null {
  if (loops.length === 0) return null;
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const loopName = readString(row.name ?? row.loopName, "");
  const ids = readStringArray(row.episodeIds ?? row.episode_ids);
  if (ids.length >= 2) {
    const key = [...ids].sort().join("|");
    const exact = loops.find((loop) => loopKey(loop.candidateLoop) === key);
    if (exact) return exact;
    const overlap = loops.find((loop) => ids.every((id) => loop.candidateLoop.episodeIds.includes(id)));
    if (overlap) return overlap;
  }
  if (loopName) {
    const byName = loops.find((loop) => loop.candidateLoop.loopName.toLowerCase() === loopName.toLowerCase());
    if (byName) return byName;
  }
  return loops[0] ?? null;
}

export class DnaGeneratorUseCase {
  constructor(private readonly chat: ChatFn = (request) => aiProviderRegistry.chat(request)) {}

  async execute(input: {
    qualifiedLoops: Array<{ candidateLoop: CandidateLoop; evaluation: LoopEvaluation; episodes: EpisodeRecord[] }>;
    progress?: LoopMinerRunProgress;
  }): Promise<{
    dna: Array<{ candidateLoop: CandidateLoop; evaluation: LoopEvaluation; episodes: EpisodeRecord[]; workflowDna: WorkflowDNA }>;
    raw: unknown[];
    aiCalls: number;
    usage: CleanupAiUsage;
    warnings: string[];
    phaseUsage: PhaseUsageMetrics;
  }> {
    const usage = emptyCleanupAiUsage();
    const dna: Array<{ candidateLoop: CandidateLoop; evaluation: LoopEvaluation; episodes: EpisodeRecord[]; workflowDna: WorkflowDNA }> = [];
    const rawResponses: unknown[] = [];
    const warnings: string[] = [];
    let aiCalls = 0;

    if (input.qualifiedLoops.length === 0) {
      return {
        dna,
        raw: rawResponses,
        aiCalls,
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

    const payloads: QualifiedLoopPayload[] = input.qualifiedLoops.map((qualified) => ({
      candidateLoop: qualified.candidateLoop,
      evaluation: qualified.evaluation,
      episodes: qualified.episodes.slice(0, 8),
    }));

    const packed = packByEstimatedPromptBudget(payloads, {
      maxTokens: Math.max(1200, config.loopMinerPromptBudgetTokens),
      baseTokens: estimateTokens(DNA_GENERATOR_PROMPT) + 260,
      estimateItemTokens: (item) => estimateTokens(JSON.stringify({
        candidateLoop: item.candidateLoop,
        evaluation: item.evaluation,
        episodes: item.episodes.map((episode) => compactEpisodeForPrompt(episode, {
          maxTurns: 6,
          maxTurnSummaryChars: 500,
        })),
      })) + 20,
    });
    let batchesSkipped = 0;

    for (const [batchIndex, batch] of packed.batches.entries()) {
      const batchStartedAt = Date.now();
      input.progress?.step("dna generator batch started", {
        batchIndex: batchIndex + 1,
        batchTotal: packed.batches.length,
        loopCount: batch.length,
      });
      const request: ChatCompletionRequest = {
        model: loopMinerModelForPhase("dna"),
        temperature: 0,
        maxTokens: 1700,
        responseFormat: "json_object",
        messages: [
          { role: "system", content: DNA_GENERATOR_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              qualifiedLoops: batch.map((qualified) => ({
                candidateLoop: qualified.candidateLoop,
                evaluation: qualified.evaluation,
                episodes: qualified.episodes.map((episode) => compactEpisodeForPrompt(episode, {
                  maxTurns: 6,
                  maxTurnSummaryChars: 500,
                })),
              })),
            }),
          },
        ],
      };
      const estimatedPromptTokens = estimatePromptTokensFromRequest(request);

      let response: ChatCompletionResponse;
      try {
        response = await this.chat(request);
      } catch (error) {
        batchesSkipped += 1;
        input.progress?.step("dna generator batch failed", {
          batchIndex: batchIndex + 1,
          durationMs: Date.now() - batchStartedAt,
          reason: errorMessage(error),
        });
        warnings.push(`phase=dna_generator batch=${batchIndex + 1}/${packed.batches.length} items=${batch.length} estimatedPromptTokens=${estimatedPromptTokens} reason=${errorMessage(error)}`);
        rawResponses.push({
          skipped: "dna_generator_batch_failed",
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
      input.progress?.step("dna generator batch completed", {
        batchIndex: batchIndex + 1,
        durationMs: Date.now() - batchStartedAt,
        workflowsSoFar: dna.length,
      });

      const raw = readJsonObject(response.text);
      rawResponses.push(raw);
      const rows = Array.isArray(raw.workflows)
        ? raw.workflows
        : Object.keys(raw).length > 0
          ? [raw]
          : [];
      for (const row of rows) {
        const fallback = resolveFallbackLoop(row, batch);
        if (!fallback) continue;
        dna.push({
          ...fallback,
          workflowDna: normalizeWorkflowDna(row, {
            loop: fallback.candidateLoop,
            evaluation: fallback.evaluation,
            episodes: fallback.episodes,
          }),
        });
      }
    }

    return {
      dna,
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
        loopsInput: payloads.length,
        loopsOutput: dna.length,
      },
    };
  }
}
