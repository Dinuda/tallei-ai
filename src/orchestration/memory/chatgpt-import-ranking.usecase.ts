export interface ImportRankCandidate {
  index: number;
  raw: string;
  sourceDateTime: string | null;
  sourceFile: string | null;
}

export interface ImportRankDecision {
  index: number;
  rankScore: number;
  durabilityScore: number;
  recencyScore: number;
  conversationSignal: number;
}

export interface ImportRankSelection {
  selectedIndices: number[];
  decisions: ImportRankDecision[];
  selectedCount: number;
  skippedCount: number;
  warnings: string[];
}

const DEFAULT_SELECTION_RATIO = 0.3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseDateMs(value: string | null): number | null {
  if (!value) return null;
  const date = new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function recencyScore(sourceDateTime: string | null): number {
  const ms = parseDateMs(sourceDateTime);
  if (ms === null) return 0.5;
  const ageDays = Math.max(0, (Date.now() - ms) / 86_400_000);
  return clamp(1 / (1 + ageDays / 180), 0, 1);
}

function looksTransientCodeLike(raw: string): boolean {
  const line = raw.toLowerCase();
  if (/^\s*(import|export|const|let|var|function|class|interface|type)\b/.test(line)) return true;
  if (/\b(select|from|join|where|insert into|update|delete from|create table|alter table)\b/.test(line)) return true;
  if (/\b(stack trace|error:|enoent|ts\(\d+\))\b/.test(line)) return true;
  if (/(?:\b[\w.-]+:\s+){3,}/.test(line)) return true;
  if (/[{}[\];()<>]/.test(line) && /(=>|::|\.|\bnull\b|\bundefined\b)/.test(line)) return true;
  return false;
}

function durabilityScore(raw: string): number {
  const text = normalizeWhitespace(raw).toLowerCase();
  let score = 0.5;
  if (looksTransientCodeLike(text)) score -= 0.35;
  if (/^(can you|please|write|create|make|fix|improve|convert|rephrase)\b/.test(text)) score -= 0.15;
  if (/\b(grammar|gramatically|rewrite|rephrase|caption|description)\b/.test(text)) score -= 0.1;
  if (/\b(i prefer|my timezone|my name|i am|i'm|i work|my goal|my mission)\b/.test(text)) score += 0.25;
  if (/\b(project|startup|team|company|product|platform)\b/.test(text)) score += 0.08;
  if (text.length > 650) score -= 0.1;
  if (text.length >= 18 && text.length <= 220) score += 0.05;
  return clamp(score, 0, 1);
}

function conversationSignal(raw: string): number {
  const text = normalizeWhitespace(raw).toLowerCase();
  let signal = 0.2;
  if (/^(i|my)\b/.test(text)) signal += 0.25;
  if (/\b(always|usually|often|every|weekly|daily|monthly)\b/.test(text)) signal += 0.2;
  if (/\b(prefer|need|want|constraint|deadline|goal)\b/.test(text)) signal += 0.2;
  if (looksTransientCodeLike(text)) signal -= 0.2;
  return clamp(signal, 0, 1);
}

function buildSelectedCount(total: number, ratio: number): number {
  if (total <= 0) return 0;
  const normalizedRatio = clamp(ratio, 0.01, 1);
  const selected = Math.floor(total * normalizedRatio);
  return Math.max(1, Math.min(total, selected));
}

export function selectTopImportCandidates(
  candidates: ImportRankCandidate[],
  ratio = DEFAULT_SELECTION_RATIO
): ImportRankSelection {
  if (candidates.length === 0) {
    return { selectedIndices: [], decisions: [], selectedCount: 0, skippedCount: 0, warnings: [] };
  }

  const ranked = candidates
    .map((candidate) => {
      const d = durabilityScore(candidate.raw);
      const r = recencyScore(candidate.sourceDateTime);
      const c = conversationSignal(candidate.raw);
      return {
        index: candidate.index,
        durabilityScore: d,
        recencyScore: r,
        conversationSignal: c,
        rankScore: Number((d * 0.65 + r * 0.25 + c * 0.1).toFixed(6)),
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore || a.index - b.index);

  const selectedCount = buildSelectedCount(ranked.length, ratio);
  const selected = ranked.slice(0, selectedCount).map((entry) => entry.index);
  const skippedCount = ranked.length - selectedCount;
  const warnings = [
    `Selected top ${selectedCount}/${ranked.length} candidate(s) (${Math.round(clamp(ratio, 0.01, 1) * 100)}%) with deterministic ranking.`,
  ];

  return {
    selectedIndices: selected,
    decisions: ranked,
    selectedCount,
    skippedCount,
    warnings,
  };
}
