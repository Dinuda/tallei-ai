import type { MemoryRecordRow } from "../../infrastructure/repositories/memory.repository.js";

export const CLEANUP_BUCKETS = ["short_term", "long_term", "permanent"] as const;
export const CLEANUP_PROPOSAL_TYPES = ["bucket", "keep", "promote", "merge", "rewrite", "prune"] as const;
export const CLEANUP_PROPOSAL_STATUSES = ["proposed", "contested", "approved", "rejected", "applied", "failed"] as const;
export const CLEANUP_RISK_LEVELS = ["low", "medium", "high"] as const;
export const CLEANUP_RUN_STATUSES = ["running", "completed", "failed"] as const;
export const CLEANUP_RUN_REASONS = ["daily_intelligence", "manual"] as const;

export type CleanupProposalType = (typeof CLEANUP_PROPOSAL_TYPES)[number];
export type CleanupBucket = (typeof CLEANUP_BUCKETS)[number];
export type CleanupProposalStatus = (typeof CLEANUP_PROPOSAL_STATUSES)[number];
export type CleanupRiskLevel = (typeof CLEANUP_RISK_LEVELS)[number];
export type CleanupRunStatus = (typeof CLEANUP_RUN_STATUSES)[number];
export type CleanupRunReason = (typeof CLEANUP_RUN_REASONS)[number];

export interface CleanupMemoryCandidate {
  id: string;
  content: string;
  contentHash: string;
  platform: string;
  summaryJson: unknown;
  memoryType: string;
  category: string | null;
  isPinned: boolean;
  referenceCount: number;
  lastReferencedAt: string | null;
  createdAt: string;
  protected: boolean;
  protectionReasons: string[];
  bucket: CleanupBucket;
  bucketReason: string;
  bucketConfidence: number;
}

export interface CleanupSnapshot {
  memoryCount: number;
  selectedMemoryIds: string[];
  duplicateGroups: Array<{ contentHash: string; memoryIds: string[] }>;
  staleCandidateIds: string[];
  conflictCandidateIds: string[];
  protectedMemoryIds: string[];
  bucketCounts: Record<CleanupBucket, number>;
  memories: CleanupMemoryCandidate[];
}

export interface CleanupAiUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedPromptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTotalTokens: number;
  estimatedCostUsd: number;
  models: Record<string, number>;
}

export interface CleanupProposalInput {
  proposalType: CleanupProposalType;
  sourceMemoryIds: string[];
  targetMemoryId: string | null;
  proposedContent: string | null;
  rationale: string;
  riskLevel: CleanupRiskLevel;
  confidence: number;
  bucket?: CleanupBucket | null;
  bucketReason?: string | null;
  bucketConfidence?: number | null;
}

export interface AdversaryResult {
  contested: boolean;
  riskLevel: CleanupRiskLevel;
  critique: string;
  failureModes: string[];
  recommendedAction: "approve" | "reject" | "modify";
}

export interface DebateRound {
  consolidator: string;
  adversary: string;
  updatedProposal: CleanupProposalInput | null;
}

export interface DebateResult {
  rounds: DebateRound[];
  finalProposal: CleanupProposalInput;
}

export interface JudgeResult {
  decision: "approve" | "reject" | "modify";
  finalProposal: CleanupProposalInput;
  confidence: number;
  rationale: string;
  applyAllowed: boolean;
}

export interface MemoryCleanupProposalView {
  id: string;
  proposalType: CleanupProposalType;
  status: CleanupProposalStatus;
  sourceMemoryIds: string[];
  targetMemoryId: string | null;
  proposedContent: string | null;
  rationale: string;
  riskLevel: CleanupRiskLevel;
  confidence: number;
  bucket: CleanupBucket | null;
  bucketReason: string | null;
  bucketConfidence: number | null;
  trace?: {
    consolidator: unknown;
    adversary: unknown;
    debate: unknown;
    judge: unknown;
    apply: unknown;
  };
}

export interface MemoryCleanupSummary {
  proposed: number;
  contested: number;
  approved: number;
  rejected: number;
  applied: number;
  failed: number;
  kept: number;
  bucketed: number;
  shortTerm: number;
  longTerm: number;
  permanent: number;
  promoted: number;
  merged: number;
  rewritten: number;
  pruned: number;
  durationMs?: number;
  aiCalls?: number;
  selectedMemories?: number;
  batches?: number;
  remainingUnreviewed?: number;
  usage?: CleanupAiUsage;
  skipped?: boolean;
  skipReason?: string;
}

export interface MemoryCleanupRunView {
  id: string;
  status: CleanupRunStatus;
  runReason: CleanupRunReason;
  dryRun: boolean;
  summary: MemoryCleanupSummary;
  proposals: MemoryCleanupProposalView[];
}

export interface CleanupApplyDeps {
  invalidateRecallCache(auth: { tenantId: string; userId: string }): void;
  invalidateBm25Cache(auth: { tenantId: string; userId: string }): void;
  bumpRecallStamp(auth: { tenantId: string; userId: string }): Promise<void>;
}

export type CleanupMemoryRow = MemoryRecordRow;
