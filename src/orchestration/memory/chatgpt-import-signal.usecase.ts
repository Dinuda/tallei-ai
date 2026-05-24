import { config } from "../../config/index.js";

export type CandidateDisposition = "KEEP_HIGH" | "KEEP_WEAK" | "DROP";

export interface ImportConversationMessage {
  role: "user" | "assistant";
  text: string;
  sourceDateTime: string | null;
}

export interface ImportConversation {
  id: string;
  sourceFile: string;
  sourceDateTime: string | null;
  title: string | null;
  messages: ImportConversationMessage[];
}

export interface ScoredImportConversation {
  id: string;
  sourceFile: string;
  sourceDateTime: string | null;
  title: string | null;
  textBundle: string;
  score: number;
  disposition: CandidateDisposition;
  reasons: string[];
  signalScores: {
    personal: number;
    project: number;
    preference: number;
    decision: number;
    workflow: number;
    reuse: number;
    junkPenalty: number;
    assistantDurable: number;
  };
}

export interface ClassifiedImportConversations {
  parsedConversations: number;
  parsedMessages: number;
  hardDropped: number;
  keepHigh: ScoredImportConversation[];
  keepWeak: ScoredImportConversation[];
  dropped: ScoredImportConversation[];
  warnings: string[];
}

export interface ClassifyBulkImportOptions {
  keepHighThreshold?: number;
  keepWeakThreshold?: number;
  importProfile?: "curated" | "inclusive";
}

const MIN_WORDS = 8;
const MAX_MESSAGE_CHARS = 800;
const MAX_BUNDLE_CHARS = 3_500;
const MAX_BUNDLE_MESSAGES = 18;

