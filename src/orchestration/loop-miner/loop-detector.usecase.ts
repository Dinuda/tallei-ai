import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import type { CleanupAiUsage } from "../memory-cleanup/types.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage, recordCleanupAiUsage } from "../memory-cleanup/usage.js";
import { loopMinerModelForPhase } from "./model.js";
import { LLM_LOOP_DETECTOR_PROMPT } from "./prompts.js";
import type {
  CandidateLoop,
  EpisodeRecord,
  PatternAdversaryFinding,
  PatternJudgeStatus,
  PatternTrace,
  PhaseUsageMetrics,
} from "./types.js";
import { estimatePromptTokensFromRequest, readJsonObject, readString, readStringArray } from "./utils.js";

type ChatFn = (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function compactEpisodeForDetection(episode: EpisodeRecord): Record<string, unknown> {
  const intent = episode.intent.length <= 120 ? episode.intent : `${episode.intent.slice(0, 117)}...`;
  const steps = episode.steps.slice(0, 4).join(" | ");
  const stepsCompact = steps.length <= 80 ? steps : `${steps.slice(0, 77)}...`;
  const turns = episode.turns
    .slice(0, 2)
    .map((t) => {
      const s = t.contentSummary.length <= 80 ? t.contentSummary : `${t.contentSummary.slice(0, 77)}...`;
      return s;
    })
    .join(" | ");
  return {
    id: episode.id,
    intent,
    outputType: episode.outputType,
    steps: stepsCompact || "none",
    sources: episode.sources.slice(0, 4),
    tools: episode.toolNames.slice(0, 4),
    turns: turns || "none",
    eventIds: episode.eventIds.slice(0, 4),
    sourceEventTypes: [...new Set(episode.turns.map((t) => t.sourceEventType))].slice(0, 3),
  };
}

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeJudgeStatus(value: unknown): PatternJudgeStatus {
  const s = typeof value === "string" ? value : "";
  if (s === "approved_loop") return "approved_loop";
  if (s === "approved_with_modification") return "approved_with_modification";
  if (s === "monitor_pattern") return "monitor_pattern";
  if (s === "rejected_topical_similarity") return "rejected_topical_similarity";
  if (s === "rejected_insufficient_evidence") return "rejected_insufficient_evidence";
  return "rejected_insufficient_evidence";
}

function normalizeSharedSources(value: unknown): string[] {
  const arr = readStringArray(value);
  if (arr.length > 0) return arr;
  return ["unknown"];
}

function normalizeSharedOutputType(value: unknown, fallback = "unknown"): string {
  const s = readString(value, fallback);
  return s || fallback;
}

interface LlmGroup {
  episodeIds: string[];
  loopName: string;
  sharedIntent: string;
  sharedOutputType: string;
  sharedSources: string[];
  reasoning: string;
  status: PatternJudgeStatus;
  confidence: number;
}

function parseLlmGroups(raw: Record<string, unknown>): LlmGroup[] {
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  return groups
    .map((g): LlmGroup | null => {
      if (!g || typeof g !== "object" || Array.isArray(g)) return null;
      const row = g as Record<string, unknown>;
      const ids = readStringArray(row.episodeIds ?? row.episode_ids);
      if (ids.length < 2) return null;
      return {
        episodeIds: ids,
        loopName: readString(row.loopName ?? row.loop_name ?? row.name, "Unnamed loop"),
        sharedIntent: readString(row.sharedIntent ?? row.shared_intent ?? row.intent, "Unknown intent"),
        sharedOutputType: normalizeSharedOutputType(row.sharedOutputType ?? row.shared_output_type ?? row.outputType),
        sharedSources: normalizeSharedSources(row.sharedSources ?? row.shared_sources ?? row.sources),
        reasoning: readString(row.reasoning ?? row.reason, ""),
        status: normalizeJudgeStatus(row.status),
        confidence: normalizeConfidence(row.confidence),
      };
    })
    .filter((g): g is LlmGroup => g !== null);
}

function buildCandidateLoop(group: LlmGroup): CandidateLoop {
  return {
    loopName: group.loopName,
    episodeIds: group.episodeIds,
    sharedIntent: group.sharedIntent,
    sharedSources: group.sharedSources,
    sharedOutputType: group.sharedOutputType,
    reasoning: group.reasoning,
    patternConfidence: group.confidence,
    patternStatus: group.status,
  };
}

function groupKey(group: LlmGroup): string {
  return [...group.episodeIds].sort().join("|");
}

function mergeGroupsAcrossBatches(groups: LlmGroup[]): LlmGroup[] {
  const byKey = new Map<string, LlmGroup>();
  for (const group of groups) {
    const key = groupKey(group);
    const existing = byKey.get(key);
    if (!existing || group.confidence > existing.confidence) {
      byKey.set(key, group);
    }
  }
  return [...byKey.values()];
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeSources(sources: string[]): string[] {
  return [...new Set(sources.map(normalizeText).filter(Boolean))];
}

function hasSourceOverlap(left: string[], right: string[]): boolean {
  const leftSet = new Set(normalizeSources(left));
  for (const source of normalizeSources(right)) {
    if (leftSet.has(source)) return true;
  }
  return false;
}

function outputTypeMatches(left: string, right: string): boolean {
  return normalizeText(left) === normalizeText(right);
}

function intentMatches(left: string, right: string): boolean {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function isStrictSubset(subset: string[], superset: string[]): boolean {
  if (subset.length >= superset.length) return false;
  const superSet = new Set(superset);
  return subset.every((id) => superSet.has(id));
}

function dedupeStrictSubsetGroups(groups: LlmGroup[]): LlmGroup[] {
  if (groups.length <= 1) return groups;
  const dropped = new Set<number>();
  for (let i = 0; i < groups.length; i += 1) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < groups.length; j += 1) {
      if (dropped.has(j)) continue;
      const left = groups[i];
      const right = groups[j];
      if (!left || !right) continue;

      const leftSubsetRight = isStrictSubset(left.episodeIds, right.episodeIds);
      const rightSubsetLeft = isStrictSubset(right.episodeIds, left.episodeIds);
      if (!leftSubsetRight && !rightSubsetLeft) continue;
      if (!outputTypeMatches(left.sharedOutputType, right.sharedOutputType)) continue;
      if (!intentMatches(left.sharedIntent, right.sharedIntent)) continue;
      if (!hasSourceOverlap(left.sharedSources, right.sharedSources)) continue;

      if (leftSubsetRight) {
        dropped.add(i);
      } else {
        dropped.add(j);
      }
    }
  }
  return groups.filter((_, index) => !dropped.has(index));
}

function buildPatternTrace(
  groups: LlmGroup[],
  approvedIds: string[]
): PatternTrace {
  const approvedSet = new Set(approvedIds);
  const rejectedGroups = groups
    .filter((g) => !approvedSet.has(groupKey(g)))
    .map((g) => ({
      candidateGroupId: groupKey(g),
      status: g.status,
      rationale: g.reasoning,
    }));

  return {
    candidateGroups: groups.map((g) => ({
      id: groupKey(g),
      episodeIds: g.episodeIds,
      title: g.loopName,
      sharedJob: g.sharedIntent,
      sharedArtifact: g.sharedOutputType,
      sharedActions: [],
      sharedSources: g.sharedSources,
      sharedTools: [],
      evidenceSummary: g.episodeIds.join(", "),
      confidence: g.confidence,
      cadenceSignal: "implicit_or_unknown",
      generationReason: g.reasoning,
    })),
    approvedGroups: approvedIds,
    rejectedGroups,
    adversaryFindings: [] as PatternAdversaryFinding[],
    judgeDecisions: groups.map((g) => ({
      candidateGroupId: groupKey(g),
      status: g.status,
      confidence: g.confidence,
      rationale: g.reasoning,
      candidateLoop: buildCandidateLoop(g),
    })),
  };
}

function createBatches<T>(items: T[], batchSize: number, overlap: number): T[][] {
  if (items.length <= batchSize) return [items];
  const batches: T[][] = [];
  let index = 0;
  while (index < items.length) {
    const end = Math.min(index + batchSize, items.length);
    batches.push(items.slice(index, end));
    if (end >= items.length) break;
    const nextIndex = end - overlap;
    index = nextIndex <= index ? end : nextIndex;
  }
  return batches;
}

export class LoopDetectorUseCase {
  constructor(
    private readonly chat: ChatFn = (request) => aiProviderRegistry.chat(request),
    // embed is no longer used; kept in signature for backward compat with existing callers
    _embed?: ((text: string) => Promise<number[]>) | undefined
  ) {}

  async execute(episodes: EpisodeRecord[]): Promise<{
    loops: CandidateLoop[];
    patternTrace: PatternTrace;
    raw: unknown[];
    aiCalls: number;
    usage: CleanupAiUsage;
    warnings: string[];
    phaseUsage: PhaseUsageMetrics;
  }> {
    const usage = emptyCleanupAiUsage();
    const rawResponses: unknown[] = [];
    const warnings: string[] = [];
    let aiCalls = 0;
    let batchesSkipped = 0;

    if (episodes.length < 2) {
      return {
        loops: [],
        patternTrace: {
          candidateGroups: [],
          approvedGroups: [],
          rejectedGroups: [],
          adversaryFindings: [],
          judgeDecisions: [],
        },
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
          inputEpisodes: episodes.length,
          outputEpisodes: 0,
        },
      };
    }

    const compacted = episodes.map(compactEpisodeForDetection);
    const episodeIdSet = new Set(episodes.map((e) => e.id));
    const BATCH_SIZE = 10;
    const OVERLAP = 3;
    const batches = createBatches(compacted, BATCH_SIZE, OVERLAP);
    const allGroups: LlmGroup[] = [];

    for (const [batchIndex, batch] of batches.entries()) {
      const request: ChatCompletionRequest = {
        model: loopMinerModelForPhase("detector"),
        temperature: 0,
        maxTokens: 2500,
        responseFormat: "json_object",
        messages: [
          { role: "system", content: LLM_LOOP_DETECTOR_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              episodes: batch,
              context: `Batch ${batchIndex + 1}/${batches.length}. Only group episodes within this batch.`,
            }),
          },
        ],
      };

      let response: ChatCompletionResponse;
      try {
        response = await this.chat(request);
      } catch (error) {
        batchesSkipped += 1;
        warnings.push(`phase=loop_detector batch=${batchIndex + 1}/${batches.length} reason=${errorMessage(error)}`);
        rawResponses.push({
          skipped: "loop_detector_batch_failed",
          batchIndex,
          estimatedPromptTokens: estimatePromptTokensFromRequest(request),
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

      const groups = parseLlmGroups(raw);
      // Validate: all referenced episode IDs must exist in the FULL episode set
      const validGroups = groups.filter((group) =>
        group.episodeIds.every((id) => episodeIdSet.has(id))
      );
      const invalidCount = groups.length - validGroups.length;
      if (invalidCount > 0) {
        warnings.push(`phase=loop_detector batch=${batchIndex + 1}/${batches.length} reason=${invalidCount} group(s) referenced unknown episode IDs`);
      }
      allGroups.push(...validGroups);
    }

    const mergedGroups = mergeGroupsAcrossBatches(allGroups);
    const dedupedGroups = dedupeStrictSubsetGroups(mergedGroups);

    const approvedGroups = dedupedGroups.filter((g) => g.status === "approved_loop");
    const approvedIds = approvedGroups.map((g) => groupKey(g));
    const loops = approvedGroups.map(buildCandidateLoop);

    const patternTrace = buildPatternTrace(dedupedGroups, approvedIds);

    return {
      loops,
      patternTrace,
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
        batchesProcessed: batches.length,
        batchesSkipped,
        inputEpisodes: episodes.length,
        outputEpisodes: loops.length,
      },
    };
  }
}
