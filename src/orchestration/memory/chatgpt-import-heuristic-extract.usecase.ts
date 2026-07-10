import { classifyMemory } from "./memory-classification.js";
import type { ExtractedImportMemory, ExtractedImportMemoryType, ExtractHighSignalMemoriesOptions, ExtractHighSignalMemoriesResult } from "./chatgpt-import-extract.usecase.js";
import type { ScoredImportConversation } from "./chatgpt-import-signal.usecase.js";

const MIN_MEMORY_CHARS = 20;
const MAX_MEMORY_CHARS = 420;
const MAX_MEMORIES_PER_CONVERSATION_CURATED = 3;
const MAX_MEMORIES_PER_CONVERSATION_INCLUSIVE = 8;

const USER_LINE_PREFIX = /^USER:\s*/i;
const ASSISTANT_LINE_PREFIX = /^ASSISTANT:\s*/i;

const MEMORY_LINE_PATTERNS: Array<{ type: ExtractedImportMemoryType; pattern: RegExp }> = [
  { type: "identity", pattern: /\b(i am|i'm|my name is|my email|my timezone|i live in|i work at)\b/i },
  { type: "preference", pattern: /\b(i prefer|from now on|writing style|keep responses|use this tone)\b/i },
  { type: "project", pattern: /\b(i'm building|i am building|our product|my company|we are working on)\b/i },
  { type: "technical", pattern: /\b(we use|our stack|architecture|tech stack|postgres|typescript|next\.js)\b/i },
  { type: "decision", pattern: /\b(we decided|the plan is|we chose|instead of)\b/i },
  { type: "workflow", pattern: /\b(every week|recurring|workflow|checklist|usually i)\b/i },
  { type: "company", pattern: /\b(our company|our startup|our team|our customer)\b/i },
];

const USER_CONFIRMED = /\b(sounds good|yes use that|let's go with|looks good|approved)\b/i;
const ASSISTANT_DURABLE = /\b(architecture|roadmap|spec|positioning|business model|tech stack|system design)\b/i;
const EMAIL_PASTE = /@\w+\.\w+|\binbox\b|\bgmail\b|\boutlook\b/i;
const TASK_COMMAND = /\bmcp tool\b|\bcontinue task\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const TASK_PROMPT = /\bcreate \d+ (images|photos|videos)\b/i;

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseBundleMessages(textBundle: string): Array<{ role: "user" | "assistant"; text: string }> {
  const rows: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const line of textBundle.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (USER_LINE_PREFIX.test(trimmed)) {
      rows.push({ role: "user", text: normalizeWhitespace(trimmed.replace(USER_LINE_PREFIX, "")) });
      continue;
    }
    if (ASSISTANT_LINE_PREFIX.test(trimmed)) {
      rows.push({ role: "assistant", text: normalizeWhitespace(trimmed.replace(ASSISTANT_LINE_PREFIX, "")) });
    }
  }
  return rows;
}

function inferExtractType(text: string): ExtractedImportMemoryType {
  const ordered: Array<{ type: ExtractedImportMemoryType; pattern: RegExp }> = [
    { type: "project", pattern: /\b(i'm building|i am building|our product|my company|we are working on)\b/i },
    { type: "preference", pattern: /\b(i prefer|from now on|writing style|keep responses|use this tone)\b/i },
    { type: "technical", pattern: /\b(we use|our stack|architecture|tech stack|postgres|typescript|next\.js)\b/i },
    { type: "decision", pattern: /\b(we decided|the plan is|we chose|instead of)\b/i },
    { type: "workflow", pattern: /\b(every week|recurring|workflow|checklist|usually i)\b/i },
    { type: "company", pattern: /\b(our company|our startup|our team|our customer)\b/i },
    { type: "identity", pattern: /\b(i am|i'm|my name is|my email|my timezone|i live in|i work at)\b/i },
  ];
  for (const entry of ordered) {
    if (entry.pattern.test(text)) return entry.type;
  }
  const classified = classifyMemory(text);
  if (classified.memoryType === "preference") return "preference";
  if (classified.memoryType === "decision") return "decision";
  if (classified.memoryType === "lesson") return "workflow";
  if (classified.category === "stack") return "technical";
  if (classified.category === "project") return "project";
  if (classified.category === "identity") return "identity";
  return "other";
}

function scoreMemoryLine(text: string): number {
  let score = 0;
  if (MEMORY_LINE_PATTERNS.some((entry) => entry.pattern.test(text))) score += 3;
  if (/^i\b/i.test(text)) score += 1;
  if (/\bwe\b/i.test(text)) score += 1;
  if (text.length >= 40 && text.length <= 280) score += 1;
  if (text.endsWith("?")) score -= 2;
  return score;
}

function inclusiveSourceReason(message: { role: "user" | "assistant"; text: string }): string {
  if (EMAIL_PASTE.test(message.text)) return "pasted_email";
  if (TASK_COMMAND.test(message.text)) return "task_command";
  if (TASK_PROMPT.test(message.text)) return "task_prompt";
  if (message.role === "assistant") return "assistant_content";
  return "High-signal user message from filtered conversation";
}

function normalizeMemoryText(text: string): string {
  const compact = normalizeWhitespace(text).slice(0, MAX_MEMORY_CHARS);
  return compact
    .replace(/^(please remember that|remember that|note that)\s+/i, "")
    .trim();
}

function buildHeuristicMemory(
  conversation: ScoredImportConversation,
  text: string,
  sourceReason: string
): ExtractedImportMemory | null {
  const memory = normalizeMemoryText(text);
  if (memory.length < MIN_MEMORY_CHARS) return null;

  const stability = clamp(conversation.score, 0.55, 0.92);
  const reuseLikelihood = clamp(conversation.score * 0.9 + 0.08, 0.5, 0.9);

  return {
    memory,
    type: inferExtractType(memory),
    stability,
    reuseLikelihood,
    confidence: 0.72,
    sourceReason,
    sourceConversationId: conversation.id,
    sourceDateTime: conversation.sourceDateTime,
    sourceFile: conversation.sourceFile,
  };
}

function extractFromConversation(
  conversation: ScoredImportConversation,
  importProfile: "curated" | "inclusive"
): ExtractedImportMemory[] {
  const maxMemories = importProfile === "inclusive"
    ? MAX_MEMORIES_PER_CONVERSATION_INCLUSIVE
    : MAX_MEMORIES_PER_CONVERSATION_CURATED;

  if (conversation.id.startsWith("weak-signal:")) {
    const messages = parseBundleMessages(conversation.textBundle);
    const userLine = messages.find((row) => row.role === "user")?.text ?? conversation.textBundle;
    const promoted = buildHeuristicMemory(
      conversation,
      userLine,
      "Promoted from repeated weak style signals across archive"
    );
    return promoted ? [promoted] : [];
  }

  const messages = parseBundleMessages(conversation.textBundle);
  const userConfirmed = USER_CONFIRMED.test(conversation.textBundle);
  const candidates: Array<{ text: string; score: number; reason: string }> = [];

  for (const message of messages) {
    if (importProfile === "inclusive") {
      if (message.text.length >= MIN_MEMORY_CHARS) {
        candidates.push({
          text: message.text,
          score: message.role === "user" ? scoreMemoryLine(message.text) + 1 : 2,
          reason: inclusiveSourceReason(message),
        });
      }
      continue;
    }

    if (message.role === "user") {
      const score = scoreMemoryLine(message.text);
      if (score <= 0) continue;
      candidates.push({
        text: message.text,
        score,
        reason: "High-signal user message from filtered conversation",
      });
      continue;
    }

    if (userConfirmed && ASSISTANT_DURABLE.test(message.text)) {
      candidates.push({
        text: message.text,
        score: 2,
        reason: "User-confirmed assistant plan or architecture content",
      });
    }
  }

  const ranked = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMemories);

  const rows: ExtractedImportMemory[] = [];
  for (const candidate of ranked) {
    const memory = buildHeuristicMemory(conversation, candidate.text, candidate.reason);
    if (memory) rows.push(memory);
  }
  return rows;
}

export async function extractHighSignalImportMemoriesHeuristic(
  conversations: ScoredImportConversation[],
  options?: ExtractHighSignalMemoriesOptions
): Promise<ExtractHighSignalMemoriesResult> {
  if (conversations.length === 0) {
    return { extracted: [], sentToExtractor: 0, warnings: [] };
  }

  const importProfile = options?.importProfile ?? "curated";
  const extracted: ExtractedImportMemory[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const total = conversations.length;
  let completed = 0;

  for (const conversation of conversations) {
    for (const row of extractFromConversation(conversation, importProfile)) {
      const dedupeKey = row.memory.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      extracted.push(row);
    }
    completed += 1;
    await options?.onProgress?.({ completed, total });
  }

  if (extracted.length === 0) {
    warnings.push("No memory candidates promoted by heuristic extraction.");
  } else {
    warnings.push(`Promoted ${extracted.length} memory candidate(s) using rule-based extraction (no LLM).`);
  }

  return {
    extracted,
    sentToExtractor: conversations.length,
    warnings,
  };
}
