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
    type: "newsletter" | "email" | "summary" | "proposal" | "code" | "changelog" | "unknown";
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

export interface LoopMinerSummary {
  episodesBuilt: number;
  loopsDetected: number;
  loopsQualified: number;
  suggestionsCreated: number;
  durationMs: number;
  aiCalls: number;
  usage: CleanupAiUsage;
  warnings?: string[];
  skipped?: boolean;
  skipReason?: string;
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
  createEpisode(input: {
    auth: AuthContext;
    runId: string;
    extraction: EpisodeExtraction;
    turns: EpisodeTurnRecord[];
  }): Promise<EpisodeRecord>;
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
}
