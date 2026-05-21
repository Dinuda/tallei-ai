import type { AuthContext } from "../../domain/auth/index.js";
import type { CleanupAiUsage } from "../memory-cleanup/types.js";

export type LoopMinerRunStatus = "running" | "completed" | "failed";
export type LoopMinerRunReason = "daily_intelligence" | "manual";
export type LoopMinerSourceEventType = "ai_activity_event" | "collab_task" | "memory_record";
export type EpisodeTurnRole = "user" | "assistant" | "system";
export type LoopVerdict = "automate" | "monitor" | "discard";

export interface MinerEvent {
  id: string;
  sourceEventType: LoopMinerSourceEventType;
  createdAt: string;
  platform: string;
  contentSummary: string;
  role: EpisodeTurnRole;
  metadata: unknown;
}

export interface EpisodeExtraction {
  title?: string;
  summary?: string;
  intent: string;
  intentDetails?: {
    label: string;
    goal: string;
    confidence: number;
  };
  sources: string[];
  sourceDetails?: Array<{
    type: "memory" | "document" | "conversation" | "integration" | "manual_input";
    name: string;
    id?: string;
    importance: number;
  }>;
  outputType: string;
  output?: {
    type: "newsletter" | "email" | "summary" | "proposal" | "code" | "changelog" | "slides" | "deck" | "course_material" | "document" | "brief" | "plan" | "unknown";
    description: string;
    finalArtifact?: string;
  };
  toolNames: string[];
  steps: string[];
  styleHints?: string[];
  userBehavior?: {
    accepted?: boolean | null;
    edited?: boolean | null;
    regenerated?: boolean | null;
    ignored?: boolean | null;
    approvalSignal?: "approved" | "rejected" | "unclear";
  };
  automationSignals?: {
    repeatable: boolean;
    likelyCadence?: "daily" | "weekly" | "monthly" | "event_based" | "unknown";
    businessValue: number;
    automationReadiness: number;
  };
  confidence?: number;
  approved: boolean;
  eventIds: string[];
}

export interface EpisodeRecord extends EpisodeExtraction {
  id: string;
  sourceFingerprint?: string;
  extractionVersion?: string;
  embeddingTextHash?: string;
  embeddingStatus?: "pending" | "ready" | "failed";
  embeddedAt?: string | null;
  sealedAt: string;
  turnCount: number;
  turns: EpisodeTurnRecord[];
}

export interface EpisodeTurnRecord {
  role: EpisodeTurnRole;
  contentSummary: string;
  sourceEventType: LoopMinerSourceEventType;
  sourceEventId: string;
  createdAt: string;
}

export interface CandidateLoop {
  loopName: string;
  episodeIds: string[];
  sharedIntent: string;
  sharedSources: string[];
  sharedOutputType: string;
  reasoning: string;
  patternConfidence?: number;
  patternStatus?: PatternJudgeStatus;
}

export interface WorkEpisodeFacet {
  episodeId: string;
  jobToBeDone: string;
  artifactProduced: string;
  inputSources: string[];
  toolsUsed: string[];
  actionPattern: string[];
  stylePattern: string[];
  outcomeSignal: string;
  timeSignal: string;
  rawEvidenceIds: string[];
  lexicalSignature: string[];
  embeddingText: string;
}

export interface PatternCandidateGroup {
  id: string;
  episodeIds: string[];
  title: string;
  sharedJob: string;
  sharedArtifact: string;
  sharedActions: string[];
  sharedSources: string[];
  sharedTools: string[];
  evidenceSummary: string;
  confidence: number;
  cadenceSignal: string;
  generationReason: string;
  facets: WorkEpisodeFacet[];
}

export interface PatternAdversaryFinding {
  candidateGroupId: string;
  contested: boolean;
  riskLevel: "low" | "medium" | "high";
  critique: string;
  failureModes: string[];
  recommendedAction: "approve" | "monitor" | "reject";
}

export type PatternJudgeStatus =
  | "approved_loop"
  | "approved_with_modification"
  | "monitor_pattern"
  | "rejected_topical_similarity"
  | "rejected_insufficient_evidence";

export interface PatternJudgeDecision {
  candidateGroupId: string;
  status: PatternJudgeStatus;
  confidence: number;
  rationale: string;
  candidateLoop?: CandidateLoop;
}

export interface PatternTrace {
  candidateGroups: Array<Omit<PatternCandidateGroup, "facets"> & { episodeIds: string[] }>;
  approvedGroups: string[];
  rejectedGroups: Array<{ candidateGroupId: string; status: PatternJudgeStatus; rationale: string }>;
  adversaryFindings: PatternAdversaryFinding[];
  judgeDecisions: PatternJudgeDecision[];
}

