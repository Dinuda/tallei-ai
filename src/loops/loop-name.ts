const FILLER_PREFIX =
  /^(please\s+)?(i\s+(want\s+to|need\s+to|would\s+like\s+to)\s+)?((create|build|make)\s+(a\s+)?(weekly\s+)?(loop\s+(that\s+|to\s+)?)?)?/i;

const LEADING_NOISE =
  /^(automatically\s+|when\s+(a|an|the|new|incoming)\s+|every\s+(morning|day|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+)/i;

const TRAILING_NOISE =
  /\b(for|after|before)\s+(my\s+)?review\b.*$|\bbefore anything is sent\b.*$|\bevery\s+monday morning\b.*$/i;

const PROCEDURAL_VERBS =
  /^(classify|draft|send|summarize|extract|post|monitor|read|create|generate|fetch|watch|email|flag|route|assign|reply|respond|triage|prioritize|follow up|outreach|compile|review|deliver|notify|sync|update|check|scrape|parse|analyze|process|personalize|research)\b/i;

type DomainRule = {
  pattern: RegExp;
  classify: RegExp;
  replies: RegExp;
  digest: RegExp;
  followUp: RegExp;
  classifyLabel: string;
  repliesLabel: string;
  digestLabel: string;
  followUpLabel: string;
};

const DOMAIN_RULES: DomainRule[] = [
  {
    pattern: /\b(support tickets?|support inbox|customer tickets?)\b/i,
    classify: /\b(classify|triage|priorit)/i,
    replies: /\b(draft|reply|replies|respond|auto-?reply)/i,
    digest: /\b(digest|summar)/i,
    followUp: /\bfollow.?up\b/i,
    classifyLabel: "Support ticket helper",
    repliesLabel: "Support ticket replies",
    digestLabel: "Support digest",
    followUpLabel: "Support follow-up",
  },
  {
    pattern: /\b(leads?)\b/i,
    classify: /\b(classify|triage|priorit|score)/i,
    replies: /\b(draft|reply|replies|respond|outreach|email)/i,
    digest: /\b(digest|summar)/i,
    followUp: /\b(follow.?up|outreach)/i,
    classifyLabel: "New lead helper",
    repliesLabel: "Lead outreach",
    digestLabel: "Lead digest",
    followUpLabel: "Lead follow-up",
  },
  {
    pattern: /\b(gmail threads?|emails?|inbox)\b/i,
    classify: /\b(classify|triage|priorit|sort|flag)/i,
    replies: /\b(draft|reply|replies|respond)/i,
    digest: /\b(digest|summar)/i,
    followUp: /\bfollow.?up\b/i,
    classifyLabel: "Inbox helper",
    repliesLabel: "Inbox replies",
    digestLabel: "Inbox digest",
    followUpLabel: "Inbox follow-up",
  },
  {
    pattern: /\b(newsletters?)\b/i,
    classify: /\b(classify|triage|priorit|curate)/i,
    replies: /\b(draft|reply|replies|respond|send)/i,
    digest: /\b(digest|summar)/i,
    followUp: /\bfollow.?up\b/i,
    classifyLabel: "Newsletter picks",
    repliesLabel: "Newsletter drafts",
    digestLabel: "Newsletter digest",
    followUpLabel: "Newsletter follow-up",
  },
];

function titleCase(value: string): string {
  return value.replace(/\b([a-z])/g, (character) => character.toUpperCase());
}

function compressProceduralName(
  text: string,
  schedule: { weekly: boolean; morning: boolean },
): string | null {
  const lower = text.toLowerCase();

  for (const rule of DOMAIN_RULES) {
    if (!rule.pattern.test(text)) continue;

    if (rule.followUp.test(lower)) return rule.followUpLabel;
    if (rule.classify.test(lower)) return rule.classifyLabel;
    if (rule.replies.test(lower)) return rule.repliesLabel;
    if (rule.digest.test(lower)) {
      if (schedule.weekly) return "Weekly team digest";
      if (schedule.morning) return "Morning inbox digest";
      return rule.digestLabel;
    }
  }

  if (/\b(digest|summar)/i.test(lower)) {
    if (schedule.weekly) return "Weekly team digest";
    if (schedule.morning) return "Morning inbox digest";
    return "Team digest";
  }

  return null;
}

function isProceduralDescription(text: string): boolean {
  const parts = text.split(/,\s*(?:and\s+)?/);
  if (parts.length < 2) return false;
  const verbStarts = parts.filter((part) => PROCEDURAL_VERBS.test(part.trim()));
  return verbStarts.length >= 2;
}

function stripMechanicalPhrasing(text: string): string {
  return text
    .replace(TRAILING_NOISE, "")
    .replace(LEADING_NOISE, "")
    .replace(/\b(incoming|personalized|context-aware|unread|new)\s+/gi, "")
    .replace(/\s+by priority\b/gi, "")
    .replace(/\s+with context-aware drafts\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Derive a short, human loop title from the user's natural-language prompt. */
export function deriveLoopNameFromPrompt(prompt: string, maxLen = 48): string {
  const raw = prompt.trim().replace(/\s+/g, " ");
  if (!raw) return "New loop";

  const firstLine = raw.split(/\n/)[0]?.trim() ?? raw;
  const sentence = firstLine.split(/(?<=[.!?])\s+/)[0]?.trim() ?? firstLine;
  let name = sentence.replace(FILLER_PREFIX, "").trim();
  if (!name) name = firstLine;

  const schedule = {
    weekly: /\b(weekly|every week|monday morning)\b/i.test(sentence),
    morning: /\b(every morning|each morning)\b/i.test(sentence),
  };

  name = stripMechanicalPhrasing(name);

  let usedPresetLabel = false;
  const compressed = compressProceduralName(name, schedule);
  if (isProceduralDescription(name)) {
    if (compressed) {
      name = compressed;
      usedPresetLabel = true;
    }
  } else if (compressed && name.length > compressed.length + 8) {
    name = compressed;
    usedPresetLabel = true;
  }

  if (name.length > maxLen) {
    const truncated = name.slice(0, maxLen);
    const lastSpace = truncated.lastIndexOf(" ");
    name = (lastSpace > 16 ? truncated.slice(0, lastSpace) : truncated).trim();
  }

  name = name.replace(/[.!?,:;]+$/, "").trim();
  if (!name) return "New loop";
  return usedPresetLabel ? name : titleCase(name);
}
