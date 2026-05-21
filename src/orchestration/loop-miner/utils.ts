import { createHash } from "crypto";

import type {
  CandidateLoop,
  CanonicalLoopFacet,
  EpisodeExtraction,
  EpisodeRecord,
  EpisodeTurnRecord,
  LoopOperationalDomain,
  LoopEvaluation,
  LoopVerdict,
  MinerEvent,
  ProjectProgressionVerdict,
  WorkspaceHistoricalRun,
  WorkspaceLoopParent,
  WorkspaceTraceOperationalDomain,
  WorkspaceTracePayload,
  WorkflowDNA,
} from "./types.js";

type SourceType = NonNullable<EpisodeExtraction["sourceDetails"]>[number]["type"];
type OutputType = NonNullable<EpisodeExtraction["output"]>["type"];
type ApprovalSignal = NonNullable<EpisodeExtraction["userBehavior"]>["approvalSignal"];
type Cadence = NonNullable<EpisodeExtraction["automationSignals"]>["likelyCadence"];

export interface CompactMinerEventOptions {
  contentSummaryCharCap: number;
}

export interface TokenPackResult<T> {
  batches: T[][];
  maxEstimatedTokensPerBatch: number;
}

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

export function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))];
}

export function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function isSourceType(value: unknown): value is SourceType {
  return value === "memory" || value === "document" || value === "conversation" || value === "integration" || value === "manual_input";
}

function isOutputType(value: unknown): value is OutputType {
  return value === "newsletter"
    || value === "email"
    || value === "summary"
    || value === "proposal"
    || value === "code"
    || value === "changelog"
    || value === "slides"
    || value === "deck"
    || value === "course_material"
    || value === "document"
    || value === "brief"
    || value === "plan"
    || value === "unknown";
}

function isApprovalSignal(value: unknown): value is ApprovalSignal {
  return value === "approved" || value === "rejected" || value === "unclear";
}

function isCadence(value: unknown): value is Cadence {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "event_based" || value === "unknown";
}

