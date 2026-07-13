import type { AuthContext } from "../../domain/auth/index.js";
import type { MemoryRecordRow } from "../../infrastructure/repositories/memory.repository.js";
import {
  interestingMemoryScore,
  selectNewestHybrid,
  type HybridMemorySelectionSummary,
  type MemorySelectionStrategy,
} from "../memory/hybrid-memory-selection.js";
import { classifyCleanupBucket } from "./bucket-classifier.js";
import type { CleanupMemoryCandidate, CleanupSnapshot } from "./types.js";

interface SnapshotDeps {
  listCandidateMemories(auth: AuthContext, input: {
    limit: number;
    includeReviewed?: boolean;
    excludeMemoryIds?: string[];
    selectionStrategy?: MemorySelectionStrategy;
  }): Promise<MemoryRecordRow[]>;
  decryptMemoryContent(ciphertext: string): string;
}

export interface CleanupSnapshotSelectionOptions {
  strategy?: MemorySelectionStrategy;
  newestLimit?: number;
  interestingLimit?: number;
  candidateLimit?: number;
}

const PROTECTED_CATEGORIES = new Set([
  "identity",
  "auth",
  "billing",
  "security",
  "legal",
  "payment",
  "credentials",
  "account",
]);

const PROTECTED_CONTENT_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "api_key", pattern: /\b(api[_\s-]?key|secret[_\s-]?key|access[_\s-]?token|bearer\s+[a-z0-9._-]+)/i },
  { reason: "password", pattern: /\b(password|passphrase|recovery\s+code)\b/i },
  { reason: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { reason: "phone", pattern: /\b(?:\+?\d[\d\s().-]{7,}\d)\b/i },
  { reason: "address", pattern: /\b(address|street|apt|apartment|postcode|zip\s+code)\b/i },
  { reason: "legal", pattern: /\b(contract|legal|nda|liability|terms|compliance)\b/i },
  { reason: "billing", pattern: /\b(billing|payment|invoice|credit\s+card|bank\s+account)\b/i },
];

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readPreferenceKey(summaryJson: unknown): string | null {
  const value = readObject(summaryJson).preference_key;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function daysSince(value: string | null | undefined, nowMs: number): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (nowMs - time) / 86_400_000;
}

function protectionReasons(row: MemoryRecordRow, content: string): string[] {
  const reasons: string[] = [];
  if (row.is_pinned) reasons.push("pinned");
  if (row.memory_type === "preference") reasons.push("preference");
  if (row.category && PROTECTED_CATEGORIES.has(row.category.toLowerCase())) {
    reasons.push(`category:${row.category.toLowerCase()}`);
  }
  for (const candidate of PROTECTED_CONTENT_PATTERNS) {
    if (candidate.pattern.test(content)) reasons.push(candidate.reason);
  }
  return [...new Set(reasons)];
}

function isStaleCandidate(row: MemoryRecordRow, nowMs: number): boolean {
  if (row.is_pinned || row.memory_type === "preference") return false;
  const lastActivityDays = Math.min(
    daysSince(row.last_referenced_at, nowMs),
    daysSince(row.created_at, nowMs)
  );
  if (row.reference_count <= 1 && lastActivityDays >= 30) return true;
  if ((row.memory_type === "note" || row.memory_type === "event") && row.reference_count <= 2 && lastActivityDays >= 14) {
    return true;
  }
  return false;
}

function buildDuplicateGroups(memories: CleanupMemoryCandidate[]): Array<{ contentHash: string; memoryIds: string[] }> {
  const groups = new Map<string, string[]>();
  for (const memory of memories) {
    const ids = groups.get(memory.contentHash) ?? [];
    ids.push(memory.id);
    groups.set(memory.contentHash, ids);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([contentHash, memoryIds]) => ({ contentHash, memoryIds }));
}

function buildConflictCandidateIds(memories: CleanupMemoryCandidate[]): string[] {
  const groups = new Map<string, string[]>();
  for (const memory of memories) {
    const preferenceKey = readPreferenceKey(memory.summaryJson);
    const key = preferenceKey
      ? `preference:${preferenceKey}`
      : memory.memoryType === "preference" && memory.category
        ? `category:${memory.category}`
        : null;
    if (!key) continue;
    const ids = groups.get(key) ?? [];
    ids.push(memory.id);
    groups.set(key, ids);
  }
  return [...new Set([...groups.values()].filter((ids) => ids.length > 1).flat())];
}