const SHORT_JUNK = new Set([
  "ok",
  "okay",
  "yes",
  "yep",
  "no",
  "thanks",
  "thank you",
  "continue",
  "go on",
  "next",
]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function wordCount(value: string): number {
  const compact = normalizeWhitespace(value);
  if (!compact) return 0;
  return compact.split(" ").filter(Boolean).length;
}

function isGreeting(value: string): boolean {
  return /^(hi|hello|hey|good morning|good evening|good afternoon)[!. ]*$/i.test(value);
}

function isOneOffQuestion(value: string): boolean {
  const text = value.toLowerCase();
  if (!text.endsWith("?")) return false;
  if (/\b(capital of|meaning of|what is|who is|when is|where is)\b/.test(text)) return true;
  if (/\b(weather|temperature|usd|lkr|convert|conversion|km to|c to f|f to c)\b/.test(text)) return true;
  if (/\bcalculate|calculator|equation|solve\b/.test(text)) return true;
  return false;
}

function isOneOffTroubleshooting(value: string): boolean {
  const text = value.toLowerCase();
  if (/\b(i am|i'm building|our product|my company|we use|our stack)\b/.test(text)) return false;
  return /\bhow (?:do i|can i|to)\b.*\b(open|run|install|fix|debug|start|launch)\b/.test(text)
    || /\bwhich file (?:do i|should i) open\b/.test(text)
    || /\bhow can i run it on\b/.test(text);
}

function isRewriteRequest(value: string): boolean {
  const text = value.toLowerCase();
  return /\b(make this shorter|rewrite this|rephrase this|improve grammar|correct grammar|translate this)\b/.test(text);
}

function isCodeOnly(text: string): boolean {
  const lower = text.toLowerCase();
  if (/^\s*```/.test(text)) return true;
  if (/^\s*(import|export|const|let|var|function|class|interface|type)\b/.test(lower)) return true;
  if (/\b(enoent|traceback|stack trace|error:|exception)\b/.test(lower)) return true;
  if (/\b(select|from|join|where|insert into|create table|alter table)\b/.test(lower)) return true;
  const symbols = (text.match(/[{}[\];()<>]/g) ?? []).length;
  const letters = (text.match(/[a-z]/gi) ?? []).length;
  return symbols >= 6 && letters > 0 && symbols / (symbols + letters) > 0.3;
}

function isBarePackageError(text: string): boolean {
  const lower = text.toLowerCase();
  if (hasDurableCodeContext(text)) return false;
  return /\bexternally-managed-environment\b/.test(lower)
    || /\bpip install\b/.test(lower)
    || /\bcommand not found\b/.test(lower)
    || (/\berror:/.test(lower) && wordCount(text) < 20);
}

function hasDurableCodeContext(text: string): boolean {
  return /\b(our stack|we use|architecture|system design|project|product|company|decision|we decided)\b/i.test(text);
}

function isAssistantPersonaContent(text: string): boolean {
  const lower = text.toLowerCase();
  return /\bi(?:'m| am)\s+nova\b/.test(lower)
    || /\bthis is my pal\b/.test(lower)
    || /\bjourney to becoming\b/.test(lower)
    || /\bsuper cool inventor\b/.test(lower)
    || /\bwe're here to (?:help|guide)\b/.test(lower)
    || /\bguide you on your (?:incredible )?journey\b/.test(lower);
}

function isTutorialPersonaContent(text: string): boolean {
  const lower = text.toLowerCase();
  return isAssistantPersonaContent(text)
    || /\btap into your imagination\b/.test(lower)
    || /\bdiscover the wonders of science\b/.test(lower);
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hashAssistantMessage(text: string): string {
  return normalizeWhitespace(text).toLowerCase().slice(0, 500);
}

function computeSignalScores(textBundle: string, importProfile: "curated" | "inclusive" = "curated"): {
  personal: number;
  project: number;
  preference: number;
  decision: number;
  workflow: number;
  reuse: number;
  junkPenalty: number;
  assistantDurable: number;
  inclusiveBoost: number;
  reasons: string[];
} {
  const text = textBundle.toLowerCase();
  const reasons: string[] = [];

  const personalPatterns = [
    /\bi am\b/, /\bi'm\b/, /\bmy name\b/, /\bmy timezone\b/, /\bi live\b/, /\bi work\b/,
  ];
  const projectPatterns = [
    /\bi(?:'m| am) building\b/, /\bour product\b/, /\bmy company\b/, /\bwe are working on\b/, /\bwe use\b/, /\btallei\b/,
    /\bstack\b/, /\bnext\.js\b/, /\btypescript\b/, /\bpostgres\b/,
  ];
  const preferencePatterns = [
    /\bi prefer\b/, /\bfrom now on\b/, /\bdon't\b/, /\buse this tone\b/, /\bkeep responses\b/, /\bwriting style\b/,
  ];
  const decisionPatterns = [
    /\bwe decided\b/, /\bthe plan is\b/, /\bwe chose\b/, /\bdecision\b/, /\binstead of\b/,
  ];
  const workflowPatterns = [
    /\bevery week\b/, /\busually\b/, /\brecurring\b/, /\bworkflow\b/, /\bprocess\b/, /\bchecklist\b/,
  ];
  const reusePatterns = [
    /\bproject\b/, /\bcustomer\b/, /\bstack\b/, /\barchitecture\b/, /\bconstraints?\b/, /\bgoal\b/,
  ];
  const junkPatterns = [
    /\bwhat is\b/, /\bcapital of\b/, /\bconvert\b/, /\bweather\b/, /\btranslate this\b/, /\bmake this shorter\b/,
  ];
  const assistantDurablePatterns = [
    /\barchitecture\b/, /\broadmap\b/, /\bspec\b/, /\bpositioning\b/, /\bbusiness model\b/,
    /\btech stack\b/, /\bsystem design\b/, /\bproduct spec\b/, /\boutreach email\b/, /\bresume\b/,
    /\bcv\b/, /\bdeliverables\b/,
  ];
  const userConfirmedPatterns = [
    /\bsounds good\b/, /\byes use that\b/, /\blet's go with\b/, /\blooks good\b/, /\bapproved\b/,
  ];

  const personal = containsAny(text, personalPatterns) ? 1 : 0;
  const project = containsAny(text, projectPatterns) ? 1 : 0;
  const preference = containsAny(text, preferencePatterns) ? 1 : 0;
  const decision = containsAny(text, decisionPatterns) ? 1 : 0;
  const workflow = containsAny(text, workflowPatterns) ? 1 : 0;
  const reuse = containsAny(text, reusePatterns) ? 1 : 0;
  const junkPenalty = importProfile === "inclusive"
    ? 0
    : (containsAny(text, junkPatterns) ? 0.25 : 0);
  const hasAssistantDurable = containsAny(text, assistantDurablePatterns);
  const userConfirmed = containsAny(text, userConfirmedPatterns);
  let assistantDurable = hasAssistantDurable ? (userConfirmed ? 1 : 0.65) : 0;

  let inclusiveBoost = 0;
  if (importProfile === "inclusive") {
    if (/@\w+\.\w+|\binbox\b|\bgmail\b|\boutlook\b/i.test(textBundle)) {
      inclusiveBoost += 0.12;
      reasons.push("email_paste");
    }
    if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(textBundle)) {
      inclusiveBoost += 0.1;
      reasons.push("collab_ref");
    }
    if (/\bmcp tool\b|\bcollab_\w+\b|\bcontinue task\b/i.test(textBundle)) {
      inclusiveBoost += 0.08;
      reasons.push("collab_command");
    }
    if (/[├└│]/.test(textBundle)) {
      inclusiveBoost += 0.06;
      reasons.push("ascii_tree");
    }
    if (/\bcreate \d+ (images|photos|videos)\b/i.test(textBundle)) {
      inclusiveBoost += 0.08;
      reasons.push("task_prompt");
    }
    if (hasAssistantDurable) {
      assistantDurable = Math.max(assistantDurable, 0.75);
    }
  }

  if (personal) reasons.push("personal");
  if (project) reasons.push("project");
  if (preference) reasons.push("preference");
  if (decision) reasons.push("decision");
  if (workflow) reasons.push("workflow");
  if (reuse) reasons.push("reuse");
  if (assistantDurable > 0) reasons.push("assistant_durable");
  if (junkPenalty > 0) reasons.push("junk_penalty");

  return {
    personal,
    project,
    preference,
    decision,
    workflow,
    reuse,
    junkPenalty,
    assistantDurable,
    inclusiveBoost,
    reasons,
  };
}

function scoreConversation(
  textBundle: string,
  title: string | null,
  importProfile: "curated" | "inclusive" = "curated"
): {
  score: number;
  reasons: string[];
  signalScores: {
    personal: number;
    project: number;
    preference: number;
    decision: number;
    workflow: number;
    reuse: number;
    junkPenalty: number;
    assistantDurable: number;
  };
} {
  const signal = computeSignalScores(textBundle, importProfile);
  let titleBoost = 0;
  if (title) {
    const titleLower = title.toLowerCase();
    if (/\b(project|product|startup|architecture|roadmap|tallei|stack)\b/.test(titleLower)) {
      titleBoost = 0.08;
      signal.reasons.push("title_signal");
    }
  }

  let score = clamp(
    signal.personal * 0.22
      + signal.project * 0.24
      + signal.preference * 0.2
      + signal.decision * 0.14
      + signal.workflow * 0.1
      + signal.reuse * 0.1
      + signal.assistantDurable * 0.22
      + titleBoost
      + (signal.inclusiveBoost ?? 0)
      - signal.junkPenalty,
    0,
    1
  );

  if (signal.personal > 0 && signal.project > 0) {
    score = clamp(score + 0.12, 0, 1);
    signal.reasons.push("personal_project_combo");
  }
  if (signal.preference > 0 && /\bi prefer\b/.test(textBundle.toLowerCase())) {
    score = clamp(score + 0.28, 0, 1);
    signal.reasons.push("explicit_preference");
  }
  if (/\bwe use\b/.test(textBundle.toLowerCase()) && /\bstack\b/.test(textBundle.toLowerCase())) {
    score = clamp(score + 0.16, 0, 1);
    signal.reasons.push("stack_fact");
  }
  if (signal.assistantDurable >= 0.65 && /\b(sounds good|let's go with|approved|looks good)\b/i.test(textBundle)) {
    score = clamp(score + 0.28, 0, 1);
    signal.reasons.push("confirmed_assistant_plan");
  }

  return {
    score,
    reasons: signal.reasons,
    signalScores: {
      personal: signal.personal,
      project: signal.project,
      preference: signal.preference,
      decision: signal.decision,
      workflow: signal.workflow,
      reuse: signal.reuse,
      junkPenalty: signal.junkPenalty,
      assistantDurable: signal.assistantDurable,
    },
  };
}

function hardDropMessage(
  message: ImportConversationMessage,
  importProfile: "curated" | "inclusive" = "curated"
): boolean {
  const text = normalizeWhitespace(message.text);
  if (!text) return true;
  if (SHORT_JUNK.has(text.toLowerCase())) return true;
  if (isGreeting(text)) return true;
  if (importProfile === "inclusive") return false;

  if (wordCount(text) < MIN_WORDS) return true;
  if (isOneOffQuestion(text)) return true;
  if (isOneOffTroubleshooting(text)) return true;
  if (isBarePackageError(text)) return true;
  if (isTutorialPersonaContent(text)) return true;
  if (isRewriteRequest(text) && !/\b(i prefer|from now on|use this tone|writing style)\b/i.test(text)) return true;
  if (isCodeOnly(text) && !hasDurableCodeContext(text)) return true;
  if (message.role === "assistant" && isAssistantPersonaContent(text)) return true;
  return false;
}

function buildBundle(messages: ImportConversationMessage[]): string {
  const selected: string[] = [];
  let chars = 0;
  for (const message of messages) {
    const normalized = normalizeWhitespace(message.text).slice(0, MAX_MESSAGE_CHARS);
    if (!normalized) continue;
    const prefixed = `${message.role.toUpperCase()}: ${normalized}`;
    if (selected.length >= MAX_BUNDLE_MESSAGES) break;
    if (chars + prefixed.length > MAX_BUNDLE_CHARS) break;
    selected.push(prefixed);
    chars += prefixed.length + 1;
  }
  return selected.join("\n");
}

export function classifyBulkImportCandidates(
  conversations: ImportConversation[],
  options?: ClassifyBulkImportOptions
): ClassifiedImportConversations {
  const keepHighThreshold = options?.keepHighThreshold ?? config.importKeepHighThreshold;
  const keepWeakThreshold = options?.keepWeakThreshold ?? config.importKeepWeakThreshold;
  const importProfile = options?.importProfile ?? "curated";
  const isInclusive = importProfile === "inclusive";

  const warnings: string[] = [];
  const keepHigh: ScoredImportConversation[] = [];
  const keepWeak: ScoredImportConversation[] = [];
  const dropped: ScoredImportConversation[] = [];

  let parsedMessages = 0;
  let hardDropped = 0;
  const seenAssistantHashes = new Set<string>();

  for (const conversation of conversations) {
    parsedMessages += conversation.messages.length;
    const filteredMessages = conversation.messages.filter((message) => {
      if (!isInclusive && message.role === "assistant") {
        const hash = hashAssistantMessage(message.text);
        if (seenAssistantHashes.has(hash)) {
          hardDropped += 1;
          return false;
        }
        seenAssistantHashes.add(hash);
      }
      const drop = hardDropMessage(message, importProfile);
      if (drop) hardDropped += 1;
      return !drop;
    });

    const bundle = buildBundle(filteredMessages);
    const scored = scoreConversation(bundle, conversation.title, importProfile);
    const scoredRow: ScoredImportConversation = {
      id: conversation.id,
      sourceFile: conversation.sourceFile,
      sourceDateTime: conversation.sourceDateTime,
      title: conversation.title,
      textBundle: bundle,
      score: scored.score,
      disposition: "DROP",
      reasons: scored.reasons,
      signalScores: scored.signalScores,
    };

    if (!bundle) {
      dropped.push(scoredRow);
      continue;
    }

    if (scored.score >= keepHighThreshold) {
      scoredRow.disposition = "KEEP_HIGH";
      keepHigh.push(scoredRow);
    } else if (scored.score >= keepWeakThreshold) {
      scoredRow.disposition = "KEEP_WEAK";
      keepWeak.push(scoredRow);
    } else {
      scoredRow.disposition = "DROP";
      dropped.push(scoredRow);
    }
  }

  if (keepHigh.length === 0) {
    warnings.push("No high-signal conversations found after deterministic filtering.");
  }

  warnings.push(
    `Filtered ${conversations.length} conversation(s): KEEP_HIGH=${keepHigh.length}, KEEP_WEAK=${keepWeak.length}, DROP=${dropped.length}, hard-dropped messages=${hardDropped}.`
  );

  return {
    parsedConversations: conversations.length,
    parsedMessages,
    hardDropped,
    keepHigh,
    keepWeak,
    dropped,
    warnings,
  };
}

function bundleToImportConversation(bundle: {
  id: string;
  sourceFile: string;
  sourceDateTime: string | null;
  title: string | null;
  messages: ImportConversationMessage[];
}): ImportConversation {
  return {
    id: bundle.id,
    sourceFile: bundle.sourceFile,
    sourceDateTime: bundle.sourceDateTime,
    title: bundle.title,
    messages: bundle.messages,
  };
}

export function bundlesToImportConversations(
  bundles: Array<{
    id: string;
    sourceFile: string;
    sourceDateTime: string | null;
    title: string | null;
    messages: ImportConversationMessage[];
  }>
): ImportConversation[] {
  return bundles.map(bundleToImportConversation);
}