function normalizeNullableBoolean(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  return typeof value === "boolean" ? value : undefined;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimatePromptTokensFromRequest(request: { messages: readonly { content: string }[] }): number {
  return request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

export function compactMinerEvent(
  event: MinerEvent,
  options: CompactMinerEventOptions
): Pick<MinerEvent, "id" | "sourceEventType" | "createdAt" | "platform" | "role" | "contentSummary" | "metadata"> {
  const cap = Math.max(160, options.contentSummaryCharCap);
  const contentSummary = (() => {
    if (event.sourceEventType !== "collab_task") {
      return event.contentSummary.length <= cap
        ? event.contentSummary
        : `${event.contentSummary.slice(0, cap - 3)}...`;
    }
    const lines = event.contentSummary
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const highSignal = lines.filter((line) =>
      /^(title|goal|objective|task|output|artifact|result|plan|status|next step|decision|summary)\s*:/i.test(line)
      || /\b(newsletter|deck|slides?|course|series a|proposal|brief|document|plan)\b/i.test(line)
    );
    const merged = [...highSignal, ...lines.filter((line) => !highSignal.includes(line))];
    const compacted = merged.join(" | ");
    return compacted.length <= cap ? compacted : `${compacted.slice(0, cap - 3)}...`;
  })();
  const rawMetadata = readObject(event.metadata);
  const allowlistedMetadata: Record<string, unknown> = {};
  for (const key of [
    "state",
    "iteration",
    "lastActor",
    "updatedAt",
    "activityType",
    "source",
    "memoryType",
    "detectedMemoryType",
    "category",
    "sourceImport",
    "sourceDateTime",
    "cleanupBucket",
    "minerImportance",
  ]) {
    if (rawMetadata[key] !== undefined) {
      allowlistedMetadata[key] = rawMetadata[key];
    }
  }
  return {
    id: event.id,
    sourceEventType: event.sourceEventType,
    createdAt: event.createdAt,
    platform: event.platform,
    role: event.role,
    contentSummary,
    metadata: allowlistedMetadata,
  };
}

function memoryStatementFromSummary(contentSummary: string): string {
  const lines = contentSummary
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(Imported ChatGPT memory|Memory|Type:|Category:|Source datetime:)/i.test(line));
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function titleFromMemoryStatement(statement: string): string {
  const compact = statement.replace(/^I\s+/i, "");
  const title = compact.charAt(0).toUpperCase() + compact.slice(1);
  return title.length <= 82 ? title : `${title.slice(0, 79)}...`;
}

function cadenceFromMemoryStatement(statement: string): Cadence {
  const text = statement.toLowerCase();
  if (/\b(every friday|weekly|every week|each week)\b/.test(text)) return "weekly";
  if (/\b(daily|every day|each day|morning checklist|every morning|evening block|every evening)\b/.test(text)) return "daily";
  if (/\b(monthly|every month|each month)\b/.test(text)) return "monthly";
  if (/\b(after every|before writing|before planning|when planning|before scaling|before launch|sales or support conversation)\b/.test(text)) return "event_based";
  return "unknown";
}

function outputTypeFromMemoryStatement(statement: string): string {
  const text = statement.toLowerCase();
  if (/\b(changelog|release notes?)\b/.test(text)) return "changelog";
  if (/\bnewsletter\b/.test(text)) return "newsletter";
  if (/\b(email|reply|inbox)\b/.test(text)) return "email";
  if (/\bproposal|pitch deck|deck\b/.test(text)) return "proposal";
  if (/\bcode|architecture|technical\b/.test(text)) return "unknown";
  return "workflow_memory";
}

export function explicitWorkflowMemoryExtraction(event: MinerEvent): EpisodeExtraction | null {
  if (event.sourceEventType !== "memory_record") return null;
  const metadata = readObject(event.metadata);
  const sourceImport = metadata.sourceImport === true;
  const statement = memoryStatementFromSummary(event.contentSummary);
  if (!statement) return null;
  const text = statement.toLowerCase();
  const hasExplicitWorkflowSignal = /\b(every|weekly|daily|monthly|recurring|routine|workflow|morning checklist|checklist|after every|before writing|when planning|maintain a list|keep a running|decision log|failed experiments|batch .* tasks|review .* analytics|customer objections|launches?)\b/.test(text);
  const hasWorkActivitySignal = /\b(newsletter|am writing|writing a|wrote|used chatgpt|collaborated with chatgpt|brainstorm hooks|technical explanations|help structure|refine|product copy|marketing copy|product philosophy|architecture ideas)\b/.test(text);
  const isProfileOnly = /\b(founder|engineer from|focused on|lives in|based in|from sri lanka|location)\b/.test(text) && !hasExplicitWorkflowSignal && !hasWorkActivitySignal;
  if ((!hasExplicitWorkflowSignal && !hasWorkActivitySignal) || isProfileOnly) return null;

  const cadence = cadenceFromMemoryStatement(statement);
  const title = titleFromMemoryStatement(statement);
  const memoryImportance = normalizeConfidence(metadata.minerImportance ?? 0.7);
  const inferredOutputType = outputTypeFromMemoryStatement(statement);
  const outputType = inferredOutputType !== "workflow_memory"
    ? inferredOutputType
    : hasExplicitWorkflowSignal
      ? "workflow_memory"
      : inferredOutputType;
  return {
    title,
    summary: hasExplicitWorkflowSignal
      ? `Imported memory describes a recurring workflow or reusable work routine: ${statement}`
      : `Imported memory describes an AI-assisted work episode: ${statement}`,
    intent: statement,
    intentDetails: {
      label: hasExplicitWorkflowSignal ? "memory_declared_recurring_workflow" : "memory_imported_work_episode",
      goal: statement,
      confidence: sourceImport ? 0.9 : 0.78,
    },
    sources: [sourceImport ? "Imported ChatGPT memory" : "Memory record"],
    sourceDetails: [{
      type: "memory",
      name: sourceImport ? "Imported ChatGPT memory" : "Memory record",
      id: event.id,
      importance: memoryImportance,
    }],
    outputType,
    output: {
      type: outputType === "newsletter" ? "newsletter" : "unknown",
      description: hasExplicitWorkflowSignal
        ? "Memory-derived recurring workflow evidence"
        : "Memory-derived AI-assisted work evidence",
    },
    toolNames: [event.platform],
    steps: [statement],
    styleHints: [],
    userBehavior: {
      accepted: true,
      edited: null,
      regenerated: null,
      ignored: false,
      approvalSignal: "approved",
    },
    automationSignals: {
      repeatable: hasExplicitWorkflowSignal,
      likelyCadence: cadence,
      businessValue: sourceImport ? 0.72 : 0.62,
      automationReadiness: 0.72,
    },
    confidence: sourceImport ? 0.9 : 0.78,
    approved: true,
    eventIds: [event.id],
  };
}

export function packByEstimatedPromptBudget<T>(
  items: readonly T[],
  options: {
    maxTokens: number;
    baseTokens: number;
    estimateItemTokens: (item: T) => number;
  }
): TokenPackResult<T> {
  const batches: T[][] = [];
  const maxTokens = Math.max(1200, options.maxTokens);
  const baseTokens = Math.max(0, options.baseTokens);
  let current: T[] = [];
  let currentTokens = baseTokens;
  let maxEstimatedTokensPerBatch = 0;

  const pushBatch = () => {
    if (current.length === 0) return;
    batches.push(current);
    maxEstimatedTokensPerBatch = Math.max(maxEstimatedTokensPerBatch, currentTokens);
    current = [];
    currentTokens = baseTokens;
  };

  for (const item of items) {
    const itemTokens = Math.max(1, options.estimateItemTokens(item));
    if (current.length === 0 && baseTokens + itemTokens > maxTokens) {
      batches.push([item]);
      maxEstimatedTokensPerBatch = Math.max(maxEstimatedTokensPerBatch, baseTokens + itemTokens);
      continue;
    }
    if (current.length > 0 && currentTokens + itemTokens > maxTokens) {
      pushBatch();
    }
    current.push(item);
    currentTokens += itemTokens;
  }

  pushBatch();
  return { batches, maxEstimatedTokensPerBatch };
}

export function compactEpisodeForPrompt(
  episode: EpisodeRecord,
  options: { maxTurns: number; maxTurnSummaryChars: number }
): Record<string, unknown> {
  const maxTurns = Math.max(1, options.maxTurns);
  const maxTurnSummaryChars = Math.max(120, options.maxTurnSummaryChars);
  const turns = episode.turns.slice(-maxTurns).map((turn: EpisodeTurnRecord) => ({
    role: turn.role,
    contentSummary: turn.contentSummary.length <= maxTurnSummaryChars
      ? turn.contentSummary
      : `${turn.contentSummary.slice(0, maxTurnSummaryChars - 3)}...`,
    createdAt: turn.createdAt,
    sourceEventType: turn.sourceEventType,
  }));
  return {
    id: episode.id,
    intent: episode.intent,
    sources: episode.sources,
    outputType: episode.outputType,
    steps: episode.steps,
    styleHints: episode.styleHints ?? [],
    automationSignals: episode.automationSignals ?? null,
    userBehavior: episode.userBehavior ?? null,
    sealedAt: episode.sealedAt,
    approved: episode.approved,
    turns,
  };
}

export function chunkEventsByTimeGap(events: MinerEvent[], gapHours = 4): MinerEvent[][] {
  const sorted = [...events].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const chunks: MinerEvent[][] = [];
  const gapMs = gapHours * 60 * 60_000;
  for (const event of sorted) {
    const current = chunks[chunks.length - 1];
    if (!current || current.length === 0) {
      chunks.push([event]);
      continue;
    }
    const prev = current[current.length - 1];
    const prevTime = Date.parse(prev.createdAt);
    const currentTime = Date.parse(event.createdAt);
    if (Number.isFinite(prevTime) && Number.isFinite(currentTime) && currentTime - prevTime > gapMs) {
      chunks.push([event]);
    } else {
      current.push(event);
    }
  }
  return chunks;
}

export function normalizeEpisodeExtraction(value: unknown, validEventIds: Set<string>): EpisodeExtraction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const eventIds = readStringArray(row.eventIds ?? row.event_ids).filter((id) => validEventIds.has(id));
  if (eventIds.length === 0) return null;
  const intentRow = readObject(row.intent);
  const outputRow = readObject(row.output);
  const behaviorRow = readObject(row.userBehavior ?? row.user_behavior);
  const automationRow = readObject(row.automationSignals ?? row.automation_signals);
  const sourceRows = Array.isArray(row.sources) ? row.sources : [];
  const sourceDetails = sourceRows
    .map((source): NonNullable<EpisodeExtraction["sourceDetails"]>[number] | null => {
      if (typeof source === "string") {
        return { type: "manual_input", name: source.trim(), importance: 0.5 };
      }
      const sourceRow = readObject(source);
      const name = readString(sourceRow.name ?? sourceRow.source, "");
      if (!name) return null;
      const rawType = sourceRow.type ?? sourceRow.source_type;
      return {
        type: isSourceType(rawType) ? rawType : "manual_input",
        name,
        id: typeof sourceRow.id === "string" && sourceRow.id.trim() ? sourceRow.id.trim() : undefined,
        importance: normalizeConfidence(sourceRow.importance ?? 0.5),
      };
    })
    .filter((source): source is NonNullable<EpisodeExtraction["sourceDetails"]>[number] => Boolean(source));
  const intentGoal = readString(intentRow.goal, typeof row.intent === "string" ? row.intent : "Untitled work episode");
  const outputType = isOutputType(outputRow.type) ? outputRow.type : readString(row.outputType ?? row.output_type, "unknown");
  if (/\b(preference|profile|memory|fact)\b/i.test(outputType)) return null;
  const rawApprovalSignal = behaviorRow.approvalSignal ?? behaviorRow.approval_signal;
  const approvalSignal = isApprovalSignal(rawApprovalSignal) ? rawApprovalSignal : "unclear";
  const accepted = normalizeNullableBoolean(behaviorRow.accepted);
  const approved = accepted ?? (typeof row.approved === "boolean" ? row.approved : approvalSignal === "approved");
  return {
    title: readString(row.title, intentGoal),
    summary: readString(row.summary, intentGoal),
    intent: intentGoal,
    intentDetails: {
      label: readString(intentRow.label ?? row.intentLabel ?? row.intent_label, "unknown"),
      goal: intentGoal,
      confidence: normalizeConfidence(intentRow.confidence ?? row.confidence),
    },
    sources: sourceDetails.map((source) => source.name),
    sourceDetails,
    outputType,
    output: {
      type: isOutputType(outputRow.type) ? outputRow.type : isOutputType(outputType) ? outputType : "unknown",
      description: readString(outputRow.description, outputType),
      finalArtifact: typeof outputRow.finalArtifact === "string" && outputRow.finalArtifact.trim()
        ? outputRow.finalArtifact.trim()
        : undefined,
    },
    toolNames: readStringArray(row.toolNames ?? row.tool_names),
    steps: readStringArray(row.steps),
    styleHints: readStringArray(row.styleHints ?? row.style_hints),
    userBehavior: {
      accepted,
      edited: normalizeNullableBoolean(behaviorRow.edited),
      regenerated: normalizeNullableBoolean(behaviorRow.regenerated),
      ignored: normalizeNullableBoolean(behaviorRow.ignored),
      approvalSignal,
    },
    automationSignals: {
      repeatable: typeof automationRow.repeatable === "boolean" ? automationRow.repeatable : false,
      likelyCadence: (() => {
        const rawCadence = automationRow.likelyCadence ?? automationRow.likely_cadence;
        return isCadence(rawCadence) ? rawCadence : "unknown";
      })(),
      businessValue: normalizeConfidence(automationRow.businessValue ?? automationRow.business_value),
      automationReadiness: normalizeConfidence(automationRow.automationReadiness ?? automationRow.automation_readiness),
    },
    confidence: normalizeConfidence(row.confidence),
    approved,
    eventIds,
  };
}

export function prefilterEpisodesByOutputType(episodes: EpisodeRecord[]): EpisodeRecord[] {
  const counts = new Map<string, number>();
  for (const episode of episodes) {
    const key = episode.outputType.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return episodes.filter((episode) => (counts.get(episode.outputType.trim().toLowerCase()) ?? 0) >= 2);
}

export function normalizeCandidateLoop(value: unknown, validEpisodeIds: Set<string>): CandidateLoop | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const episodeIds = readStringArray(row.episodeIds ?? row.episode_ids).filter((id) => validEpisodeIds.has(id));
  if (episodeIds.length < 2) return null;
  return {
    loopName: readString(row.loopName ?? row.loop_name, "Recurring workflow"),
    episodeIds,
    sharedIntent: readString(row.sharedIntent ?? row.shared_intent, "Repeated user workflow"),
    sharedSources: readStringArray(row.sharedSources ?? row.shared_sources),
    sharedOutputType: readString(row.sharedOutputType ?? row.shared_output_type, "unknown"),
    reasoning: readString(row.reasoning, "Episodes repeat the same workflow pattern."),
  };
}

export function normalizeLoopEvaluation(value: unknown, fallback: CandidateLoop): LoopEvaluation {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rawVerdict = row.verdict;
  const verdict: LoopVerdict = rawVerdict === "automate" || rawVerdict === "monitor" || rawVerdict === "discard"
    ? rawVerdict
    : "discard";
  const rawEstimatedValue = row.estimatedValue ?? row.estimated_value;
  const estimatedValue = rawEstimatedValue === "low" || rawEstimatedValue === "medium" || rawEstimatedValue === "high"
    ? rawEstimatedValue
    : "medium";
  const rawReadiness = row.automationReadiness ?? row.automation_readiness;
  const automationReadiness = rawReadiness === "full" || rawReadiness === "partial" || rawReadiness === "manual"
    ? rawReadiness
    : "partial";
  return {
    loopName: readString(row.loopName ?? row.loop_name, fallback.loopName),
    episodeIds: readStringArray(row.episodeIds ?? row.episode_ids).filter((id) => fallback.episodeIds.includes(id)).length > 0
      ? readStringArray(row.episodeIds ?? row.episode_ids).filter((id) => fallback.episodeIds.includes(id))
      : fallback.episodeIds,
    confidence: normalizeConfidence(row.confidence),
    verdict,
    reasoning: readString(row.reasoning, "No evaluator reasoning provided."),
    estimatedCadence: readString(row.estimatedCadence ?? row.estimated_cadence, "ad-hoc"),
    estimatedValue,
    automationReadiness,
    risks: readStringArray(row.risks),
  };
}

function requiresApproval(dna: WorkflowDNA): boolean {
  const text = [
    dna.outputType,
    dna.stepPattern.join(" "),
    dna.reasoning,
    dna.name,
  ].join(" ").toLowerCase();
  return /\b(send|email|publish|post|submit|modify|update|delete|remove|archive|deploy|merge|approve|payment|production)\b/.test(text);
}

export function normalizeWorkflowDna(value: unknown, fallback: { loop: CandidateLoop; evaluation: LoopEvaluation; episodes: EpisodeRecord[] }): WorkflowDNA {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const triggerRow = row.trigger && typeof row.trigger === "object" && !Array.isArray(row.trigger)
    ? row.trigger as Record<string, unknown>
    : {};
  const rawTriggerType = triggerRow.type;
  const triggerType = rawTriggerType === "event" ? "event" : "schedule";
  const rawApproval = row.approvalBehavior ?? row.approval_behavior;
  const dna: WorkflowDNA = {
    name: readString(row.name, fallback.loop.loopName),
    trigger: {
      type: triggerType,
      cadence: readString(triggerRow.cadence, fallback.evaluation.estimatedCadence),
    },
    sources: readStringArray(row.sources).length > 0 ? readStringArray(row.sources) : fallback.loop.sharedSources,
    outputType: readString(row.outputType ?? row.output_type, fallback.loop.sharedOutputType),
    stepPattern: readStringArray(row.stepPattern ?? row.step_pattern).length > 0
      ? readStringArray(row.stepPattern ?? row.step_pattern)
      : [...new Set(fallback.episodes.flatMap((episode) => episode.steps))],
    style: readString(row.style, "Match the user's prior outputs for this workflow."),
    approvalBehavior: rawApproval === "auto" || rawApproval === "require_explicit_approval"
      ? rawApproval
      : "auto",
    reasoning: readString(row.reasoning, fallback.evaluation.reasoning),
  };
  if (requiresApproval(dna)) {
    return { ...dna, approvalBehavior: "require_explicit_approval" };
  }
  return dna;
}

export function workflowDnaFingerprint(dna: WorkflowDNA): string {
  const normalized = JSON.stringify({
    name: dna.name.toLowerCase(),
    sources: dna.sources.map((source) => source.toLowerCase()).sort(),
    outputType: dna.outputType.toLowerCase(),
    stepPattern: dna.stepPattern.map((step) => step.toLowerCase()),
  });
  return `loop-miner-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export function workflowDnaPrompt(dna: WorkflowDNA): string {
  const trigger = `${dna.trigger.type}: ${dna.trigger.cadence}`;
  const steps = dna.stepPattern.length > 0 ? dna.stepPattern.join("; ") : "Follow the user's established repeatable workflow pattern.";
  return `Automate "${dna.name}" on ${trigger}. Use sources: ${dna.sources.join(", ") || "the relevant connected sources"}. Produce ${dna.outputType}. Steps: ${steps}. Style: ${dna.style}. Approval: ${dna.approvalBehavior}.`;
}

export const LOOP_EPISODE_EXTRACTION_VERSION = "loop_episode_extraction_v2";
export const LOOP_EPISODE_EMBEDDING_VERSION = "loop_episode_embedding_v1";

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sourceFingerprintFromTurns(
  turns: readonly Pick<EpisodeTurnRecord, "sourceEventId" | "sourceEventType" | "createdAt" | "contentSummary">[],
  extractionVersion = LOOP_EPISODE_EXTRACTION_VERSION
): string {
  const normalizedTurns = [...turns]
    .map((turn) => ({
      sourceEventId: turn.sourceEventId,
      sourceEventType: turn.sourceEventType,
      createdAt: turn.createdAt,
      // Keep summaries compact but content-sensitive so true updates invalidate the fingerprint.
      contentSummary: turn.contentSummary.slice(0, 600),
    }))
    .sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId));
  return stableHash(JSON.stringify({ extractionVersion, turns: normalizedTurns }));
}

export function sourceFingerprintFromEvent(
  event: Pick<MinerEvent, "id" | "sourceEventType" | "createdAt" | "contentSummary">,
  extractionVersion = LOOP_EPISODE_EXTRACTION_VERSION
): string {
  return sourceFingerprintFromTurns([{
    sourceEventId: event.id,
    sourceEventType: event.sourceEventType,
    createdAt: event.createdAt,
    contentSummary: event.contentSummary,
  }], extractionVersion);
}

function normalizeTextSignal(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripStructuralTokens(value: string): string {
  return value
    .replace(/\b(week|wk|phase|part|module|milestone|lesson|sprint)\s*\d+\b/gi, " ")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ")
    .replace(/\b(?:id|ticket|doc|task|issue|ref)\s*[:#-]?\s*[a-z0-9_-]{3,}\b/gi, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/["'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function domainFromSignals(text: string): LoopOperationalDomain {
  if (/\b(invoice|billing|payment|receipt|charge|subscription|refund|past due)\b/.test(text)) {
    return "administrative_billing";
  }
  if (/\b(spreadsheet|sheet|excel|formula|audit|reconcile|variance|ledger|forecast|budget|p&l)\b/.test(text)) {
    return "financial_calculation_spreadsheet_audit";
  }
  if (/\b(image|visual|render|thumbnail|mockup|retouch|upscale|crop|color|asset)\b/.test(text)) {
    return "asset_visual_enhancement";
  }
  if (/\b(translate|localize|copywriting|newsletter|email|copy|rewrite|tone|hook|headline|draft)\b/.test(text)) {
    return "copywriting_translation";
  }
  return "operational_document_scoping";
}

function artifactClassFromEpisode(episode: EpisodeRecord, text: string): string {
  const output = episode.outputType.trim().toLowerCase();
  if (output && output !== "unknown") return output;
  if (/\b(slides?|deck|course material|lesson)\b/.test(text)) return "slides";
  if (/\b(newsletter|email|copy)\b/.test(text)) return "copy";
  if (/\b(invoice|billing|payment)\b/.test(text)) return "billing_record";
  if (/\b(spreadsheet|sheet|excel|model)\b/.test(text)) return "spreadsheet";
  if (/\b(image|visual|asset)\b/.test(text)) return "visual_asset";
  return "document";
}

function actionClassFromSignals(text: string): string {
  if (/\b(translate|localize)\b/.test(text)) return "translate_localize";
  if (/\b(calc|calculate|audit|reconcile|validate|cross-check)\b/.test(text)) return "numeric_audit";
  if (/\b(enhance|retouch|upscale|clean up image|adjust color)\b/.test(text)) return "asset_enhance";
  if (/\b(invoice|bill|charge|collect payment|reconcile billing)\b/.test(text)) return "billing_reconcile";
  if (/\b(brainstorm|outline|structure|expand|layout)\b/.test(text)) return "layout_expansion";
  if (/\b(debloat|trim|simplify|tighten|edit|refine|polish)\b/.test(text)) return "copy_debloat";
  return "draft_refine_finalize";
}

function inputClassFromEpisode(episode: EpisodeRecord, text: string): string {
  const sources = episode.sources.join(" ").toLowerCase();
  const tools = episode.toolNames.join(" ").toLowerCase();
  if (/\b(github|gitlab|commit|pull request)\b/.test(`${sources} ${tools} ${text}`)) return "repo_delta";
  if (/\b(sheet|spreadsheet|csv|excel)\b/.test(`${sources} ${text}`)) return "tabular_input";
  if (/\b(invoice|billing|payment)\b/.test(text)) return "billing_record";
  if (/\b(image|asset|screenshot|design)\b/.test(text)) return "visual_asset";
  if (/\b(memory|notes|brief|conversation|instruction|instructions|outline|context)\b/.test(`${sources} ${text}`)) return "text_context";
  return "vague_input";
}

function extractSequenceSignal(text: string): CanonicalLoopFacet["sequenceSignal"] {
  const match = text.match(/\b(week|phase|part|module|milestone|lesson|sprint)\s*(\d+)\b/i);
  if (!match) {
    return { hasSequentialMarkers: false, markers: [] };
  }
  const markerType = match[1]?.toLowerCase();
  const markerValue = Number(match[2]);
  return {
    hasSequentialMarkers: Number.isFinite(markerValue),
    markers: [`${markerType}:${markerValue}`],
    markerType: markerType || undefined,
    markerValue: Number.isFinite(markerValue) ? markerValue : undefined,
  };
}

export function deriveCanonicalLoopFacet(episode: EpisodeRecord): CanonicalLoopFacet {
  const raw = [
    episode.title ?? "",
    episode.summary ?? "",
    episode.intent,
    episode.steps.join(" "),
    episode.turns.map((turn) => turn.contentSummary).join(" "),
  ].join(" ");
  const normalized = normalizeTextSignal(raw);
  const decontextualized = stripStructuralTokens(normalized);
  const operationalDomain = domainFromSignals(decontextualized);
  const artifactClass = artifactClassFromEpisode(episode, decontextualized);
  const actionClass = actionClassFromSignals(decontextualized);
  const inputClass = inputClassFromEpisode(episode, decontextualized);
  const sequenceSignal = extractSequenceSignal(normalized);
  const mechanismSignature = `input:${inputClass}|action:${actionClass}|artifact:${artifactClass}`;
  const abstractedJtbd = decontextualized || "general recurring workflow";
  return {
    abstractedJtbd,
    operationalDomain,
    mechanismSignature,
    artifactClass,
    actionClass,
    sequenceSignal,
  };
}

export function evaluateProjectProgression(episodes: EpisodeRecord[]): ProjectProgressionVerdict {
  if (episodes.length < 2) {
    return { isProjectProgression: false, reason: "insufficient_episodes" };
  }
  const facets = episodes.map(deriveCanonicalLoopFacet);
  const markers = facets
    .map((facet) => ({ type: facet.sequenceSignal.markerType, value: facet.sequenceSignal.markerValue }))
    .filter((marker): marker is { type: string; value: number } => Boolean(marker.type) && Number.isFinite(marker.value));
  if (markers.length < 2) {
    return { isProjectProgression: false, reason: "no_linear_markers" };
  }
  const grouped = new Map<string, number[]>();
  for (const marker of markers) {
    const values = grouped.get(marker.type) ?? [];
    values.push(marker.value);
    grouped.set(marker.type, values);
  }
  for (const [type, values] of grouped.entries()) {
    if (values.length < 2) continue;
    const sorted = [...values].sort((a, b) => a - b);
    let adjacentCount = 0;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] === sorted[i - 1] + 1) adjacentCount += 1;
    }
    if (adjacentCount >= 1) {
      return { isProjectProgression: true, reason: `${type}_sequential_progression` };
    }
  }
  return { isProjectProgression: false, reason: "marker_non_linear" };
}

function mapOperationalDomainToWorkspace(domain: LoopOperationalDomain): WorkspaceTraceOperationalDomain {
  if (domain === "copywriting_translation") return "Copywriting";
  if (domain === "financial_calculation_spreadsheet_audit") return "Calculations";
  if (domain === "asset_visual_enhancement") return "Visual_Enhancement";
  return "System_Design";
}

function uniqueLower(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function inferInputArtifactClasses(episode: EpisodeRecord): string[] {
  const signal = `${episode.sources.join(" ")} ${episode.intent} ${episode.steps.join(" ")}`.toLowerCase();
  const classes = new Set<string>();
  if (/\bdocx|word|document\b/.test(signal)) classes.add("docx");
  if (/\bpdf\b/.test(signal)) classes.add("pdf");
  if (/\bspreadsheet|sheet|excel|csv\b/.test(signal)) classes.add("spreadsheet");
  if (/\bblueprint|notes|brief|context|conversation\b/.test(signal)) classes.add("blueprint_notes");
  if (/\bimage|asset|screenshot|design\b/.test(signal)) classes.add("image");
  if (classes.size === 0) classes.add("text_context");
  return [...classes];
}

function inferOutputArtifactClasses(episode: EpisodeRecord): string[] {
  const output = episode.outputType.trim().toLowerCase();
  if (!output || output === "unknown") return ["markdown"];
  if (output === "slides" || output === "deck") return ["slides"];
  if (output === "email" || output === "newsletter") return ["copy_paste_text"];
  if (output === "document" || output === "brief" || output === "plan") return ["markdown"];
  return [output];
}

export function deriveWorkspaceTracePayload(
  episode: EpisodeRecord,
  vector: number[]
): WorkspaceTracePayload {
  const canonical = deriveCanonicalLoopFacet(episode);
  const subjectAnchor = (episode.sources[0] ?? episode.title ?? episode.intent ?? "Unlabeled Loop")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return {
    id: episode.id,
    text: [
      episode.title ?? "",
      episode.summary ?? "",
      episode.intent,
      episode.steps.join(" | "),
    ].filter(Boolean).join("\n"),
    vector,
    metadata: {
      subject_anchor: subjectAnchor || "Unlabeled Loop",
      operational_domain: mapOperationalDomainToWorkspace(canonical.operationalDomain),
      input_artifact_classes: inferInputArtifactClasses(episode),
      output_artifact_classes: inferOutputArtifactClasses(episode),
      category: episode.outputType && episode.outputType !== "unknown" ? episode.outputType : null,
    },
    provenance: {
      platform: episode.toolNames[0] ?? "unknown",
      written_at: episode.sealedAt,
    },
  };
}

export interface WorkspaceGroupedHit {
  subjectAnchor: string;
  runs: WorkspaceHistoricalRun[];
}

function artifactOverlapScore(left: WorkspaceHistoricalRun, right: WorkspaceHistoricalRun): number {
  const leftSignature = uniqueLower([
    ...left.metadata.input_artifact_classes,
    ...left.metadata.output_artifact_classes,
  ]);
  const rightSignature = uniqueLower([
    ...right.metadata.input_artifact_classes,
    ...right.metadata.output_artifact_classes,
  ]);
  if (leftSignature.length === 0 || rightSignature.length === 0) return 0;
  const rightSet = new Set(rightSignature);
  const intersection = leftSignature.filter((value) => rightSet.has(value)).length;
  const denominator = Math.max(leftSignature.length, rightSignature.length);
  return denominator === 0 ? 0 : intersection / denominator;
}

function dedupeHistoricalRuns(runs: WorkspaceHistoricalRun[]): WorkspaceHistoricalRun[] {
  const byEpisodeId = new Map<string, WorkspaceHistoricalRun>();
  for (const run of runs) {
    const existing = byEpisodeId.get(run.episodeId);
    if (!existing || run.score > existing.score) {
      byEpisodeId.set(run.episodeId, run);
    }
  }
  return [...byEpisodeId.values()].sort((left, right) =>
    Date.parse(left.provenance.written_at) - Date.parse(right.provenance.written_at)
  );
}

export function consolidateWorkspaceGroupedHits(groups: WorkspaceGroupedHit[]): WorkspaceLoopParent[] {
  const parents = groups
    .map((group) => ({
      id: stableHash(`loop-parent:${group.subjectAnchor}`).slice(0, 24),
      subjectAnchor: group.subjectAnchor,
      confidenceScore: Math.max(
        0,
        Math.min(1, group.runs.reduce((sum, run) => sum + run.score, 0) / Math.max(1, group.runs.length))
      ),
      primarySourceFile: group.runs[0]?.metadata.input_artifact_classes[0] ?? "unknown",
      totalRunsCount: group.runs.length,
      operationalDomain: group.runs[0]?.metadata.operational_domain ?? "System_Design",
      historicalRuns: dedupeHistoricalRuns(group.runs),
    }))
    .filter((group) => group.historicalRuns.length > 0);

  const merged: WorkspaceLoopParent[] = [];
  for (const parent of parents) {
    const mergeInto = merged.find((candidate) =>
      candidate.historicalRuns.some((existingRun) =>
        parent.historicalRuns.some((incomingRun) => artifactOverlapScore(existingRun, incomingRun) > 0.92)
      )
    );
    if (!mergeInto) {
      merged.push(parent);
      continue;
    }
    mergeInto.historicalRuns = dedupeHistoricalRuns([...mergeInto.historicalRuns, ...parent.historicalRuns]);
    mergeInto.totalRunsCount = mergeInto.historicalRuns.length;
    mergeInto.confidenceScore = Math.max(mergeInto.confidenceScore, parent.confidenceScore);
  }
  return merged.sort((left, right) => right.confidenceScore - left.confidenceScore);
}

export function episodeEmbeddingText(episode: EpisodeRecord): string {
  const canonical = deriveCanonicalLoopFacet(episode);
  const turns = episode.turns
    .slice(-4)
    .map((turn) => `${turn.sourceEventType}:${turn.role}:${turn.contentSummary.slice(0, 240)}`);
  return [
    `version=${LOOP_EPISODE_EMBEDDING_VERSION}`,
    `abstractedJtbd=${canonical.abstractedJtbd}`,
    `operationalDomain=${canonical.operationalDomain}`,
    `mechanismSignature=${canonical.mechanismSignature}`,
    `artifactClass=${canonical.artifactClass}`,
    `actionClass=${canonical.actionClass}`,
    `intent=${episode.intent}`,
    `outputType=${episode.outputType}`,
    `sources=${episode.sources.join(", ")}`,
    `tools=${episode.toolNames.join(", ")}`,
    `steps=${episode.steps.join(" | ")}`,
    `style=${(episode.styleHints ?? []).join(", ")}`,
    `turns=${turns.join(" || ")}`,
  ].join("\n");
}

export function episodeEmbeddingTextHash(text: string): string {
  return stableHash(text);
}