export class BuildCleanupSnapshotUseCase {
  constructor(private readonly deps: SnapshotDeps) {}

  async execute(
    auth: AuthContext,
    maxMemories = 200,
    includeReviewed = false,
    excludeMemoryIds: string[] = [],
    selectionOptions: CleanupSnapshotSelectionOptions = {}
  ): Promise<CleanupSnapshot> {
    const strategy = selectionOptions.strategy ?? "current_priority";
    const newestLimit = Math.max(1, selectionOptions.newestLimit ?? 150);
    const interestingLimit = Math.max(0, selectionOptions.interestingLimit ?? 50);
    const candidateLimit = strategy === "newest_hybrid"
      ? Math.max(maxMemories, selectionOptions.candidateLimit ?? 2_000)
      : maxMemories;
    const rows = await this.deps.listCandidateMemories(auth, {
      limit: candidateLimit,
      includeReviewed,
      excludeMemoryIds,
      selectionStrategy: strategy,
    });
    const nowMs = Date.now();
    const memories: CleanupMemoryCandidate[] = [];

    for (const row of rows) {
      let content = "";
      try {
        content = this.deps.decryptMemoryContent(row.content_ciphertext);
      } catch {
        continue;
      }
      const reasons = protectionReasons(row, content);
      const bucket = classifyCleanupBucket({
        row,
        content,
        protected: reasons.length > 0,
        protectionReasons: reasons,
        nowMs,
      });
      memories.push({
        id: row.id,
        content,
        contentHash: row.content_hash,
        platform: row.platform,
        summaryJson: row.summary_json,
        memoryType: row.memory_type,
        category: row.category,
        isPinned: row.is_pinned,
        referenceCount: row.reference_count,
        importance: row.importance,
        lastReferencedAt: row.last_referenced_at,
        createdAt: row.created_at,
        protected: reasons.length > 0,
        protectionReasons: reasons,
        bucket: bucket.bucket,
        bucketReason: bucket.reason,
        bucketConfidence: bucket.confidence,
      });
    }

    let selectedMemories = memories;
    let selection: HybridMemorySelectionSummary | undefined;
    if (strategy === "newest_hybrid") {
      const clampedNewestLimit = Math.min(newestLimit, maxMemories);
      const result = selectNewestHybrid({
        items: memories,
        newestLimit: clampedNewestLimit,
        interestingLimit: Math.min(interestingLimit, Math.max(0, maxMemories - clampedNewestLimit)),
        candidateLimit,
        getId: (memory) => memory.id,
        getCreatedAt: (memory) => memory.createdAt,
        scoreInteresting: (memory) => interestingMemoryScore({
          content: memory.content,
          summaryJson: memory.summaryJson,
          memoryType: memory.memoryType,
          category: memory.category,
          importance: memory.importance,
          isPinned: memory.isPinned,
        }),
      });
      selectedMemories = result.selected;
      selection = result.summary;
    } else if (memories.length > maxMemories) {
      selectedMemories = memories.slice(0, maxMemories);
    }

    const duplicateGroups = buildDuplicateGroups(selectedMemories);
    const staleCandidateIds = selectedMemories.filter((memory) => {
      const row = rows.find((candidate) => candidate.id === memory.id);
      return row ? isStaleCandidate(row, nowMs) : false;
    }).map((memory) => memory.id);
    const conflictCandidateIds = buildConflictCandidateIds(selectedMemories);
    const protectedMemoryIds = selectedMemories.filter((memory) => memory.protected).map((memory) => memory.id);
    const bucketCounts = {
      short_term: selectedMemories.filter((memory) => memory.bucket === "short_term").length,
      long_term: selectedMemories.filter((memory) => memory.bucket === "long_term").length,
      permanent: selectedMemories.filter((memory) => memory.bucket === "permanent").length,
    };

    return {
      memoryCount: selectedMemories.length,
      selectedMemoryIds: selectedMemories.map((memory) => memory.id),
      selection,
      duplicateGroups,
      staleCandidateIds,
      conflictCandidateIds,
      protectedMemoryIds,
      bucketCounts,
      memories: selectedMemories,
    };
  }
}
