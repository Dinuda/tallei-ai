import { normalizeMemoryType, type MemoryType } from "./memory-types.js";

export interface MemoryClassificationModelSuggestion {
  memory_type?: unknown;
  category?: unknown;
  is_pinned_suggested?: unknown;
}

export interface MemoryClassificationDecision {
  memoryType: MemoryType;
  category: string | null;
  isPinned: boolean;
  preferenceKey: string | null;
  isIdentityFact: boolean;
}

const PREFERENCE_PATTERNS: RegExp[] = [
  /\b(i\s+prefer|i\s+like|i\s+love|i\s+hate|my\s+favou?rite)\b/i,
  /\bpreferred\b/i,
  /\balways\s+use\b/i,
];

const IDENTITY_PATTERNS: Array<{ key: string; pattern: RegExp }> = [
  { key: "identity_name", pattern: /\b(my\s+name\s+is|i\s+am\s+called)\b/i },
  { key: "identity_email", pattern: /\bmy\s+email\s+is\b/i },
  { key: "identity_phone", pattern: /\b(my\s+phone|my\s+number)\b/i },
  { key: "identity_location", pattern: /\b(i\s+live\s+in|i\s+am\s+from|my\s+city\s+is)\b/i },
  { key: "identity_timezone", pattern: /\b(my\s+time\s*zone|my\s+timezone)\b/i },
  { key: "identity_pronouns", pattern: /\bmy\s+pronouns\s+are\b/i },
];

const LESSON_PATTERNS: RegExp[] = [
  /\b(best\s+practice|rule\s+of\s+thumb|always\s+remember|never\s+do|learned\s+that|key\s+takeaway|takeaway)\b/i,
  /\bshould\s+(always|never)\b/i,
  /\bdo\s+not\s+(ever|batch|deploy|run|use)\b/i,
];

const FAILURE_PATTERNS: RegExp[] = [
  /\b(broke|crashed|outage|incident|regression|timeout|encoding\s+mismatch|root\s+cause|postmortem)\b/i,
  /\b(deploy\s+(broke|failed)|build\s+broke|api\s+timeout|caused\s+by)\b/i,
];

const CATEGORY_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: "identity", pattern: /\b(my\s+name\s+is|i\s+am\s+called|my\s+email\s+is|my\s+pronouns\s+are)\b/i },
  { category: "stack", pattern: /\b(tech\s+stack|stack|next\.js|typescript|postgres|qdrant|react|node)\b/i },
  { category: "ui", pattern: /\b(ui|ux|design|theme|color|layout|style|typography)\b/i },
  { category: "contact", pattern: /\b(email|phone|number|contact)\b/i },
  { category: "location", pattern: /\b(city|country|timezone|time\s*zone|location|from|live\s+in)\b/i },
  { category: "project", pattern: /\b(project|building|roadmap|milestone|launch)\b/i },
];

function normalizeCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 64);
  return normalized.length > 0 ? normalized : null;
}

function inferCategory(text: string): string | null {
  for (const candidate of CATEGORY_PATTERNS) {
    if (candidate.pattern.test(text)) return candidate.category;
  }
  return null;
}

function isPreferenceLike(text: string): boolean {
  return PREFERENCE_PATTERNS.some((pattern) => pattern.test(text));
}

function identityKeyFromText(text: string): string | null {
  for (const candidate of IDENTITY_PATTERNS) {
    if (candidate.pattern.test(text)) return candidate.key;
  }
  return null;
}

function inferHeuristicType(text: string, hasIdentity: boolean, hasPreference: boolean): MemoryType {
  if (hasIdentity || hasPreference) return "preference";
  if (/\b(decide|decided|decision|agreed|chose|chosen|will\s+use)\b/i.test(text)) return "decision";
  if (/\b(yesterday|today|tomorrow|last\s+week|last\s+month|met|meeting|event|happened)\b/i.test(text)) {
    return "event";
  }
  if (/\b(note|reminder|todo|to\s*do|scratch|idea)\b/i.test(text)) return "note";
  if (FAILURE_PATTERNS.some((p) => p.test(text))) return "failure";
  if (LESSON_PATTERNS.some((p) => p.test(text))) return "lesson";
  return "fact";
}

function inferPreferenceKey(text: string, category: string | null, identityKey: string | null): string | null {
  if (identityKey) return identityKey;

  const favoriteMatch = text.match(/\bmy\s+favou?rite\s+([a-z0-9\s\-_]{2,40})\s+is\b/i);
  if (favoriteMatch?.[1]) {
    const topic = favoriteMatch[1]
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 40);
    if (topic.length > 0) return `favorite_${topic}`;
  }

  if (/\bi\s+prefer\b/i.test(text)) {
    if (category) return `preference_${category}`;
    return "preference_general";
  }

  return category ? `preference_${category}` : null;
}

export function classifyMemory(
  content: string,
  modelSuggestion?: MemoryClassificationModelSuggestion | null
): MemoryClassificationDecision {
  const normalizedText = content.trim();
  const identityKey = identityKeyFromText(normalizedText);
  const hasIdentity = identityKey !== null;
  const hasPreference = isPreferenceLike(normalizedText);

  const heuristicType = inferHeuristicType(normalizedText, hasIdentity, hasPreference);
  const suggestedType = normalizeMemoryType(modelSuggestion?.memory_type, heuristicType);

  let memoryType: MemoryType = suggestedType;
  if (hasIdentity || hasPreference) {
    memoryType = "preference";
  }

  const modelCategory = normalizeCategory(modelSuggestion?.category);
  const heuristicCategory = hasIdentity ? "identity" : inferCategory(normalizedText);
  const category = modelCategory ?? heuristicCategory;

  const preferenceKey = memoryType === "preference"
    ? inferPreferenceKey(normalizedText, category, identityKey)
    : null;

  const isPinned =
    memoryType === "preference" ||
    hasIdentity ||
    Boolean(modelSuggestion?.is_pinned_suggested);

  return {
    memoryType,
    category,
    isPinned,
    preferenceKey,
    isIdentityFact: hasIdentity,
  };
}
