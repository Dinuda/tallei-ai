import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import type { CleanupAiUsage } from "../memory-cleanup/types.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage, recordCleanupAiUsage } from "../memory-cleanup/usage.js";
import { loopMinerModelForPhase } from "./model.js";
import { LLM_LOOP_DETECTOR_PROMPT } from "./prompts.js";
import type {
  CandidateLoop,
  EpisodeRecord,
  LoopLayer,
  PatternAdversaryFinding,
  PatternJudgeStatus,
  PatternTrace,
  PhaseUsageMetrics,
} from "./types.js";
import type { LoopMinerRunProgress } from "./run-progress.js";
import {
  deriveCanonicalLoopFacet,
  coarseMechanismClusterKey,
  estimatePromptTokensFromRequest,
  evaluateProjectProgression,
  normalizedStepClusterKey,
  readJsonObject,
  readString,
  readStringArray,
} from "./utils.js";

type ChatFn = (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function normalizeLoopLayer(value: unknown): LoopLayer | undefined {
  const layer = typeof value === "string" ? value : "";
  if (layer === "upstream_preparation" || layer === "output_production" || layer === "mixed") {
    return layer;
  }
  return undefined;
}

function compactEpisodeForDetection(episode: EpisodeRecord): Record<string, unknown> {
  const canonical = deriveCanonicalLoopFacet(episode);
  const intent = episode.intent.length <= 120 ? episode.intent : `${episode.intent.slice(0, 117)}...`;
  const steps = episode.steps.slice(0, 4).join(" | ");
  const stepsCompact = steps.length <= 80 ? steps : `${steps.slice(0, 77)}...`;
  const upstreamSteps = (episode.upstreamWork?.steps ?? []).slice(0, 4).join(" | ");
  const upstreamStepsCompact = upstreamSteps.length <= 80 ? upstreamSteps : `${upstreamSteps.slice(0, 77)}...`;
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
    abstractedJtbd: canonical.abstractedJtbd,
    operationalDomain: canonical.operationalDomain,
    mechanismSignature: canonical.mechanismSignature,
    steps: stepsCompact || "none",
    upstreamSteps: upstreamStepsCompact || "none",
    upstreamDecision: episode.upstreamWork?.decisionPoint ?? null,
    isUpstreamItself: episode.upstreamWork?.isUpstreamItself === true,
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
  loopLayer?: LoopLayer;
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
        loopLayer: normalizeLoopLayer(row.loopLayer ?? row.loop_layer),
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
    loopLayer: group.loopLayer,
    patternConfidence: group.confidence,
    patternStatus: group.status,
  };
}

function groupKey(group: LlmGroup): string {
  return [...group.episodeIds].sort().join("|");
}

function groupOverlapCount(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.filter((id) => rightSet.has(id)).length;
}

function inferLoopLayer(episodes: EpisodeRecord[]): LoopLayer {
  const upstreamCount = episodes.filter((episode) => episode.upstreamWork?.isUpstreamItself).length;
  if (upstreamCount === 0) return "output_production";
  if (upstreamCount === episodes.length) return "upstream_preparation";
  return "mixed";
}

function upstreamClusterKey(episode: EpisodeRecord): string | null {
  const upstream = episode.upstreamWork;
  if (!upstream || upstream.steps.length === 0) return null;
  const facet = deriveCanonicalLoopFacet(episode);
  const stepsKey = upstream.steps.map((step) => step.toLowerCase().trim()).sort().join("|");
  return `upstream|action:${facet.actionClass}|steps:${stepsKey}`;
}

