import type { MemoryRecordRow } from "../../infrastructure/repositories/memory.repository.js";
import type { CleanupBucket } from "./types.js";

const PERMANENT_CATEGORIES = new Set([
  "identity",
  "auth",
  "billing",
  "security",
  "legal",
  "payment",
  "credentials",
  "account",
]);

function readSummaryBucket(summaryJson: unknown): CleanupBucket | null {
  if (!summaryJson || typeof summaryJson !== "object" || Array.isArray(summaryJson)) return null;
  const value = (summaryJson as Record<string, unknown>).cleanup_bucket;
  return value === "short_term" || value === "long_term" || value === "permanent" ? value : null;
}

function daysSince(value: string | null | undefined, nowMs: number): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (nowMs - time) / 86_400_000;
}

function containsTransientContext(content: string): boolean {
  return /\b(today|tomorrow|yesterday|this week|last week|debug|error|bug|triage|todo|reminder|temporary|meeting|incident)\b/i.test(content);
}

export function classifyCleanupBucket(input: {
  row: MemoryRecordRow;
  content: string;
  protected: boolean;
  protectionReasons: string[];
  nowMs?: number;
}): { bucket: CleanupBucket; reason: string; confidence: number } {
  const { row, content, protected: isProtected, protectionReasons } = input;
  const nowMs = input.nowMs ?? Date.now();
  const existingBucket = readSummaryBucket(row.summary_json);

  if (row.is_pinned) {
    return { bucket: "permanent", reason: "Pinned memory should never decay.", confidence: 0.99 };
  }
  if (row.memory_type === "preference") {
    return { bucket: "permanent", reason: "User preference is durable profile memory.", confidence: 0.98 };
  }
  if (row.category && PERMANENT_CATEGORIES.has(row.category.toLowerCase())) {
    return { bucket: "permanent", reason: `Protected ${row.category.toLowerCase()} category.`, confidence: 0.98 };
  }
  if (isProtected) {
    return {
      bucket: "permanent",
      reason: `Protected content pattern: ${protectionReasons.join(", ")}.`,
      confidence: 0.96,
    };
  }

  const activityDays = Math.min(
    daysSince(row.last_referenced_at, nowMs),
    daysSince(row.created_at, nowMs)
  );

  if (row.memory_type === "event" || row.memory_type === "note") {
    const confidence = row.reference_count <= 2 || activityDays >= 14 ? 0.94 : 0.86;
    return {
      bucket: "short_term",
      reason: `${row.memory_type} memory is transient and should decay quickly.`,
      confidence,
    };
  }

  if (containsTransientContext(content) && row.reference_count <= 2) {
    return {
      bucket: "short_term",
      reason: "Low-reference operational or debugging context.",
      confidence: 0.86,
    };
  }

  if (row.memory_type === "fact" || row.memory_type === "decision" || row.memory_type === "checkpoint") {
    return {
      bucket: "long_term",
      reason: `${row.memory_type} memory is durable working context.`,
      confidence: existingBucket === "long_term" ? 0.96 : 0.9,
    };
  }

  return {
    bucket: "long_term",
    reason: "Default durable bucket for non-transient, non-protected memory.",
    confidence: existingBucket === "long_term" ? 0.94 : 0.82,
  };
}
