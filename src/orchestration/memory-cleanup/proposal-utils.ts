import {
  CLEANUP_BUCKETS,
  CLEANUP_PROPOSAL_TYPES,
  CLEANUP_RISK_LEVELS,
  type CleanupBucket,
  type CleanupMemoryCandidate,
  type CleanupProposalInput,
  type CleanupProposalType,
  type CleanupRiskLevel,
  type CleanupSnapshot,
} from "./types.js";

export function readJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (!fenced) return {};
    try {
      const parsed = JSON.parse(fenced);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
}

export function isCleanupProposalType(value: unknown): value is CleanupProposalType {
  return typeof value === "string" && (CLEANUP_PROPOSAL_TYPES as readonly string[]).includes(value);
}

export function isCleanupBucket(value: unknown): value is CleanupBucket {
  return typeof value === "string" && (CLEANUP_BUCKETS as readonly string[]).includes(value);
}

export function normalizeRiskLevel(value: unknown, fallback: CleanupRiskLevel = "medium"): CleanupRiskLevel {
  return typeof value === "string" && (CLEANUP_RISK_LEVELS as readonly string[]).includes(value)
    ? value as CleanupRiskLevel
    : fallback;
}

export function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

export function normalizeProposal(value: unknown): CleanupProposalInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const proposalType = row.proposalType ?? row.proposal_type;
  if (!isCleanupProposalType(proposalType)) return null;
  const sourceMemoryIds = readStringArray(row.sourceMemoryIds ?? row.source_memory_ids);
  const targetMemoryIdRaw = row.targetMemoryId ?? row.target_memory_id;
  const proposedContentRaw = row.proposedContent ?? row.proposed_content;
  const bucketRaw = row.bucket ?? row.cleanupBucket ?? row.cleanup_bucket;
  const bucketReasonRaw = row.bucketReason ?? row.bucket_reason;
  const bucketConfidenceRaw = row.bucketConfidence ?? row.bucket_confidence;
  const rationale = typeof row.rationale === "string" && row.rationale.trim() ? row.rationale.trim() : "No rationale provided.";
  return {
    proposalType,
    sourceMemoryIds,
    targetMemoryId: typeof targetMemoryIdRaw === "string" && targetMemoryIdRaw.trim() ? targetMemoryIdRaw.trim() : null,
    proposedContent: typeof proposedContentRaw === "string" && proposedContentRaw.trim() ? proposedContentRaw.trim() : null,
    rationale,
    riskLevel: normalizeRiskLevel(row.riskLevel ?? row.risk_level),
    confidence: normalizeConfidence(row.confidence),
    bucket: isCleanupBucket(bucketRaw) ? bucketRaw : null,
    bucketReason: typeof bucketReasonRaw === "string" && bucketReasonRaw.trim() ? bucketReasonRaw.trim() : null,
    bucketConfidence: bucketConfidenceRaw === undefined || bucketConfidenceRaw === null
      ? null
      : normalizeConfidence(bucketConfidenceRaw),
  };
}

export function validateProposal(proposal: CleanupProposalInput, snapshot: CleanupSnapshot): string | null {
  const memoryIds = new Set(snapshot.selectedMemoryIds);
  if (proposal.sourceMemoryIds.length === 0) return "missing_source_memory_ids";
  if (proposal.sourceMemoryIds.some((id) => !memoryIds.has(id))) return "unknown_source_memory_id";
  if (proposal.targetMemoryId && !memoryIds.has(proposal.targetMemoryId)) return "unknown_target_memory_id";

  const protectedIds = new Set(snapshot.protectedMemoryIds);
  const touchesProtected = proposal.sourceMemoryIds.some((id) => protectedIds.has(id));
  if (proposal.proposalType === "bucket") {
    if (proposal.sourceMemoryIds.length !== 1) return "bucket_requires_one_source";
    if (!proposal.bucket) return "bucket_requires_bucket";
    if (touchesProtected && proposal.bucket !== "permanent") return "protected_memory_must_be_permanent";
  }
  if (proposal.proposalType === "prune") {
    if (proposal.sourceMemoryIds.length !== 1) return "prune_requires_one_source";
    if (touchesProtected) return "prune_protected_memory";
  }
  if (proposal.proposalType === "rewrite") {
    if (proposal.sourceMemoryIds.length !== 1) return "rewrite_requires_one_source";
    if (!proposal.proposedContent) return "rewrite_requires_content";
  }
  if (proposal.proposalType === "promote" && proposal.sourceMemoryIds.length !== 1) {
    return "promote_requires_one_source";
  }
  if (proposal.proposalType === "merge") {
    if (proposal.sourceMemoryIds.length < 2) return "merge_requires_multiple_sources";
    if (!proposal.targetMemoryId) return "merge_requires_target";
    if (!proposal.sourceMemoryIds.includes(proposal.targetMemoryId)) return "merge_target_must_be_source";
  }
  return null;
}

function relativeAgeDays(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const days = Math.round((Date.now() - new Date(isoDate).getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return null;
  return `${days}d`;
}

export function compactSnapshotForAi(snapshot: CleanupSnapshot): Record<string, unknown> {
  const memories = snapshot.memories.map((memory) => ({
    id: memory.id,
    content: memory.content.slice(0, 200),
    memoryType: memory.memoryType,
    category: memory.category ?? null,
    isPinned: memory.isPinned,
    refs: memory.referenceCount,
    ageCreated: relativeAgeDays(memory.createdAt),
    ageLastRef: relativeAgeDays(memory.lastReferencedAt),
    protected: memory.protected,
    protectionReasons: memory.protectionReasons.length > 0 ? memory.protectionReasons : undefined,
    bucket: memory.bucket,
    bucketReason: memory.bucketReason,
  }));
  return {
    memoryCount: snapshot.memoryCount,
    selectedMemoryIds: snapshot.selectedMemoryIds,
    duplicateGroups: snapshot.duplicateGroups,
    staleCandidateIds: snapshot.staleCandidateIds,
    conflictCandidateIds: snapshot.conflictCandidateIds,
    protectedMemoryIds: snapshot.protectedMemoryIds,
    bucketCounts: snapshot.bucketCounts,
    memories,
  };
}

export function findCandidate(snapshot: CleanupSnapshot, id: string): CleanupMemoryCandidate | null {
  return snapshot.memories.find((memory) => memory.id === id) ?? null;
}