export interface LoopEvaluation {
  loopName: string;
  episodeIds: string[];
  confidence: number;
  verdict: LoopVerdict;
  reasoning: string;
  estimatedCadence: string;
  estimatedValue: "low" | "medium" | "high";
  automationReadiness: "full" | "partial" | "manual";
  risks: string[];
}

export interface WorkflowDNA {
  name: string;
  trigger: { type: "schedule" | "event"; cadence: string };
  sources: string[];
  outputType: string;
  stepPattern: string[];
  style: string;
  approvalBehavior: "auto" | "require_explicit_approval";
  reasoning: string;
}

export type LoopMinerIncrementalMode = "full" | "incremental" | "skipped_no_new_evidence";

export interface LoopMinerIncrementalSummary {
  mode: LoopMinerIncrementalMode;
  evidenceFingerprint: string;
  extractionVersion: string;
  totalEvidenceEvents: number;
  newEvidenceEvents: number;
  reusedEpisodes: number;
  newEpisodes: number;
  reusedSuggestions: number;
  suggestionsUpdated?: number;
}

export interface LoopMinerSummary {
  episodesBuilt: number;
  loopsDetected: number;
  loopsProposed?: number;
  loopsApproved?: number;
  loopsContested?: number;
  loopsAutoApproved?: number;
  loopsRejected?: number;
  cleanupEvidenceUsed?: number;
  cleanupSuppressedSeeds?: number;
  timeSignalsUsed?: number;
  loopsQualified: number;
  suggestionsCreated: number;
  durationMs: number;
  aiCalls: number;
  usage: CleanupAiUsage;
  incremental?: LoopMinerIncrementalSummary;
  warnings?: string[];
  skipped?: boolean;
  skipReason?: string;
  memorySelection?: LoopMinerMemorySelectionSummary;
  memoryDecisionLog?: LoopMinerMemoryDecision[];
  debugTrace?: {
    eventIngest?: {
      beforeFallback: {
        total: number;
        aiActivity: number;
        collabTask: number;
        memoryRecord: number;
      };
      afterFallback: {
        total: number;
        aiActivity: number;
        collabTask: number;
        memoryRecord: number;
      };
      fallbackEventsAdded: number;
      fallbackEventsReplaced: number;
      includedMemoryIdsSample: string[];
      memoryEventIdsSample: string[];
    };
    episodeBuilder?: {
      inputEvents: number;
      deterministicMemoryExtractions: number;
      llmInputEvents: number;
      rawDeterministicSamples: Array<{
        eventId: string;
        title?: string;
        outputType?: string;
        cadence?: string;
      }>;
      builtEpisodeSamples: Array<{
        id: string;
        title: string;
        outputType: string;
        sourceEventTypes: string[];
        eventIds: string[];
      }>;
    };
    detector?: {
      inputEpisodes: number;
      candidateGroups: number;
      approvedGroups: number;
      rejectedGroups: number;
      warningCount: number;
    };
    vectorRetrieval?: {
      status: "skipped";
      reason: string;
    };
  };
  patternTrace?: PatternTrace;
  phaseUsage?: {
    episodeBuilder?: EpisodeBuilderEfficiencyMetrics;
    loopDetector?: PhaseUsageMetrics;
    loopEvaluator?: PhaseUsageMetrics;
    dnaGenerator?: PhaseUsageMetrics;
  };
}

export interface PhaseUsageMetrics {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedTotalTokens: number;
  estimatedCostUsd: number;
  batchesProcessed: number;
  batchesSkipped: number;
  inputEpisodes?: number;
  outputEpisodes?: number;
  loopsInput?: number;
  loopsOutput?: number;
}

export interface EpisodeBuilderEfficiencyMetrics extends PhaseUsageMetrics {
  inputEvents: number;
  tokensPerInputEvent: number;
  tokensPerOutputEpisode: number;
  costPerOutputEpisodeUsd: number;
  maxEstimatedPromptTokensPerCall: number;
}

export type LoopMinerMemoryDecisionStatus = "included" | "excluded";

export interface LoopMinerMemorySelectionSummary {
  considered: number;
  included: number;
  excluded: number;
  sourceImportsIncluded: number;
  unbucketedIncluded: number;
  bucketedExcluded: number;
  decryptFailures: number;
  fallbackEventsAdded?: number;
  fallbackEventsReplaced?: number;
  eventFeedAfterFallback?: number;
}