export function buildDeterministicCandidateGroups(episodes: EpisodeRecord[]): LlmGroup[] {
  const clusters = new Map<string, EpisodeRecord[]>();

  const addToCluster = (key: string, episode: EpisodeRecord): void => {
    const bucket = clusters.get(key) ?? [];
    bucket.push(episode);
    clusters.set(key, bucket);
  };

  for (const episode of episodes) {
    const facet = deriveCanonicalLoopFacet(episode);
    addToCluster(`mechanism:${facet.mechanismSignature}`, episode);
    addToCluster(`coarse:${coarseMechanismClusterKey(facet)}`, episode);
    const stepKey = normalizedStepClusterKey(episode);
    if (stepKey) addToCluster(stepKey, episode);
    const upstreamKey = upstreamClusterKey(episode);
    if (upstreamKey) addToCluster(upstreamKey, episode);
  }

  const groups: LlmGroup[] = [];
  for (const [clusterKey, clusterEpisodes] of clusters.entries()) {
    const uniqueEpisodes = [...new Map(clusterEpisodes.map((episode) => [episode.id, episode])).values()];
    if (uniqueEpisodes.length < 2) continue;
    if (!passesDeterministicClusterGate(clusterKey, uniqueEpisodes)) continue;
    const facet = deriveCanonicalLoopFacet(uniqueEpisodes[0]);
    const sharedSources = [...new Set(uniqueEpisodes.flatMap((episode) => episode.sources))].slice(0, 6);
    const loopLayer = clusterKey.startsWith("upstream:")
      ? "upstream_preparation"
      : inferLoopLayer(uniqueEpisodes);
    groups.push({
      episodeIds: uniqueEpisodes.map((episode) => episode.id),
      loopName: uniqueEpisodes[0]?.title ?? facet.abstractedJtbd.slice(0, 80),
      sharedIntent: facet.abstractedJtbd,
      sharedOutputType: uniqueEpisodes[0]?.outputType ?? "unknown",
      sharedSources: sharedSources.length > 0 ? sharedSources : ["unknown"],
      reasoning: `Deterministic cluster on ${clusterKey}.`,
      loopLayer,
      status: "monitor_pattern",
      confidence: 0.78,
    });
  }
  return groups;
}

