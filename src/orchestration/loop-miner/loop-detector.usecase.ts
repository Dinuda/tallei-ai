import { config } from "../../config/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import type { CleanupAiUsage } from "../memory-cleanup/types.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage, recordCleanupAiUsage } from "../memory-cleanup/usage.js";
import { loopMinerModelForPhase } from "./model.js";
import { LOOP_DETECTOR_PROMPT } from "./prompts.js";
import type { CandidateLoop, EpisodeRecord, PhaseUsageMetrics } from "./types.js";
import {
  estimatePromptTokensFromRequest,
  estimateTokens,
  normalizeCandidateLoop,
  packByEstimatedPromptBudget,
  prefilterEpisodesByOutputType,
  readJsonObject,
} from "./utils.js";

type ChatFn = (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class LoopDetectorUseCase {
  constructor(private readonly chat: ChatFn = (request) => aiProviderRegistry.chat(request)) {}

  async execute(episodes: EpisodeRecord[]): Promise<{
    loops: CandidateLoop[];
    raw: unknown[];
    aiCalls: number;
    usage: CleanupAiUsage;
    warnings: string[];
    phaseUsage: PhaseUsageMetrics;
  }> {
    const filteredEpisodes = prefilterEpisodesByOutputType(episodes);
    if (filteredEpisodes.length < 2) {
      const empty = emptyCleanupAiUsage();
      return {
        loops: [],
        raw: [{ skipped: "not_enough_repeated_output_types" }],
        aiCalls: 0,
        usage: empty,
        warnings: [],
        phaseUsage: {
          calls: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedTotalTokens: 0,
          estimatedCostUsd: 0,
          batchesProcessed: 0,
          batchesSkipped: 0,
          inputEpisodes: filteredEpisodes.length,
          outputEpisodes: 0,
        },
      };
    }

    const compactEpisodes = filteredEpisodes.map((episode) => ({
      id: episode.id,
      intent: episode.intent,
      sources: episode.sources,
      outputType: episode.outputType,
      date: episode.sealedAt,
      steps: episode.steps,
      styleHints: episode.styleHints ?? [],
      automationSignals: episode.automationSignals ?? null,
      userBehavior: episode.userBehavior ?? null,
      approved: episode.approved,
    }));
    const packed = packByEstimatedPromptBudget(compactEpisodes, {
      maxTokens: Math.max(1200, config.loopMinerPromptBudgetTokens),
      baseTokens: estimateTokens(LOOP_DETECTOR_PROMPT) + 220,
      estimateItemTokens: (episode) => estimateTokens(JSON.stringify(episode)) + 12,
    });

    const usage = emptyCleanupAiUsage();
    const warnings: string[] = [];
    const rawResponses: unknown[] = [];
    const collectedLoops: CandidateLoop[] = [];
    let aiCalls = 0;
    let batchesSkipped = 0;

    for (const [batchIndex, batch] of packed.batches.entries()) {
      const request: ChatCompletionRequest = {
        model: loopMinerModelForPhase("detector"),
        temperature: 0,
        maxTokens: 1800,
        responseFormat: "json_object",
        messages: [
          { role: "system", content: LOOP_DETECTOR_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              episodes: batch,
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
        warnings.push(`phase=loop_detector batch=${batchIndex + 1}/${packed.batches.length} items=${batch.length} estimatedPromptTokens=${estimatedPromptTokens} reason=${errorMessage(error)}`);
        rawResponses.push({
          skipped: "loop_detector_batch_failed",
          batchIndex,
          episodeIds: batch.map((episode) => episode.id),
          estimatedPromptTokens,
          error: errorMessage(error),
        });
        continue;
      }

      const callUsage = emptyCleanupAiUsage();
      recordCleanupAiUsage(callUsage, request, response);
      mergeCleanupAiUsage(usage, callUsage);
      aiCalls += 1;

      const raw = readJsonObject(response.text);
      rawResponses.push(raw);
      const validEpisodeIds = new Set(batch.map((episode) => episode.id));
      const loops = (Array.isArray(raw.loops) ? raw.loops : [])
        .map((loop) => normalizeCandidateLoop(loop, validEpisodeIds))
        .filter((loop): loop is CandidateLoop => Boolean(loop));
      collectedLoops.push(...loops);
    }

    const phaseUsage: PhaseUsageMetrics = {
      calls: aiCalls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      estimatedTotalTokens: usage.estimatedTotalTokens,
      estimatedCostUsd: Number(usage.estimatedCostUsd.toFixed(6)),
      batchesProcessed: packed.batches.length,
      batchesSkipped,
      inputEpisodes: filteredEpisodes.length,
      outputEpisodes: collectedLoops.length,
    };

    return { loops: collectedLoops, raw: rawResponses, aiCalls, usage, warnings, phaseUsage };
  }
}
