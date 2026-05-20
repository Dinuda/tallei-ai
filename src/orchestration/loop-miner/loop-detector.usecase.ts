import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../providers/ai/types.js";
import type { CleanupAiUsage } from "../memory-cleanup/types.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage, recordCleanupAiUsage } from "../memory-cleanup/usage.js";
import { loopMinerModelForPhase } from "./model.js";
import { PATTERN_ADVERSARY_PROMPT, PATTERN_CONSOLIDATOR_PROMPT, PATTERN_JUDGE_PROMPT } from "./prompts.js";
import type {
  CandidateLoop,
  EpisodeRecord,
  PatternAdversaryFinding,
  PatternCandidateGroup,
  PatternJudgeDecision,
  PatternJudgeStatus,
  PatternTrace,
  PhaseUsageMetrics,
  WorkEpisodeFacet,
} from "./types.js";
import {
  estimatePromptTokensFromRequest,
  normalizeConfidence,
  readJsonObject,
  readString,
  readStringArray,
} from "./utils.js";

type ChatFn = (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
type EmbedFn = (text: string) => Promise<number[] | null>;
type EvidenceKind =
  | "declared_routine"
  | "observed_work_episode"
  | "workflow_support"
  | "preference_support"
  | "project_context"
  | "profile_context"
  | "negative_or_stale";

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "before",
  "between",
  "build",
  "can",
  "chatgpt",
  "claude",
  "collaboration",
  "course",
  "create",
  "created",
  "draft",
  "each",
  "for",
  "from",
  "have",
  "help",
  "imported",
  "into",
  "involv",
  "make",
  "me",
  "memory",
  "more",
  "my",
  "needs",
  "should",
  "source",
  "that",
  "the",
  "this",
  "through",
  "turn",
  "type",
  "use",
  "used",
  "using",
  "with",
  "work",
  "workflow",
  "week",
  "weekly",
  "monthly",
  "daily",
]);

