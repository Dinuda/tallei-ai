export type MemorySelectionStrategy = "current_priority" | "newest_hybrid";

export interface HybridMemorySelectionSummary {
  considered: number;
  selected: number;
  newestSelected: number;
  interestingSelected: number;
  candidateLimit: number;
  truncated: boolean;
}

export interface InterestingMemoryInput {
  content?: string;
  contentSummary?: string;
  summaryJson?: unknown;
  memoryType?: string | null;
  detectedMemoryType?: string | null;
  category?: string | null;
  importance?: string | number | null;
  isPinned?: boolean;
  sourceImport?: boolean;
}

const ACTION_MEMORY_CUES = [
  "workflow",
  "recurring",
  "routine",
  "checklist",
  "review",
  "write",
  "writing",
  "draft",
  "send",
  "launch",
  "analytics",
  "customer",
  "proposal",
  "changelog",
  "release notes",
  "newsletter",
  "report",
  "brief",
  "deck",
  "slides",
  "email",
  "follow up",
  "follow-up",
  "every week",
  "weekly",
  "daily",
  "monthly",
];

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function metadataText(value: unknown): string {
  const record = readRecord(value);
  if (Object.keys(record).length === 0) return "";
  return JSON.stringify(record).toLowerCase();
}

export function interestingMemoryScore(input: InterestingMemoryInput): number {
  const summary = readRecord(input.summaryJson);
  const memoryType = (input.memoryType ?? "").toLowerCase();
  const detectedMemoryType = (input.detectedMemoryType ?? String(summary.import_detected_memory_type ?? "")).toLowerCase();
  const category = (input.category ?? "").toLowerCase();
  const sourceImport = input.sourceImport === true || readBoolean(summary.source_import);
  const text = [
    input.content ?? "",
    input.contentSummary ?? "",
    memoryType,
    detectedMemoryType,
    category,
    metadataText(summary),
  ].join("\n").toLowerCase();

  let score = 0;
  if (sourceImport) score += 6;
  if (input.isPinned) score += 2;
  if (category.includes("workflow")) score += 6;
  if (detectedMemoryType === "workflow") score += 6;
  if (memoryType === "decision") score += 5;
  if (memoryType === "preference") score += 4;
  if (memoryType === "fact") score += 2;
  score += Math.max(0, Math.min(1, numeric(input.importance))) * 4;

  for (const cue of ACTION_MEMORY_CUES) {
    if (text.includes(cue)) score += 2;
  }
  return score;
}

export function selectNewestHybrid<T>(input: {
  items: T[];
  newestLimit: number;
  interestingLimit: number;
  candidateLimit?: number;
  getId(item: T): string;
  getCreatedAt(item: T): string;
  scoreInteresting(item: T): number;
  minInterestingScore?: number;
}): { selected: T[]; summary: HybridMemorySelectionSummary } {
  const newestLimit = Math.max(0, input.newestLimit);
  const interestingLimit = Math.max(0, input.interestingLimit);
  const maxTotal = newestLimit + interestingLimit;
  const candidateLimit = input.candidateLimit ?? input.items.length;
  const minInterestingScore = input.minInterestingScore ?? 1;
  const sortedNewest = [...input.items].sort((left, right) => {
    const byDate = Date.parse(input.getCreatedAt(right)) - Date.parse(input.getCreatedAt(left));
    return byDate !== 0 ? byDate : input.getId(left).localeCompare(input.getId(right));
  });

  if (sortedNewest.length <= newestLimit || interestingLimit === 0) {
    const selected = sortedNewest.slice(0, maxTotal || newestLimit);
    return {
      selected,
      summary: {
        considered: input.items.length,
        selected: selected.length,
        newestSelected: selected.length,
        interestingSelected: 0,
        candidateLimit,
        truncated: input.items.length > selected.length,
      },
    };
  }

  const newest = sortedNewest.slice(0, newestLimit);
  const selectedIds = new Set(newest.map(input.getId));
  const interesting = sortedNewest
    .slice(newestLimit)
    .map((item) => ({ item, score: input.scoreInteresting(item) }))
    .filter((entry) => entry.score >= minInterestingScore)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const byDate = Date.parse(input.getCreatedAt(right.item)) - Date.parse(input.getCreatedAt(left.item));
      return byDate !== 0 ? byDate : input.getId(left.item).localeCompare(input.getId(right.item));
    })
    .map((entry) => entry.item)
    .filter((item) => {
      const id = input.getId(item);
      if (selectedIds.has(id)) return false;
      selectedIds.add(id);
      return true;
    })
    .slice(0, interestingLimit);

  const selected = [...newest, ...interesting].slice(0, maxTotal);
  return {
    selected,
    summary: {
      considered: input.items.length,
      selected: selected.length,
      newestSelected: newest.length,
      interestingSelected: interesting.length,
      candidateLimit,
      truncated: input.items.length > selected.length,
    },
  };
}
