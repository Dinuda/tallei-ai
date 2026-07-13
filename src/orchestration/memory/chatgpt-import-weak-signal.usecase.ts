import type {
  ClassifiedImportConversations,
  ScoredImportConversation,
} from "./chatgpt-import-signal.usecase.js";

const WEAK_SIGNAL_MIN_OCCURRENCES = 3;

const REWRITE_STYLE_PATTERNS: Array<{ key: string; pattern: RegExp; memory: string }> = [
  {
    key: "shorter",
    pattern: /\bmake (?:this |it )?shorter\b/i,
    memory: "User repeatedly asks for shorter, more concise rewrites.",
  },
  {
    key: "rewrite",
    pattern: /\b(?:rewrite|rephrase) this\b/i,
    memory: "User frequently requests rewrites and rephrasing of content.",
  },
  {
    key: "concise",
    pattern: /\b(?:more )?concise\b/i,
    memory: "User prefers concise writing and repeatedly asks for tighter copy.",
  },
  {
    key: "founder_style",
    pattern: /\bfounder[- ]style\b/i,
    memory: "User prefers founder-style writing for product and startup copy.",
  },
];

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function countPatternMatches(text: string, pattern: RegExp): number {
  return pattern.test(normalizeWhitespace(text)) ? 1 : 0;
}

export function promoteWeakSignals(
  classified: ClassifiedImportConversations
): ClassifiedImportConversations {
  const scanRows = [...classified.keepWeak, ...classified.dropped];
  const counts = new Map<string, number>();

  for (const row of scanRows) {
    for (const entry of REWRITE_STYLE_PATTERNS) {
      const hits = countPatternMatches(row.textBundle, entry.pattern);
      if (hits > 0) {
        counts.set(entry.key, (counts.get(entry.key) ?? 0) + hits);
      }
    }
  }

  const promoted: ScoredImportConversation[] = [];
  const warnings = [...classified.warnings];

  for (const entry of REWRITE_STYLE_PATTERNS) {
    const count = counts.get(entry.key) ?? 0;
    if (count < WEAK_SIGNAL_MIN_OCCURRENCES) continue;

    promoted.push({
      id: `weak-signal:${entry.key}`,
      sourceFile: "weak-signal-aggregation",
      sourceDateTime: null,
      title: "Aggregated style preference",
      textBundle: `USER: ${entry.memory}`,
      score: 0.6,
      disposition: "KEEP_HIGH",
      reasons: ["weak_signal_promoted", entry.key],
      signalScores: {
        personal: 0,
        project: 0,
        preference: 1,
        decision: 0,
        workflow: 0,
        reuse: 0,
        junkPenalty: 0,
        assistantDurable: 0,
      },
    });
    warnings.push(
      `Promoted weak style signal "${entry.key}" after ${count} occurrences across archive.`
    );
  }

  if (promoted.length === 0) {
    return classified;
  }

  return {
    ...classified,
    keepHigh: [...classified.keepHigh, ...promoted],
    warnings,
  };
}