const STRUCTURAL_ARTIFACT_ALLOWLIST = new Set(["newsletter", "changelog", "email", "proposal", "code", "summary"]);
const ACTION_SIGNATURE_STOP_WORDS = new Set([
  "artifact",
  "chatgpt",
  "claude",
  "content",
  "draft",
  "imported",
  "memory",
  "process",
  "source",
  "support",
  "task",
  "workflow",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}

function stemToken(token: string): string {
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function signatureTokens(text: string): string[] {
  const tokens = normalizeText(text)
    .split(/\s+/)
    .map(stemToken)
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !STOP_WORDS.has(token));
  return [...new Set(tokens)];
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function cosine(left: number[] | null | undefined, right: number[] | null | undefined): number {
  if (!left || !right || left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMag = 0;
  let rightMag = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMag += a * a;
    rightMag += b * b;
  }
  if (leftMag === 0 || rightMag === 0) return 0;
  return Math.max(0, Math.min(1, (dot / (Math.sqrt(leftMag) * Math.sqrt(rightMag)) + 1) / 2));
}

function compactList(values: readonly string[], fallback = "unknown"): string[] {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  return cleaned.length > 0 ? [...new Set(cleaned)] : [fallback];
}

function observedTimeFromTurnText(turnText: string): string | null {
  const match = turnText.match(/source datetime:\s*([^\n]+)/i);
  if (!match?.[1]) return null;
  const parsed = Date.parse(match[1].trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function observedTimeFromEpisode(episode: EpisodeRecord): string | null {
  const memoryTurnTimes = episode.turns
    .filter((turn) => turn.sourceEventType === "memory_record")
    .map((turn) => observedTimeFromTurnText(turn.contentSummary) ?? turn.createdAt)
    .filter((value): value is string => Boolean(value));
  const earliestMemoryTime = memoryTurnTimes.sort().at(0);
  if (earliestMemoryTime) return earliestMemoryTime;
  return episode.sealedAt;
}

function classifyEvidenceKind(episode: EpisodeRecord): EvidenceKind {
  const intentText = `${episode.intent} ${episode.summary ?? ""}`.toLowerCase();
  const isMemoryEpisode = episode.turns.some((turn) => turn.sourceEventType === "memory_record");
  const isProfileContext = /\b(founder\b.*\bfocused on\b|engineer\b.*\bfocused on\b|engineer from|based in|lives in|from sri lanka)\b/.test(intentText);
  const isPreference = /\b(prefer|preference|i like|i dislike)\b/.test(intentText);
  if (isProfileContext) return "profile_context";
  if (isPreference) return "preference_support";
  if (episode.approved === false) return "negative_or_stale";
  if (episode.outputType === "workflow_memory" && isMemoryEpisode && episode.automationSignals?.repeatable) {
    return "declared_routine";
  }
  if (isMemoryEpisode && episode.outputType === "unknown") return "workflow_support";
  if (isMemoryEpisode) return "observed_work_episode";
  if (episode.outputType === "unknown") return "project_context";
  return "observed_work_episode";
}

function isSeedEvidence(kind: EvidenceKind): boolean {
  return kind === "declared_routine" || kind === "observed_work_episode";
}

function splitByArtifactAction(facets: WorkEpisodeFacet[]): WorkEpisodeFacet[][] {
  if (facets.length < 4) return [facets];
  const byKey = new Map<string, WorkEpisodeFacet[]>();
  for (const facet of facets) {
    const key = `${facet.artifactProduced}::${actionSignature(facet)}`;
    const current = byKey.get(key) ?? [];
    current.push(facet);
    byKey.set(key, current);
  }
  const viable = [...byKey.values()].filter((group) => group.length >= 2);
  if (viable.length < 2) return [facets];
  return viable;
}

function facetFromEpisode(episode: EpisodeRecord): WorkEpisodeFacet {
  const title = episode.title ?? "";
  const summary = episode.summary ?? "";
  const outputDescription = episode.output?.description ?? "";
  const turnText = episode.turns.map((turn) => turn.contentSummary).join(" ");
  const actionPattern = compactList(episode.steps.length > 0 ? episode.steps : [episode.intent]);
  const artifactProduced = episode.output?.type && episode.output.type !== "unknown"
    ? episode.output.type
    : episode.outputType || outputDescription || "unknown";
  const evidence = [episode.intent, title, summary, outputDescription, actionPattern.join(" "), turnText].join(" ");
  return {
    episodeId: episode.id,
    jobToBeDone: episode.intent,
    artifactProduced,
    inputSources: compactList(episode.sources),
    toolsUsed: compactList(episode.toolNames),
    actionPattern,
    stylePattern: compactList(episode.styleHints ?? [], "unspecified"),
    outcomeSignal: [
      episode.approved ? "approved" : "unapproved",
      episode.userBehavior?.approvalSignal ?? "unclear",
      episode.automationSignals?.repeatable ? "repeatable" : "not_declared_repeatable",
      episode.automationSignals?.likelyCadence ?? "unknown_cadence",
    ].join(" | "),
    timeSignal: observedTimeFromEpisode(episode) ?? episode.sealedAt,
    rawEvidenceIds: episode.eventIds,
    lexicalSignature: signatureTokens(evidence),
    embeddingText: [episode.intent, artifactProduced, actionPattern.join(" "), episode.sources.join(" ")].join("\n"),
  };
}

function hasMemoryTurn(episode: EpisodeRecord): boolean {
  return episode.turns.some((turn) => turn.sourceEventType === "memory_record");
}

function isMemoryEpisode(episode: EpisodeRecord | undefined): boolean {
  return episode?.turns.some((turn) => turn.sourceEventType === "memory_record") === true;
}

function isRepeatableEpisode(episode: EpisodeRecord | undefined): boolean {
  return episode?.automationSignals?.repeatable === true;
}

function cadenceSignal(facets: readonly WorkEpisodeFacet[]): string {
  const values = facets
    .map((facet) => facet.outcomeSignal.match(/\b(daily|weekly|monthly|event_based|unknown)_?cadence?\b/)?.[1])
    .filter((value): value is string => Boolean(value) && value !== "unknown");
  return values.length > 0 ? [...new Set(values)].join(", ") : "implicit_or_unknown";
}

function sharedTerms(facets: readonly WorkEpisodeFacet[], selector: (facet: WorkEpisodeFacet) => string[]): string[] {
  const counts = new Map<string, number>();
  for (const facet of facets) {
    for (const value of selector(facet)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([value]) => value);
}

function actionTokens(facet: WorkEpisodeFacet): string[] {
  return signatureTokens(facet.actionPattern.join(" "));
}

function matchingActionTokens(facet: WorkEpisodeFacet): string[] {
  const artifact = new Set(artifactTokens(facet));
  return actionTokens(facet)
    .filter((token) => !artifact.has(token) && !ACTION_SIGNATURE_STOP_WORDS.has(token))
    .slice(0, 6);
}

function actionSignature(facet: WorkEpisodeFacet): string {
  const tokens = matchingActionTokens(facet).slice(0, 4).sort();
  return tokens.join("|");
}

function artifactTokens(facet: WorkEpisodeFacet): string[] {
  return signatureTokens(facet.artifactProduced);
}

function sourceTokens(facet: WorkEpisodeFacet): string[] {
  return signatureTokens(facet.inputSources.join(" "));
}

function isImportedMemorySource(facet: WorkEpisodeFacet): boolean {
  return facet.inputSources.some((source) => /imported chatgpt memory/i.test(source));
}

function toolTokens(facet: WorkEpisodeFacet): string[] {
  return signatureTokens(facet.toolsUsed.join(" "));
}

function sameDayDistance(left: string, right: string): number {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const dayMs = 24 * 60 * 60_000;
  const days = Math.abs(a - b) / dayMs;
  if (days >= 3) return 1;
  return days > 0 ? 0.5 : 0;
}

interface PairScore {
  score: number;
  actionSimilarity: number;
  jobSimilarity: number;
  artifactSimilarity: number;
  sourceSimilarity: number;
  toolSimilarity: number;
  vectorSimilarity: number;
}

function scorePair(left: WorkEpisodeFacet, right: WorkEpisodeFacet, embeddings: Map<string, number[] | null>): PairScore {
  const actionSimilarity = jaccard(actionTokens(left), actionTokens(right));
  const jobSimilarity = jaccard(left.lexicalSignature, right.lexicalSignature);
  const artifactSimilarity = Math.max(
    left.artifactProduced === right.artifactProduced && left.artifactProduced !== "unknown" ? 1 : 0,
    jaccard(artifactTokens(left), artifactTokens(right))
  );
  const sourceSimilarity = jaccard(sourceTokens(left), sourceTokens(right));
  const toolSimilarity = jaccard(toolTokens(left), toolTokens(right));
  const vectorSimilarity = cosine(embeddings.get(left.episodeId), embeddings.get(right.episodeId));
  const timeSimilarity = sameDayDistance(left.timeSignal, right.timeSignal);
  const score =
      (vectorSimilarity * 0.2)
      + (actionSimilarity * 0.28)
      + (jobSimilarity * 0.24)
      + (artifactSimilarity * 0.14)
      + (sourceSimilarity * 0.08)
      + (toolSimilarity * 0.04)
      + (timeSimilarity * 0.02);
  const canUseArtifactSourceBoost = left.artifactProduced !== "workflow_memory"
    && right.artifactProduced !== "workflow_memory"
    && left.artifactProduced !== "unknown"
    && right.artifactProduced !== "unknown"
    && !(isImportedMemorySource(left) && isImportedMemorySource(right));
  const sameArtifactAndSourceBoost = canUseArtifactSourceBoost && artifactSimilarity >= 0.9 && sourceSimilarity >= 0.5 && jobSimilarity >= 0.1
    ? 0.66
    : 0;
  return {
    score: Math.max(score, sameArtifactAndSourceBoost),
    actionSimilarity,
    jobSimilarity,
    artifactSimilarity,
    sourceSimilarity,
    toolSimilarity,
    vectorSimilarity,
  };
}

function pairLooksLikeRepeatedWork(pair: PairScore): boolean {
  const strongSharedShape = pair.score >= 0.42
    && pair.jobSimilarity >= 0.18
    && (pair.actionSimilarity >= 0.12 || pair.artifactSimilarity >= 0.5)
    && (pair.artifactSimilarity >= 0.18 || pair.sourceSimilarity >= 0.18 || pair.toolSimilarity >= 0.18 || pair.vectorSimilarity >= 0.72);
  const veryStrongSemanticShape = pair.score >= 0.58 && pair.jobSimilarity >= 0.26;
  return strongSharedShape || veryStrongSemanticShape;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  constructor(ids: readonly string[]) {
    for (const id of ids) this.parent.set(id, id);
  }

  find(id: string): string {
    const parent = this.parent.get(id) ?? id;
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent.set(b, a);
  }
}

function titleFromFacets(facets: readonly WorkEpisodeFacet[]): string {
  const artifacts = sharedTerms(facets, (facet) => [facet.artifactProduced]);
  if (artifacts.includes("newsletter")) return "Newsletter writing pattern";
  if (artifacts.includes("changelog")) return "Release notes pattern";
  const terms = sharedTerms(facets, (facet) => facet.lexicalSignature)
    .filter((term) => !["unknown", "unspecified"].includes(term));
  if (terms.includes("newsletter")) return "Newsletter writing pattern";
  if (terms.includes("changelog") || terms.includes("release")) return "Release notes pattern";
  if (terms.includes("analytic") || terms.includes("experiment")) return "Analytics experiment planning pattern";
  if (terms.length > 0) return `${terms.slice(0, 3).map((term) => term.charAt(0).toUpperCase() + term.slice(1)).join(" ")} pattern`;
  return "Repeated work pattern";
}

function candidateFromFacets(id: string, facets: WorkEpisodeFacet[], confidence: number, reason: string): PatternCandidateGroup {
  const sharedActions = sharedTerms(facets, actionTokens);
  const sharedSources = sharedTerms(facets, (facet) => facet.inputSources);
  const sharedTools = sharedTerms(facets, (facet) => facet.toolsUsed);
  const artifacts = sharedTerms(facets, (facet) => [facet.artifactProduced]);
  return {
    id,
    episodeIds: facets.map((facet) => facet.episodeId),
    title: titleFromFacets(facets),
    sharedJob: facets[0]?.jobToBeDone ?? "Repeated work",
    sharedArtifact: artifacts[0] ?? "unknown",
    sharedActions,
    sharedSources,
    sharedTools,
    evidenceSummary: facets.map((facet) => `${facet.episodeId}: ${facet.jobToBeDone}`).join(" | "),
    confidence,
    cadenceSignal: cadenceSignal(facets),
    generationReason: reason,
    facets,
  };
}

function generateCandidateGroups(episodes: EpisodeRecord[], facets: WorkEpisodeFacet[], embeddings: Map<string, number[] | null>): PatternCandidateGroup[] {
  const groups: PatternCandidateGroup[] = [];
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
  const seedFacets = facets.filter((facet) => {
    const episode = episodeById.get(facet.episodeId);
    if (!episode) return false;
    return isSeedEvidence(classifyEvidenceKind(episode));
  });
  let index = 1;
  const structurallyAssigned = new Set<string>();
  const memoryByActionKey = new Map<string, WorkEpisodeFacet[]>();
  for (const facet of seedFacets) {
    const episode = episodeById.get(facet.episodeId);
    if (!isMemoryEpisode(episode)) continue;
    const actionKey = actionSignature(facet);
    if (!actionKey || actionKey.split("|").length < 2) continue;
    const key = `${facet.artifactProduced}::${actionKey}`;
    const current = memoryByActionKey.get(key) ?? [];
    current.push(facet);
    memoryByActionKey.set(key, current);
  }
  for (const groupFacets of memoryByActionKey.values()) {
    if (groupFacets.length < 2) continue;
    for (const facet of groupFacets) structurallyAssigned.add(facet.episodeId);
    const hasDeclaredRepeatability = groupFacets.some((facet) =>
      isRepeatableEpisode(episodeById.get(facet.episodeId))
    );
    groups.push(candidateFromFacets(
      `pattern-${index}`,
      groupFacets,
      hasDeclaredRepeatability ? 0.72 : 0.64,
      "matching_memory_entries"
    ));
    index += 1;
  }

  const structuralByKey = new Map<string, WorkEpisodeFacet[]>();
  for (const facet of seedFacets) {
    if (structurallyAssigned.has(facet.episodeId)) continue;
    const actionKey = actionSignature(facet);
    if (!actionKey || actionKey.split("|").length < 2) continue;
    const key = `${facet.artifactProduced}::${actionKey}`;
    const current = structuralByKey.get(key) ?? [];
    current.push(facet);
    structuralByKey.set(key, current);
  }
  for (const groupFacets of structuralByKey.values()) {
    if (groupFacets.length < 2) continue;
    if (groupFacets[0]?.artifactProduced === "unknown") continue;
    if (!STRUCTURAL_ARTIFACT_ALLOWLIST.has(groupFacets[0]?.artifactProduced ?? "")) continue;
    for (const facet of groupFacets) structurallyAssigned.add(facet.episodeId);
    groups.push(candidateFromFacets(`pattern-${index}`, groupFacets, 0.68, "artifact_source_pattern"));
    index += 1;
  }

  const hybridSeedFacets = seedFacets.filter((facet) => !structurallyAssigned.has(facet.episodeId));
  const uf = new UnionFind(seedFacets.map((facet) => facet.episodeId));
  const bestScores = new Map<string, number>();

  for (let leftIndex = 0; leftIndex < hybridSeedFacets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < hybridSeedFacets.length; rightIndex += 1) {
      const left = hybridSeedFacets[leftIndex];
      const right = hybridSeedFacets[rightIndex];
      if (!left || !right) continue;
      const pair = scorePair(left, right, embeddings);
      const leftEpisode = episodeById.get(left.episodeId);
      const rightEpisode = episodeById.get(right.episodeId);
      const bothMemoryEpisodes = isMemoryEpisode(leftEpisode) && isMemoryEpisode(rightEpisode);
      if (bothMemoryEpisodes) {
        const eitherDeclaresRepeatability = isRepeatableEpisode(leftEpisode) || isRepeatableEpisode(rightEpisode);
        const hasMatchingActions = pair.actionSimilarity >= 0.22 || actionSignature(left) === actionSignature(right);
        if (!hasMatchingActions || (!eitherDeclaresRepeatability && pair.artifactSimilarity < 0.9)) continue;
      }
      if (!pairLooksLikeRepeatedWork(pair)) continue;
      uf.union(left.episodeId, right.episodeId);
      bestScores.set(left.episodeId, Math.max(bestScores.get(left.episodeId) ?? 0, pair.score));
      bestScores.set(right.episodeId, Math.max(bestScores.get(right.episodeId) ?? 0, pair.score));
    }
  }

  const byRoot = new Map<string, WorkEpisodeFacet[]>();
  for (const facet of hybridSeedFacets) {
    const root = uf.find(facet.episodeId);
    const current = byRoot.get(root) ?? [];
    current.push(facet);
    byRoot.set(root, current);
  }

  for (const groupFacets of byRoot.values()) {
    if (groupFacets.length < 2) continue;
    const splitGroups = splitByArtifactAction(groupFacets);
    for (const refinedFacets of splitGroups) {
      if (refinedFacets.length < 2) continue;
      const confidence = refinedFacets.reduce((sum, facet) => sum + (bestScores.get(facet.episodeId) ?? 0.5), 0) / refinedFacets.length;
      const allMemoryEntries = refinedFacets.every((facet) => isMemoryEpisode(episodeById.get(facet.episodeId)));
      const reason = allMemoryEntries
        ? "matching_memory_entries"
        : splitGroups.length > 1
          ? "artifact_action_split_group"
          : "hybrid_similarity_group";
      groups.push(candidateFromFacets(`pattern-${index}`, refinedFacets, Math.max(0.5, Math.min(0.92, confidence)), reason));
      index += 1;
    }
  }

  return groups;
}

function traceCandidate(group: PatternCandidateGroup): Omit<PatternCandidateGroup, "facets"> & { episodeIds: string[] } {
  const { facets: _facets, ...rest } = group;
  return rest;
}

function fallbackLoop(group: PatternCandidateGroup): CandidateLoop {
  return {
    loopName: group.title,
    episodeIds: group.episodeIds,
    sharedIntent: group.sharedJob,
    sharedSources: group.sharedSources,
    sharedOutputType: group.sharedArtifact,
    reasoning: `${group.generationReason}: ${group.evidenceSummary}`,
    patternConfidence: group.confidence,
  };
}

function normalizeAdversaryFinding(value: unknown, group: PatternCandidateGroup): PatternAdversaryFinding {
  const row = readObject(value);
  const rawRisk = row.riskLevel ?? row.risk_level;
  const riskLevel = rawRisk === "low" || rawRisk === "medium" || rawRisk === "high" ? rawRisk : "medium";
  const rawAction = row.recommendedAction ?? row.recommended_action;
  const recommendedAction = rawAction === "approve" || rawAction === "monitor" || rawAction === "reject"
    ? rawAction
    : "monitor";
  return {
    candidateGroupId: readString(row.candidateGroupId ?? row.candidate_group_id, group.id),
    contested: typeof row.contested === "boolean" ? row.contested : recommendedAction !== "approve",
    riskLevel,
    critique: readString(row.critique, "No adversary critique provided."),
    failureModes: readStringArray(row.failureModes ?? row.failure_modes),
    recommendedAction,
  };
}

function normalizeJudgeDecision(value: unknown, group: PatternCandidateGroup, adversary: PatternAdversaryFinding): PatternJudgeDecision {
  const row = readObject(value);
  const rawStatus = row.status;
  const status: PatternJudgeStatus =
    rawStatus === "approved_loop"
      || rawStatus === "approved_with_modification"
      || rawStatus === "monitor_pattern"
      || rawStatus === "rejected_topical_similarity"
      || rawStatus === "rejected_insufficient_evidence"
      ? rawStatus
      : adversary.recommendedAction === "approve"
        ? "approved_loop"
        : adversary.recommendedAction === "reject"
          ? "rejected_insufficient_evidence"
          : "monitor_pattern";
  const loopName = readString(row.loopName ?? row.loop_name, group.title);
  const sharedIntent = readString(row.sharedIntent ?? row.shared_intent, group.sharedJob);
  const sharedSources = readStringArray(row.sharedSources ?? row.shared_sources);
  const sharedOutputType = readString(row.sharedOutputType ?? row.shared_output_type, group.sharedArtifact);
  const episodeIds = readStringArray(row.episodeIds ?? row.episode_ids).filter((id) => group.episodeIds.includes(id));
  const reasoning = readString(row.reasoning, row.rationale ? String(row.rationale) : group.evidenceSummary);
  return {
    candidateGroupId: readString(row.candidateGroupId ?? row.candidate_group_id, group.id),
    status,
    confidence: normalizeConfidence(row.confidence ?? group.confidence),
    rationale: readString(row.rationale, reasoning),
    candidateLoop: status === "approved_loop" || status === "approved_with_modification" ? {
      loopName,
      episodeIds: episodeIds.length >= 2 ? episodeIds : group.episodeIds,
      sharedIntent,
      sharedSources: sharedSources.length > 0 ? sharedSources : group.sharedSources,
      sharedOutputType,
      reasoning,
      patternConfidence: normalizeConfidence(row.confidence ?? group.confidence),
      patternStatus: status,
    } : undefined,
  };
}

function heuristicAdversary(group: PatternCandidateGroup): PatternAdversaryFinding {
  const weakMultiEpisode = group.episodeIds.length >= 2 && group.confidence < 0.5;
  const knownArtifactPattern = group.sharedArtifact !== "unknown" && group.sharedSources.length > 0;
  const weakActions = group.sharedActions.length < 2 && group.episodeIds.length >= 2 && !knownArtifactPattern;
  const likelyCourseContext = group.sharedSources.some((source) => /course|lesson|slide|ai makers/i.test(source))
    || group.sharedArtifact === "slides";
  const courseTopicOnly = likelyCourseContext
    && group.sharedActions.includes("slide") === false
    && group.sharedActions.includes("lesson") === false
    && group.facets.every((facet) => facet.lexicalSignature.includes("ai") || facet.lexicalSignature.includes("maker"))
    && group.sharedActions.length < 3;
  if (courseTopicOnly) {
    return {
      candidateGroupId: group.id,
      contested: true,
      riskLevel: "high",
      critique: "The group may be sharing course/topic vocabulary without enough repeated action-pattern evidence.",
      failureModes: ["topical_similarity"],
      recommendedAction: "reject",
    };
  }
  if (weakMultiEpisode || weakActions) {
    return {
      candidateGroupId: group.id,
      contested: true,
      riskLevel: "medium",
      critique: "The group has some similarity, but the repeated workflow steps are still weak.",
      failureModes: ["insufficient_repeated_actions"],
      recommendedAction: "monitor",
    };
  }
  return {
    candidateGroupId: group.id,
    contested: false,
    riskLevel: "low",
    critique: "The group shares a repeated job, artifact, and action/source pattern.",
    failureModes: [],
    recommendedAction: "approve",
  };
}

function heuristicJudge(group: PatternCandidateGroup, adversary: PatternAdversaryFinding): PatternJudgeDecision {
  let status: PatternJudgeStatus;
  const autoApproveEligible =
    !adversary.contested
    && adversary.recommendedAction === "approve"
    && group.episodeIds.length >= 2
    && group.confidence >= 0.78
    && group.sharedActions.length >= 2;
  if (adversary.recommendedAction === "reject") {
    status = adversary.failureModes.includes("topical_similarity")
      ? "rejected_topical_similarity"
      : "rejected_insufficient_evidence";
  } else if (autoApproveEligible) {
    status = "approved_loop";
  } else if (adversary.recommendedAction === "monitor") {
    status = "monitor_pattern";
  } else {
    status = "approved_loop";
  }
  const loop = fallbackLoop(group);
  return {
    candidateGroupId: group.id,
    status,
    confidence: group.confidence,
    rationale: adversary.critique,
    candidateLoop: status === "approved_loop" ? { ...loop, patternStatus: status } : undefined,
  };
}

export class PatternConsolidatorUseCase {
  constructor(private readonly chat: ChatFn = (request) => aiProviderRegistry.chat(request)) {}

  async execute(groups: PatternCandidateGroup[]): Promise<{ loops: CandidateLoop[]; raw: unknown; aiCalls: number; usage: CleanupAiUsage; warnings: string[] }> {
    const usage = emptyCleanupAiUsage();
    if (groups.length === 0) return { loops: [], raw: { skipped: "no_candidate_groups" }, aiCalls: 0, usage, warnings: [] };
    const request: ChatCompletionRequest = {
      model: loopMinerModelForPhase("detector"),
      temperature: 0,
      maxTokens: 1800,
      responseFormat: "json_object",
      messages: [
        { role: "system", content: PATTERN_CONSOLIDATOR_PROMPT },
        { role: "user", content: JSON.stringify({ candidateGroups: groups.map(traceCandidate) }) },
      ],
    };
    try {
      const response = await this.chat(request);
      recordCleanupAiUsage(usage, request, response);
      const raw = readJsonObject(response.text);
      const rows = Array.isArray(raw.groups) ? raw.groups : [];
      const loops = groups.map((group) => {
        const row = rows
          .map(readObject)
          .find((item) => readString(item.candidateGroupId ?? item.candidate_group_id, "") === group.id);
        if (!row) return fallbackLoop(group);
        return {
          loopName: readString(row.loopName ?? row.loop_name, group.title),
          episodeIds: group.episodeIds,
          sharedIntent: readString(row.sharedIntent ?? row.shared_intent, group.sharedJob),
          sharedSources: readStringArray(row.sharedSources ?? row.shared_sources).length > 0
            ? readStringArray(row.sharedSources ?? row.shared_sources)
            : group.sharedSources,
          sharedOutputType: readString(row.sharedOutputType ?? row.shared_output_type, group.sharedArtifact),
          reasoning: readString(row.reasoning, group.evidenceSummary),
          patternConfidence: normalizeConfidence(row.confidence ?? group.confidence),
        };
      });
      return { loops, raw, aiCalls: 1, usage, warnings: [] };
    } catch (error) {
      return {
        loops: groups.map(fallbackLoop),
        raw: { fallback: "pattern_consolidator_failed", error: errorMessage(error) },
        aiCalls: 0,
        usage,
        warnings: [`phase=pattern_consolidator estimatedPromptTokens=${estimatePromptTokensFromRequest(request)} reason=${errorMessage(error)}`],
      };
    }
  }
}

export class PatternAdversaryUseCase {
  constructor(private readonly chat: ChatFn = (request) => aiProviderRegistry.chat(request)) {}

  async execute(groups: PatternCandidateGroup[], loops: CandidateLoop[]): Promise<{ findings: PatternAdversaryFinding[]; raw: unknown; aiCalls: number; usage: CleanupAiUsage; warnings: string[] }> {
    const usage = emptyCleanupAiUsage();
    if (groups.length === 0) return { findings: [], raw: { skipped: "no_candidate_groups" }, aiCalls: 0, usage, warnings: [] };
    const request: ChatCompletionRequest = {
      model: loopMinerModelForPhase("detector"),
      temperature: 0,
      maxTokens: 1600,
      responseFormat: "json_object",
      messages: [
        { role: "system", content: PATTERN_ADVERSARY_PROMPT },
        { role: "user", content: JSON.stringify({ candidateGroups: groups.map(traceCandidate), consolidatedLoops: loops }) },
      ],
    };
    try {
      const response = await this.chat(request);
      recordCleanupAiUsage(usage, request, response);
      const raw = readJsonObject(response.text);
      const rows = Array.isArray(raw.findings) ? raw.findings : [];
      const findings = groups.map((group) => {
        const row = rows
          .map(readObject)
          .find((item) => readString(item.candidateGroupId ?? item.candidate_group_id, "") === group.id);
        return row ? normalizeAdversaryFinding(row, group) : heuristicAdversary(group);
      });
      return { findings, raw, aiCalls: 1, usage, warnings: [] };
    } catch (error) {
      return {
        findings: groups.map(heuristicAdversary),
        raw: { fallback: "pattern_adversary_failed", error: errorMessage(error) },
        aiCalls: 0,
        usage,
        warnings: [`phase=pattern_adversary estimatedPromptTokens=${estimatePromptTokensFromRequest(request)} reason=${errorMessage(error)}`],
      };
    }
  }
}

export class PatternJudgeUseCase {
  constructor(private readonly chat: ChatFn = (request) => aiProviderRegistry.chat(request)) {}

  async execute(groups: PatternCandidateGroup[], loops: CandidateLoop[], findings: PatternAdversaryFinding[]): Promise<{ decisions: PatternJudgeDecision[]; raw: unknown; aiCalls: number; usage: CleanupAiUsage; warnings: string[] }> {
    const usage = emptyCleanupAiUsage();
    if (groups.length === 0) return { decisions: [], raw: { skipped: "no_candidate_groups" }, aiCalls: 0, usage, warnings: [] };
    const request: ChatCompletionRequest = {
      model: loopMinerModelForPhase("detector"),
      temperature: 0,
      maxTokens: 1700,
      responseFormat: "json_object",
      messages: [
        { role: "system", content: PATTERN_JUDGE_PROMPT },
        { role: "user", content: JSON.stringify({ candidateGroups: groups.map(traceCandidate), consolidatedLoops: loops, adversaryFindings: findings }) },
      ],
    };
    try {
      const response = await this.chat(request);
      recordCleanupAiUsage(usage, request, response);
      const raw = readJsonObject(response.text);
      const rows = Array.isArray(raw.decisions) ? raw.decisions : [];
      const decisions = groups.map((group) => {
        const adversary = findings.find((finding) => finding.candidateGroupId === group.id) ?? heuristicAdversary(group);
        const row = rows
          .map(readObject)
          .find((item) => readString(item.candidateGroupId ?? item.candidate_group_id, "") === group.id);
        return row ? normalizeJudgeDecision(row, group, adversary) : heuristicJudge(group, adversary);
      });
      return { decisions, raw, aiCalls: 1, usage, warnings: [] };
    } catch (error) {
      return {
        decisions: groups.map((group) => heuristicJudge(group, findings.find((finding) => finding.candidateGroupId === group.id) ?? heuristicAdversary(group))),
        raw: { fallback: "pattern_judge_failed", error: errorMessage(error) },
        aiCalls: 0,
        usage,
        warnings: [`phase=pattern_judge estimatedPromptTokens=${estimatePromptTokensFromRequest(request)} reason=${errorMessage(error)}`],
      };
    }
  }
}

export class LoopDetectorUseCase {
  constructor(
    private readonly chat: ChatFn = (request) => aiProviderRegistry.chat(request),
    private readonly embed: EmbedFn | null = null
  ) {}

  private async embedFacets(facets: WorkEpisodeFacet[], warnings: string[]): Promise<Map<string, number[] | null>> {
    const vectors = new Map<string, number[] | null>();
    if (!this.embed) {
      for (const facet of facets) vectors.set(facet.episodeId, null);
      return vectors;
    }
    await Promise.all(facets.map(async (facet) => {
      try {
        vectors.set(facet.episodeId, await this.embed?.(facet.embeddingText) ?? null);
      } catch (error) {
        warnings.push(`phase=pattern_embeddings episodeId=${facet.episodeId} reason=${errorMessage(error)}`);
        vectors.set(facet.episodeId, null);
      }
    }));
    return vectors;
  }

  async execute(episodes: EpisodeRecord[]): Promise<{
    loops: CandidateLoop[];
    raw: unknown[];
    aiCalls: number;
    usage: CleanupAiUsage;
    warnings: string[];
    patternTrace: PatternTrace;
    phaseUsage: PhaseUsageMetrics;
  }> {
    const usage = emptyCleanupAiUsage();
    const warnings: string[] = [];
    const rawResponses: unknown[] = [];
    const facets = episodes.map(facetFromEpisode);
    const embeddings = await this.embedFacets(facets, warnings);
    const candidateGroups = generateCandidateGroups(episodes, facets, embeddings);
    const emptyTrace: PatternTrace = {
      candidateGroups: candidateGroups.map(traceCandidate),
      approvedGroups: [],
      rejectedGroups: [],
      adversaryFindings: [],
      judgeDecisions: [],
    };
    if (candidateGroups.length === 0) {
      return {
        loops: [],
        raw: [{ skipped: "no_pattern_candidate_groups" }],
        aiCalls: 0,
        usage,
        warnings,
        patternTrace: emptyTrace,
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

    const consolidator = new PatternConsolidatorUseCase(this.chat);
    const consolidated = await consolidator.execute(candidateGroups);
    mergeCleanupAiUsage(usage, consolidated.usage);
    rawResponses.push({ phase: "pattern_consolidator", raw: consolidated.raw });
    warnings.push(...consolidated.warnings);

    const adversary = new PatternAdversaryUseCase(this.chat);
    const challenged = await adversary.execute(candidateGroups, consolidated.loops);
    mergeCleanupAiUsage(usage, challenged.usage);
    rawResponses.push({ phase: "pattern_adversary", raw: challenged.raw });
    warnings.push(...challenged.warnings);

    const judge = new PatternJudgeUseCase(this.chat);
    const judged = await judge.execute(candidateGroups, consolidated.loops, challenged.findings);
    mergeCleanupAiUsage(usage, judged.usage);
    rawResponses.push({ phase: "pattern_judge", raw: judged.raw });
    warnings.push(...judged.warnings);

    const loops = judged.decisions
      .filter((decision) => (decision.status === "approved_loop" || decision.status === "approved_with_modification") && decision.candidateLoop)
      .map((decision) => decision.candidateLoop as CandidateLoop);
    const trace: PatternTrace = {
      candidateGroups: candidateGroups.map(traceCandidate),
      approvedGroups: judged.decisions
        .filter((decision) => decision.status === "approved_loop" || decision.status === "approved_with_modification")
        .map((decision) => decision.candidateGroupId),
      rejectedGroups: judged.decisions
        .filter((decision) => decision.status !== "approved_loop" && decision.status !== "approved_with_modification")
        .map((decision) => ({
          candidateGroupId: decision.candidateGroupId,
          status: decision.status,
          rationale: decision.rationale,
        })),
      adversaryFindings: challenged.findings,
      judgeDecisions: judged.decisions,
    };
    const aiCalls = consolidated.aiCalls + challenged.aiCalls + judged.aiCalls;
    return {
      loops,
      raw: rawResponses,
      aiCalls,
      usage,
      warnings,
      patternTrace: trace,
      phaseUsage: {
        calls: aiCalls,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        estimatedTotalTokens: usage.estimatedTotalTokens,
        estimatedCostUsd: Number(usage.estimatedCostUsd.toFixed(6)),
        batchesProcessed: candidateGroups.length,
        batchesSkipped: 0,
        inputEpisodes: episodes.length,
        outputEpisodes: loops.length,
      },
    };
  }
}