function mergeGroupsAcrossBatches(groups: LlmGroup[]): LlmGroup[] {
  const merged: LlmGroup[] = [];
  for (const group of groups) {
    const matchIndex = merged.findIndex((existing) => {
      if (groupKey(existing) === groupKey(group)) return true;
      const overlap = groupOverlapCount(existing.episodeIds, group.episodeIds);
      if (overlap === 0) return false;
      return outputTypeMatches(existing.sharedOutputType, group.sharedOutputType)
        && intentMatches(existing.sharedIntent, group.sharedIntent)
        && hasSourceOverlap(existing.sharedSources, group.sharedSources);
    });
    if (matchIndex === -1) {
      merged.push(group);
      continue;
    }
    const existing = merged[matchIndex];
    const episodeIds = [...new Set([...existing.episodeIds, ...group.episodeIds])];
    merged[matchIndex] = {
      ...existing,
      episodeIds,
      loopName: existing.confidence >= group.confidence ? existing.loopName : group.loopName,
      sharedIntent: existing.confidence >= group.confidence ? existing.sharedIntent : group.sharedIntent,
      sharedOutputType: existing.confidence >= group.confidence ? existing.sharedOutputType : group.sharedOutputType,
      sharedSources: [...new Set([...existing.sharedSources, ...group.sharedSources])],
      loopLayer: existing.loopLayer === "upstream_preparation" || group.loopLayer === "upstream_preparation"
        ? (existing.loopLayer === "output_production" || group.loopLayer === "output_production" ? "mixed" : "upstream_preparation")
        : existing.loopLayer ?? group.loopLayer,
      reasoning: `${existing.reasoning} Merged with ${group.reasoning}`,
      confidence: Math.max(existing.confidence, group.confidence),
      status: existing.status === "approved_loop" || group.status === "approved_loop"
        ? "approved_loop"
        : existing.status,
    };
  }
  return merged;
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

function hasConcreteRepeatedAction(episodes: EpisodeRecord[]): boolean {
  const signatures = episodes.map((episode) => deriveCanonicalLoopFacet(episode).mechanismSignature);
  if (signatures.length < 2) return false;
  const memoryOnly = episodes.every((episode) =>
    episode.turns.every((turn) => turn.sourceEventType === "memory_record")
  );
  const normalizedStepBlocks = episodes
    .map((episode) => episode.steps.join(" ").toLowerCase().replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0);
  if (normalizedStepBlocks.length >= 2) {
    const stepSet = new Set(normalizedStepBlocks);
    if (stepSet.size === 1 && (normalizedStepBlocks[0]?.length ?? 0) >= 24) return true;
  }
  const upstreamStepBlocks = episodes
    .map((episode) => (episode.upstreamWork?.steps ?? []).join(" ").toLowerCase().replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0);
  if (upstreamStepBlocks.length >= 2) {
    const upstreamSet = new Set(upstreamStepBlocks);
    if (upstreamSet.size === 1 && (upstreamStepBlocks[0]?.length ?? 0) >= 16) return true;
  }
  const unique = new Set(signatures);
  if (unique.size === 1 && !memoryOnly) return true;
  return false;
}

function isLookupOnlyEpisode(episode: EpisodeRecord): boolean {
  const signal = `${episode.intent} ${episode.steps.join(" ")}`.toLowerCase();
  return /\b(lookup|look up|search|find|retrieve)\b/.test(signal) && episode.steps.length <= 1;
}

function hasRepeatedCopywritingMemoryWorkflow(episodes: EpisodeRecord[]): boolean {
  if (episodes.length < 2) return false;
  const copywritingEpisodes = episodes.filter((episode) => {
    const signal = `${episode.outputType} ${episode.intent} ${episode.steps.join(" ")}`.toLowerCase();
    const hasArtifact = /\b(newsletter|email|copy|copywriting|positioning|product philosophy|technical explanations?)\b/.test(signal);
    const hasAction = /\b(write|writing|draft|brainstorm|hooks?|structure|refine|sharpen|finalize|turn .* into|product copy)\b/.test(signal);
    return hasArtifact && hasAction;
  });
  return copywritingEpisodes.length >= 2;
}

function isMemoryOnlyGroup(episodes: EpisodeRecord[]): boolean {
  return episodes.every((episode) =>
    episode.turns.every((turn) => turn.sourceEventType === "memory_record")
  );
}

function passesDeterministicClusterGate(clusterKey: string, episodes: EpisodeRecord[]): boolean {
  if (hasConcreteRepeatedAction(episodes)) return true;
  if (isMemoryOnlyGroup(episodes) && hasRepeatedCopywritingMemoryWorkflow(episodes)) return true;
  if (clusterKey.startsWith("upstream:") || clusterKey.startsWith("steps:")) return true;
  if (clusterKey.startsWith("coarse:")) return episodes.length >= 3;
  if (clusterKey.startsWith("mechanism:")) return !isMemoryOnlyGroup(episodes);
  return false;
}

function applyDeterministicGuards(
  groups: LlmGroup[],
  episodesById: Map<string, EpisodeRecord>
): LlmGroup[] {
  return groups.map((group) => {
    const groupEpisodes = group.episodeIds
      .map((id) => episodesById.get(id))
      .filter((episode): episode is EpisodeRecord => Boolean(episode));
    if (groupEpisodes.length < 2) {
      return {
        ...group,
        status: "rejected_insufficient_evidence",
        confidence: 0.2,
        reasoning: `${group.reasoning} Rejected: fewer than 2 valid episodes.`,
      };
    }

    const progression = evaluateProjectProgression(groupEpisodes);
    if (progression.isProjectProgression) {
      return {
        ...group,
        status: "rejected_topical_similarity",
        confidence: Math.min(group.confidence, 0.2),
        reasoning: `${group.reasoning} Rejected as project progression (${progression.reason}).`,
      };
    }

    const memoryOnly = groupEpisodes.every((episode) =>
      episode.turns.every((turn) => turn.sourceEventType === "memory_record")
    );
    const lookupOnly = groupEpisodes.every(isLookupOnlyEpisode);
    const repeatedCopywritingMemoryWorkflow = memoryOnly && hasRepeatedCopywritingMemoryWorkflow(groupEpisodes);
    const coarseKeys = new Set(groupEpisodes.map((episode) => coarseMechanismClusterKey(deriveCanonicalLoopFacet(episode))));
    const sharedCoarsePattern = coarseKeys.size === 1 && groupEpisodes.length >= 2;
    if ((memoryOnly || lookupOnly) && !hasConcreteRepeatedAction(groupEpisodes) && !repeatedCopywritingMemoryWorkflow && !sharedCoarsePattern) {
      return {
        ...group,
        status: "rejected_insufficient_evidence",
        confidence: Math.min(group.confidence, 0.25),
        reasoning: `${group.reasoning} Rejected: memory/lookup-only evidence without repeated concrete action pattern.`,
      };
    }

    const mechanisms = new Set(groupEpisodes.map((episode) => deriveCanonicalLoopFacet(episode).mechanismSignature));
    if (mechanisms.size === 1 || repeatedCopywritingMemoryWorkflow) {
      return {
        ...group,
        status: "approved_loop",
        confidence: 1,
        reasoning: `${group.reasoning} Approved by deterministic ${repeatedCopywritingMemoryWorkflow ? "copywriting memory workflow" : "canonical mechanism match"}.`,
      };
    }
    if (sharedCoarsePattern && !memoryOnly && (groupEpisodes.length >= 3 || hasConcreteRepeatedAction(groupEpisodes))) {
      return {
        ...group,
        status: "approved_loop",
        confidence: Math.max(group.confidence, 0.82),
        reasoning: `${group.reasoning} Approved by deterministic coarse workflow pattern match.`,
      };
    }
    return group;
  });
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

  async execute(
    episodes: EpisodeRecord[],
    options?: { runId?: string; progress?: LoopMinerRunProgress }
  ): Promise<{
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
    const deterministicGroups = buildDeterministicCandidateGroups(episodes);
    options?.progress?.step("loop detector deterministic clustering complete", {
      inputEpisodes: episodes.length,
      deterministicGroups: deterministicGroups.length,
    });
    const BATCH_SIZE = 10;
    const OVERLAP = 3;
    const batches = createBatches(compacted, BATCH_SIZE, OVERLAP);
    const allGroups: LlmGroup[] = [];

    for (const [batchIndex, batch] of batches.entries()) {
      const batchStartedAt = Date.now();
      options?.progress?.step("loop detector batch started", {
        batchIndex: batchIndex + 1,
        batchTotal: batches.length,
        episodeCount: batch.length,
      });
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
        options?.progress?.step("loop detector batch failed", {
          batchIndex: batchIndex + 1,
          batchTotal: batches.length,
          durationMs: Date.now() - batchStartedAt,
          reason: errorMessage(error),
        });
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
      options?.progress?.step("loop detector batch completed", {
        batchIndex: batchIndex + 1,
        batchTotal: batches.length,
        durationMs: Date.now() - batchStartedAt,
        groupsFound: validGroups.length,
        groupsTotalSoFar: allGroups.length + validGroups.length,
      });
      allGroups.push(...validGroups);
    }

    const mergedGroups = mergeGroupsAcrossBatches([...deterministicGroups, ...allGroups]);
    options?.progress?.step("loop detector merging candidate groups", {
      llmGroups: allGroups.length,
      deterministicGroups: deterministicGroups.length,
      mergedGroups: mergedGroups.length,
    });
    const dedupedGroups = dedupeStrictSubsetGroups(mergedGroups);
    const episodesById = new Map(episodes.map((episode) => [episode.id, episode]));
    const guardedGroups = applyDeterministicGuards(dedupedGroups, episodesById);

    const approvedGroups = guardedGroups.filter((g) => g.status === "approved_loop");
    options?.progress?.step("loop detector guardrails applied", {
      candidateGroups: guardedGroups.length,
      approvedGroups: approvedGroups.length,
      rejectedGroups: guardedGroups.length - approvedGroups.length,
    });
    const approvedIds = approvedGroups.map((g) => groupKey(g));
    const loops = approvedGroups.map(buildCandidateLoop);

    const patternTrace = buildPatternTrace(guardedGroups, approvedIds);

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
