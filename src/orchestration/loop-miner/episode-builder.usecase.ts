import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import type { CleanupAiUsage } from "../memory-cleanup/types.js";
import { emptyCleanupAiUsage, recordCleanupAiUsage } from "../memory-cleanup/usage.js";
import { loopMinerModelForPhase } from "./model.js";
import { EPISODE_BUILDER_PROMPT } from "./prompts.js";
import type { EpisodeBuilderEfficiencyMetrics, EpisodeRecord, LoopMinerRepository, MinerEvent } from "./types.js";
import {
  chunkEventsByTimeGap,
  compactMinerEvent,
  estimatePromptTokensFromRequest,
  estimateTokens,
  explicitWorkflowMemoryExtraction,
  normalizeEpisodeExtraction,
  packByEstimatedPromptBudget,
  readJsonObject,
} from "./utils.js";

type ChatFn = (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class EpisodeBuilderUseCase {
  constructor(
    private readonly repository: Pick<LoopMinerRepository, "createEpisode">,
    private readonly chat: ChatFn = (request) => aiProviderRegistry.chat(request)
  ) {}

  async execute(input: {
    auth: AuthContext;
    runId: string;
    events: MinerEvent[];
  }): Promise<{
    episodes: EpisodeRecord[];
    raw: unknown[];
    aiCalls: number;
    usage: CleanupAiUsage;
    warnings: string[];
    phaseUsage: EpisodeBuilderEfficiencyMetrics;
  }> {
    if (input.events.length === 0) {
      return {
        episodes: [],
        raw: [],
        aiCalls: 0,
        usage: emptyCleanupAiUsage(),
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
          inputEvents: 0,
          outputEpisodes: 0,
          tokensPerInputEvent: 0,
          tokensPerOutputEpisode: 0,
          costPerOutputEpisodeUsd: 0,
          maxEstimatedPromptTokensPerCall: 0,
        },
      };
    }

    const usage = emptyCleanupAiUsage();
    const episodes: EpisodeRecord[] = [];
    const rawResponses: unknown[] = [];
    const warnings: string[] = [];
    let aiCalls = 0;
    let batchesProcessed = 0;
    let batchesSkipped = 0;
    let maxEstimatedPromptTokensPerCall = 0;

    const deterministicMemoryEventIds = new Set<string>();
    for (const event of input.events) {
      const extraction = explicitWorkflowMemoryExtraction(event);
      if (!extraction) continue;
      deterministicMemoryEventIds.add(event.id);
      rawResponses.push({
        source: "deterministic_memory_workflow_extraction",
        eventId: event.id,
        title: extraction.title,
        outputType: extraction.outputType,
        cadence: extraction.automationSignals?.likelyCadence ?? "unknown",
      });
      episodes.push(await this.repository.createEpisode({
        auth: input.auth,
        runId: input.runId,
        extraction,
        turns: [{
          role: event.role,
          contentSummary: event.contentSummary,
          sourceEventType: event.sourceEventType,
          sourceEventId: event.id,
          createdAt: event.createdAt,
        }],
      }));
    }

    const compactSummaryCap = Math.max(160, config.loopMinerEventSummaryCharCap);
    const promptBudgetTokens = Math.max(1200, config.loopMinerPromptBudgetTokens);
    const llmEvents = input.events.filter((event) =>
      event.sourceEventType !== "memory_record" && !deterministicMemoryEventIds.has(event.id)
    );
    const preChunks = chunkEventsByTimeGap(llmEvents, 4);

    for (const [chunkIndex, chunk] of preChunks.entries()) {
      const compacted = chunk.map((event) => compactMinerEvent(event, { contentSummaryCharCap: compactSummaryCap }));
      const packed = packByEstimatedPromptBudget(compacted, {
        maxTokens: promptBudgetTokens,
        baseTokens: estimateTokens(EPISODE_BUILDER_PROMPT) + 280,
        estimateItemTokens: (event) => estimateTokens(JSON.stringify(event)) + 18,
      });

      for (const [batchIndex, batch] of packed.batches.entries()) {
        batchesProcessed += 1;
        const validEventIds = new Set(batch.map((event) => event.id));
        const request: ChatCompletionRequest = {
          model: loopMinerModelForPhase("episode"),
          temperature: 0,
          maxTokens: 2200,
          responseFormat: "json_object",
          messages: [
            { role: "system", content: EPISODE_BUILDER_PROMPT },
            {
              role: "user",
              content: JSON.stringify({
                events: batch,
              }),
            },
          ],
        };

        const estimatedPromptTokens = estimatePromptTokensFromRequest(request);
        maxEstimatedPromptTokensPerCall = Math.max(maxEstimatedPromptTokensPerCall, estimatedPromptTokens);
        let response: ChatCompletionResponse;
        try {
          response = await this.chat(request);
        } catch (error) {
          batchesSkipped += 1;
          const warning =
            `phase=episode_builder chunk=${chunkIndex + 1}/${preChunks.length} batch=${batchIndex + 1}/${packed.batches.length} items=${batch.length} estimatedPromptTokens=${estimatedPromptTokens} reason=${errorMessage(error)}`;
          warnings.push(warning);
          rawResponses.push({
            skipped: "episode_builder_batch_failed",
            chunkIndex,
            batchIndex,
            eventIds: batch.map((event) => event.id),
            estimatedPromptTokens,
            error: errorMessage(error),
          });
          continue;
        }

        recordCleanupAiUsage(usage, request, response);
        aiCalls += 1;

        const raw = readJsonObject(response.text);
        rawResponses.push(raw);
        const rawEpisodes = Array.isArray(raw.episodes) ? raw.episodes : [];
        const eventById = new Map(batch.map((event) => [event.id, event]));
        for (const rawEpisode of rawEpisodes) {
          const extraction = normalizeEpisodeExtraction(rawEpisode, validEventIds);
          if (!extraction) continue;
          const turns = extraction.eventIds
            .map((eventId) => eventById.get(eventId))
            .filter((event): event is (typeof batch)[number] => Boolean(event))
            .map((event) => ({
              role: event.role,
              contentSummary: event.contentSummary,
              sourceEventType: event.sourceEventType,
              sourceEventId: event.id,
              createdAt: event.createdAt,
            }));
          if (turns.length === 0) continue;
          episodes.push(await this.repository.createEpisode({
            auth: input.auth,
            runId: input.runId,
            extraction,
            turns,
          }));
        }
      }
    }

    const inputEvents = input.events.length;
    const outputEpisodes = episodes.length;
    const estimatedTokens = usage.estimatedTotalTokens;
    const estimatedCostUsd = Number(usage.estimatedCostUsd.toFixed(6));
    const phaseUsage: EpisodeBuilderEfficiencyMetrics = {
      calls: aiCalls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      estimatedTotalTokens: estimatedTokens,
      estimatedCostUsd,
      batchesProcessed,
      batchesSkipped,
      inputEvents,
      outputEpisodes,
      tokensPerInputEvent: inputEvents > 0 ? Number((estimatedTokens / inputEvents).toFixed(2)) : 0,
      tokensPerOutputEpisode: outputEpisodes > 0 ? Number((estimatedTokens / outputEpisodes).toFixed(2)) : 0,
      costPerOutputEpisodeUsd: outputEpisodes > 0 ? Number((estimatedCostUsd / outputEpisodes).toFixed(6)) : 0,
      maxEstimatedPromptTokensPerCall,
    };

    return { episodes, raw: rawResponses, aiCalls, usage, warnings, phaseUsage };
  }
}