export interface LoopMinerMemoryDecision {
  memoryId: string;
  status: LoopMinerMemoryDecisionStatus;
  reason: string;
  contentPreview: string;
  createdAt: string;
  selectedAt: string;
  memoryType: string;
  detectedMemoryType?: string | null;
  category?: string | null;
  cleanupBucket?: string | null;
  isPinned: boolean;
  sourceImport: boolean;
  sourcePlatform?: string | null;
  sourceImportMode?: string | null;
  sourceImportBatchId?: string | null;
  sourceDateTime?: string | null;
  observedAt?: string | null;
  cleanupAppliedAt?: string | null;
  cleanupAction?: string | null;
  cleanupTargetMemoryId?: string | null;
  cleanupSourceMemoryIds?: string[] | null;
  minerImportance: number;
  memoryImportance: number;
}

export interface LoopMinerSuggestion {
  id: string;
  title: string;
  reason: string;
  suggestedPrompt: string;
  status: "pending";
  confidence: number;
  fingerprint: string;
  triggerCount: number;
  createdAt: string;
}

export interface LoopMinerSuggestionWriteResult {
  suggestion: LoopMinerSuggestion | null;
  created: boolean;
  updated: boolean;
}

export interface LoopMinerRunResult {
  id: string;
  status: LoopMinerRunStatus;
  summary: LoopMinerSummary;
  suggestions: LoopMinerSuggestion[];
}

export interface LoopMinerWorkflowSuggestionView extends LoopMinerSuggestion {
  metadata: unknown;
}

export interface LoopMinerRunView {
  id: string;
  status: LoopMinerRunStatus;
  summary: LoopMinerSummary;
  error: unknown;
  createdAt: string;
  completedAt: string | null;
  episodes: EpisodeRecord[];
  suggestions: LoopMinerWorkflowSuggestionView[];
}

export interface LoopMinerRepository {
  hasRunningDailyRun(auth: AuthContext): Promise<boolean>;
  hasCompletedDailyRunToday(auth: AuthContext): Promise<boolean>;
  createRun(input: { auth: AuthContext; runReason: LoopMinerRunReason }): Promise<string>;
  completeRun(input: {
    auth: AuthContext;
    runId: string;
    status: "completed" | "failed";
    summary: LoopMinerSummary;
    error?: unknown;
  }): Promise<void>;
  listRecentEvents(auth: AuthContext, days: number): Promise<MinerEvent[]>;
  listMemoryDecisionLog?(auth: AuthContext, days: number): Promise<LoopMinerMemoryDecision[]>;
  getLatestCompletedIncrementalState?(auth: AuthContext, lookbackDays: number): Promise<{
    evidenceFingerprint: string;
    summary: LoopMinerSummary;
  } | null>;
  findEpisodesBySourceFingerprints?(input: {
    auth: AuthContext;
    sourceFingerprints: string[];
    extractionVersion: string;
  }): Promise<Map<string, EpisodeRecord>>;
  findEpisodesBySourceEventIds?(input: {
    auth: AuthContext;
    sourceEventIds: string[];
    sourceEventType?: LoopMinerSourceEventType;
  }): Promise<Map<string, EpisodeRecord>>;
  listReusableLoopMinerSuggestions?(auth: AuthContext): Promise<LoopMinerSuggestion[]>;
  createEpisode(input: {
    auth: AuthContext;
    runId: string;
    extraction: EpisodeExtraction;
    turns: EpisodeTurnRecord[];
    sourceFingerprint?: string;
    extractionVersion?: string;
  }): Promise<EpisodeRecord>;
  findReusableEpisodeBySourceFingerprint?(input: {
    auth: AuthContext;
    sourceFingerprint: string;
    extractionVersion: string;
  }): Promise<EpisodeRecord | null>;
  updateEpisodeEmbeddingMetadata?(input: {
    auth: AuthContext;
    episodeId: string;
    embeddingTextHash: string;
    status: "pending" | "ready" | "failed";
    embeddedAt?: string | null;
  }): Promise<void>;
  listEpisodeContext(auth: AuthContext, episodeIds: string[]): Promise<EpisodeRecord[]>;
  createWorkflowSuggestion(input: {
    auth: AuthContext;
    runId: string;
    candidateLoop: CandidateLoop;
    evaluation: LoopEvaluation;
    dna: WorkflowDNA;
    suggestedPrompt: string;
    fingerprint: string;
  }): Promise<LoopMinerSuggestion | null>;
  createOrUpdateWorkflowSuggestion?(input: {
    auth: AuthContext;
    runId: string;
    candidateLoop: CandidateLoop;
    evaluation: LoopEvaluation;
    dna: WorkflowDNA;
    suggestedPrompt: string;
    fingerprint: string;
  }): Promise<LoopMinerSuggestionWriteResult>;
}
