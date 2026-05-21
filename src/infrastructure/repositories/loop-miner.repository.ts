import { createHash, randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { decryptMemoryContent } from "../crypto/memory-crypto.js";
import { pool } from "../db/index.js";
import type {
  CandidateLoop,
  EpisodeExtraction,
  EpisodeRecord,
  EpisodeTurnRecord,
  LoopEvaluation,
  LoopMinerMemoryDecision,
  LoopMinerRepository as LoopMinerRepositoryContract,
  LoopMinerRunView,
  LoopMinerRunReason,
  LoopMinerSuggestion,
  LoopMinerSummary,
  LoopMinerWorkflowSuggestionView,
  MinerEvent,
  WorkflowDNA,
} from "../../orchestration/loop-miner/types.js";

interface AiActivityRow {
  id: string;
  source: string;
  activity_type: string;
  content_text: string;
  metadata_json: unknown;
  created_at: string;
}

interface CollabTaskRow {
  id: string;
  title: string;
  brief: string | null;
  state: string;
  last_actor: string | null;
  iteration: number;
  context: unknown;
  transcript: unknown;
  created_at: string;
  updated_at: string;
}

interface MemoryRecordEventRow {
  id: string;
  content_ciphertext: string;
  platform: string;
  memory_type: string;
  category: string | null;
  is_pinned: boolean;
  importance: string | number;
  summary_json: unknown;
  created_at: string;
}

interface EpisodeRow {
  id: string;
  intent: string;
  sources: string[];
  output_type: string;
  tool_names: string[];
  turn_count: number;
  approved: boolean;
  extraction_json: unknown;
  source_fingerprint: string | null;
  extraction_version: string | null;
  embedding_text_hash: string | null;
  embedding_status: "pending" | "ready" | "failed" | null;
  embedded_at: string | null;
  sealed_at: string;
}

interface EpisodeTurnRow {
  episode_id: string;
  role: "user" | "assistant" | "system";
  content_summary: string;
  source_event_type: "ai_activity_event" | "collab_task" | "memory_record";
  source_event_id: string;
  created_at: string;
}

interface LoopMinerRunRow {
  id: string;
  status: "running" | "completed" | "failed";
  summary_json: unknown;
  error_json: unknown;
  created_at: string;
  completed_at: string | null;
}

interface WorkflowSuggestionRow {
  id: string;
  title: string;
  reason: string;
  suggested_prompt: string;
  confidence: string | number;
  fingerprint: string;
  trigger_count: number;
  created_at: string;
  metadata_json: unknown;
}

const EPISODE_AUGMENTED_COLUMN_NAMES = [
  "source_fingerprint",
  "extraction_version",
  "embedding_text_hash",
  "embedding_status",
  "embedded_at",
] as const;

function isMissingEpisodeAugmentedColumn(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  if (code !== "42703") return false;
  const message = error.message.toLowerCase();
  return EPISODE_AUGMENTED_COLUMN_NAMES.some((column) => message.includes(column));
}

function safeSummary(value: string, limit = 1600): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function truncateText(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function inferRole(metadata: unknown): "user" | "assistant" | "system" {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "user";
  const role = (metadata as Record<string, unknown>).role;
  return role === "assistant" || role === "system" || role === "user" ? role : "user";
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function collabTaskSummary(row: CollabTaskRow): string {
  const context = readRecord(row.context);
  const artifacts = readRecord(context.artifacts);
  const documents = readRecord(context.documents);
  const documentRows = Array.isArray(documents.documents) ? documents.documents : [];
  const documentTitles = documentRows
    .map((document) => readRecord(document).title)
    .filter((title): title is string => typeof title === "string" && title.trim().length > 0)
    .slice(0, 4);
  const transcriptRows = Array.isArray(row.transcript) ? row.transcript : [];
  const transcriptPreview = transcriptRows
    .map((entry) => {
      const record = readRecord(entry);
      const actor = typeof record.actor === "string" ? record.actor : typeof record.role === "string" ? record.role : "turn";
      const content = typeof record.content === "string" ? record.content : typeof record.text === "string" ? record.text : "";
      return content ? `${actor}: ${truncateText(content, 220)}` : "";
    })
    .filter(Boolean)
    .slice(-2)
    .join(" ");
  return safeSummary([
    `Collaboration task: ${row.title}`,
    row.brief ? `Brief: ${row.brief}` : null,
    `State: ${row.state}`,
    `Iterations: ${row.iteration}`,
    typeof artifacts.prd_summary === "string" && artifacts.prd_summary.trim() ? `Final/output summary: ${artifacts.prd_summary}` : null,
    documentTitles.length > 0 ? `Documents: ${documentTitles.join(", ")}` : null,
    transcriptPreview ? `Recent transcript: ${transcriptPreview}` : null,
  ].filter((part): part is string => Boolean(part)).join("\n"), 900);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function validIsoLike(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function memoryEventDate(row: MemoryRecordEventRow, summary: Record<string, unknown>): string {
  return validIsoLike(summary.source_datetime)
    ?? validIsoLike(summary.observed_at)
    ?? validIsoLike(summary.created_at)
    ?? row.created_at;
}

function memoryLoopImportance(row: MemoryRecordEventRow, summary: Record<string, unknown>): number {
  if (readBoolean(summary.source_import)) return 0.72;
  if (!readString(summary.cleanup_bucket)) return 0.64;
  return Math.max(0.45, Math.min(0.6, Number(row.importance) || 0.5));
}

function isLoopEvidenceMemoryType(memoryType: string): boolean {
  return memoryType === "fact" || memoryType === "decision" || memoryType === "preference";
}

function shouldIncludeMemoryForLoopMining(row: MemoryRecordEventRow, summary: Record<string, unknown>): boolean {
  if (readBoolean(summary.source_import)) return true;
  const bucket = readString(summary.cleanup_bucket);
  if (!isLoopEvidenceMemoryType(row.memory_type)) return false;
  if (!bucket) return true;
  return bucket === "long_term" || bucket === "permanent";
}

function memoryDecisionReason(summary: Record<string, unknown>, decryptFailed: boolean, includedByMetadata: boolean): string {
  if (decryptFailed) return "decrypt_failed";
  if (!includedByMetadata) {
    const bucket = readString(summary.cleanup_bucket);
    return bucket ? "bucketed_memory_deprioritized" : "unbucketed_memory_deprioritized";
  }
  if (readBoolean(summary.source_import)) return "fresh_source_import_selected";
  const bucket = readString(summary.cleanup_bucket);
  if (!bucket) return "unbucketed_memory_selected";
  if (bucket === "long_term" || bucket === "permanent") return "bucketed_memory_selected";
  return "bucketed_memory_deprioritized";
}

function memoryRecordSummary(row: MemoryRecordEventRow): MinerEvent | null {
  let content = "";
  try {
    content = decryptMemoryContent(row.content_ciphertext);
  } catch {
    return null;
  }
  const summary = readRecord(row.summary_json);
  const sourceImport = readBoolean(summary.source_import);
  const sourceDateTime = readString(summary.source_datetime);
  const observedAt = validIsoLike(summary.source_datetime)
    ?? validIsoLike(summary.observed_at)
    ?? null;
  const detectedMemoryType = readString(summary.import_detected_memory_type);
  const cleanupBucket = readString(summary.cleanup_bucket);
  const minerImportance = memoryLoopImportance(row, summary);
  return {
    id: row.id,
    sourceEventType: "memory_record",
    createdAt: memoryEventDate(row, summary),
    platform: row.platform,
    contentSummary: safeSummary([
      sourceImport ? "Imported ChatGPT memory" : "Memory",
      `Type: ${detectedMemoryType ?? row.memory_type}`,
      row.category ? `Category: ${row.category}` : null,
      sourceDateTime ? `Source datetime: ${sourceDateTime}` : null,
      content,
    ].filter((part): part is string => Boolean(part)).join("\n"), 900),
    role: "user",
    metadata: {
      memoryType: row.memory_type,
      detectedMemoryType,
      category: row.category,
      isPinned: row.is_pinned,
      sourceImport,
      sourceImportBatchId: readString(summary.source_import_batch_id),
      sourceImportMode: readString(summary.source_import_mode),
      sourceDateTime,
      observedAt,
      cleanupAppliedAt: validIsoLike(summary.cleanup_bucketed_at),
      cleanupAction: readString(summary.cleanup_action),
      cleanupTargetMemoryId: readString(summary.cleanup_target_memory_id),
      cleanupSourceMemoryIds: readStringArray(summary.cleanup_source_memory_ids),
      cleanupBucket,
      minerImportance,
      memoryImportance: Number(row.importance) || 0,
    },
  };
}

function memoryDecisionForRow(row: MemoryRecordEventRow): LoopMinerMemoryDecision {
  const summary = readRecord(row.summary_json);
  let content = "";
  let decryptFailed = false;
  try {
    content = decryptMemoryContent(row.content_ciphertext);
  } catch {
    decryptFailed = true;
  }
  const sourceImport = readBoolean(summary.source_import);
  const cleanupBucket = readString(summary.cleanup_bucket);
  const includedByMetadata = shouldIncludeMemoryForLoopMining(row, summary);
  const status = includedByMetadata && !decryptFailed ? "included" : "excluded";
  return {
    memoryId: row.id,
    status,
    reason: memoryDecisionReason(summary, decryptFailed, includedByMetadata),
    contentPreview: decryptFailed ? "[Encrypted memory unavailable]" : truncateText(content, 280),
    createdAt: row.created_at,
    selectedAt: memoryEventDate(row, summary),
    memoryType: row.memory_type,
    detectedMemoryType: readString(summary.import_detected_memory_type),
    category: row.category,
    cleanupBucket,
    isPinned: row.is_pinned,
    sourceImport,
    sourcePlatform: readString(summary.source_platform),
    sourceImportMode: readString(summary.source_import_mode),
    sourceImportBatchId: readString(summary.source_import_batch_id),
    sourceDateTime: readString(summary.source_datetime),
    observedAt: validIsoLike(summary.source_datetime) ?? validIsoLike(summary.observed_at),
    cleanupAppliedAt: validIsoLike(summary.cleanup_bucketed_at),
    cleanupAction: readString(summary.cleanup_action),
    cleanupTargetMemoryId: readString(summary.cleanup_target_memory_id),
    cleanupSourceMemoryIds: readStringArray(summary.cleanup_source_memory_ids),
    minerImportance: memoryLoopImportance(row, summary),
    memoryImportance: Number(row.importance) || 0,
  };
}

function mapEpisode(row: EpisodeRow, turns: EpisodeTurnRecord[]): EpisodeRecord {
  const extraction = row.extraction_json && typeof row.extraction_json === "object" && !Array.isArray(row.extraction_json)
    ? row.extraction_json as Partial<EpisodeRecord>
    : {};
  return {
    id: row.id,
    title: extraction.title,
    summary: extraction.summary,
    intent: row.intent,
    intentDetails: extraction.intentDetails,
    sources: row.sources,
    sourceDetails: extraction.sourceDetails,
    outputType: row.output_type,
    output: extraction.output,
    toolNames: row.tool_names,
    sourceFingerprint: row.source_fingerprint ?? undefined,
    extractionVersion: row.extraction_version ?? undefined,
    embeddingTextHash: row.embedding_text_hash ?? undefined,
    embeddingStatus: row.embedding_status ?? undefined,
    embeddedAt: row.embedded_at ?? undefined,
    steps: Array.isArray(extraction.steps) ? extraction.steps.filter((step): step is string => typeof step === "string") : [],
    styleHints: extraction.styleHints,
    userBehavior: extraction.userBehavior,
    automationSignals: extraction.automationSignals,
    confidence: extraction.confidence,
    approved: row.approved,
    eventIds: Array.isArray(extraction.eventIds) ? extraction.eventIds.filter((id): id is string => typeof id === "string") : turns.map((turn) => turn.sourceEventId),
    sealedAt: row.sealed_at,
    turnCount: row.turn_count,
    turns,
  };
}

function readSummary(value: unknown): LoopMinerSummary {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const row = raw as Partial<LoopMinerSummary>;
  const usage = row.usage && typeof row.usage === "object" && !Array.isArray(row.usage)
    ? row.usage as Partial<LoopMinerSummary["usage"]>
    : {};
  const phaseUsageRow = row.phaseUsage && typeof row.phaseUsage === "object" && !Array.isArray(row.phaseUsage)
    ? row.phaseUsage as Record<string, unknown>
    : {};
  const memorySelectionRow = raw.memorySelection && typeof raw.memorySelection === "object" && !Array.isArray(raw.memorySelection)
    ? raw.memorySelection as Record<string, unknown>
    : null;
  const patternTrace = raw.patternTrace && typeof raw.patternTrace === "object" && !Array.isArray(raw.patternTrace)
    ? raw.patternTrace as LoopMinerSummary["patternTrace"]
    : undefined;
  const memoryDecisionLog: LoopMinerMemoryDecision[] | undefined = Array.isArray(raw.memoryDecisionLog)
    ? raw.memoryDecisionLog
        .map((value): LoopMinerMemoryDecision | null => {
          const decision = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
          if (!decision || typeof decision.memoryId !== "string") return null;
          const status = decision.status === "included" || decision.status === "excluded" ? decision.status : "excluded";
          return {
            memoryId: decision.memoryId,
            status,
            reason: typeof decision.reason === "string" ? decision.reason : "unknown",
            contentPreview: typeof decision.contentPreview === "string" ? decision.contentPreview : "",
            createdAt: typeof decision.createdAt === "string" ? decision.createdAt : "",
            selectedAt: typeof decision.selectedAt === "string" ? decision.selectedAt : "",
            memoryType: typeof decision.memoryType === "string" ? decision.memoryType : "unknown",
            detectedMemoryType: typeof decision.detectedMemoryType === "string" ? decision.detectedMemoryType : null,
            category: typeof decision.category === "string" ? decision.category : null,
            cleanupBucket: typeof decision.cleanupBucket === "string" ? decision.cleanupBucket : null,
            isPinned: Boolean(decision.isPinned),
            sourceImport: Boolean(decision.sourceImport),
            sourcePlatform: typeof decision.sourcePlatform === "string" ? decision.sourcePlatform : null,
            sourceImportMode: typeof decision.sourceImportMode === "string" ? decision.sourceImportMode : null,
            sourceImportBatchId: typeof decision.sourceImportBatchId === "string" ? decision.sourceImportBatchId : null,
            sourceDateTime: typeof decision.sourceDateTime === "string" ? decision.sourceDateTime : null,
            observedAt: typeof decision.observedAt === "string" ? decision.observedAt : null,
            cleanupAppliedAt: typeof decision.cleanupAppliedAt === "string" ? decision.cleanupAppliedAt : null,
            cleanupAction: typeof decision.cleanupAction === "string" ? decision.cleanupAction : null,
            cleanupTargetMemoryId: typeof decision.cleanupTargetMemoryId === "string" ? decision.cleanupTargetMemoryId : null,
            cleanupSourceMemoryIds: Array.isArray(decision.cleanupSourceMemoryIds)
              ? decision.cleanupSourceMemoryIds.filter((id): id is string => typeof id === "string")
              : null,
            minerImportance: Number(decision.minerImportance ?? 0),
            memoryImportance: Number(decision.memoryImportance ?? 0),
          };
        })
        .filter((decision): decision is LoopMinerMemoryDecision => decision !== null)
    : undefined;
  const readPhase = (value: unknown) => {
    const phase = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      calls: Number(phase.calls ?? 0),
      promptTokens: Number(phase.promptTokens ?? 0),
      completionTokens: Number(phase.completionTokens ?? 0),
      totalTokens: Number(phase.totalTokens ?? 0),
      estimatedTotalTokens: Number(phase.estimatedTotalTokens ?? 0),
      estimatedCostUsd: Number(phase.estimatedCostUsd ?? 0),
      batchesProcessed: Number(phase.batchesProcessed ?? 0),
      batchesSkipped: Number(phase.batchesSkipped ?? 0),
      inputEvents: Number(phase.inputEvents ?? 0),
      outputEpisodes: Number(phase.outputEpisodes ?? 0),
      inputEpisodes: Number(phase.inputEpisodes ?? 0),
      loopsInput: Number(phase.loopsInput ?? 0),
      loopsOutput: Number(phase.loopsOutput ?? 0),
      tokensPerInputEvent: Number(phase.tokensPerInputEvent ?? 0),
      tokensPerOutputEpisode: Number(phase.tokensPerOutputEpisode ?? 0),
      costPerOutputEpisodeUsd: Number(phase.costPerOutputEpisodeUsd ?? 0),
      maxEstimatedPromptTokensPerCall: Number(phase.maxEstimatedPromptTokensPerCall ?? 0),
    };
  };
  return {
    episodesBuilt: Number(row.episodesBuilt ?? 0),
    loopsDetected: Number(row.loopsDetected ?? 0),
    loopsProposed: Number(row.loopsProposed ?? 0),
    loopsApproved: Number(row.loopsApproved ?? 0),
    loopsContested: Number(row.loopsContested ?? 0),
    loopsAutoApproved: Number(row.loopsAutoApproved ?? 0),
    loopsRejected: Number(row.loopsRejected ?? 0),
    cleanupEvidenceUsed: Number(row.cleanupEvidenceUsed ?? 0),
    cleanupSuppressedSeeds: Number(row.cleanupSuppressedSeeds ?? 0),
    timeSignalsUsed: Number(row.timeSignalsUsed ?? 0),
    loopsQualified: Number(row.loopsQualified ?? 0),
    suggestionsCreated: Number(row.suggestionsCreated ?? 0),
    durationMs: Number(row.durationMs ?? 0),
    aiCalls: Number(row.aiCalls ?? 0),
    usage: {
      calls: Number(usage.calls ?? 0),
      promptTokens: Number(usage.promptTokens ?? 0),
      completionTokens: Number(usage.completionTokens ?? 0),
      totalTokens: Number(usage.totalTokens ?? 0),
      estimatedPromptTokens: Number(usage.estimatedPromptTokens ?? 0),
      estimatedCompletionTokens: Number(usage.estimatedCompletionTokens ?? 0),
      estimatedTotalTokens: Number(usage.estimatedTotalTokens ?? 0),
      estimatedCostUsd: Number(usage.estimatedCostUsd ?? 0),
      models: usage.models && typeof usage.models === "object" && !Array.isArray(usage.models)
        ? Object.fromEntries(Object.entries(usage.models).map(([model, count]) => [model, Number(count ?? 0)]))
        : {},
    },
    skipped: typeof row.skipped === "boolean" ? row.skipped : undefined,
    skipReason: typeof row.skipReason === "string" ? row.skipReason : undefined,
    warnings: Array.isArray(row.warnings) ? row.warnings.filter((warning): warning is string => typeof warning === "string") : undefined,
    memorySelection: memorySelectionRow ? {
      considered: Number(memorySelectionRow.considered ?? 0),
      included: Number(memorySelectionRow.included ?? 0),
      excluded: Number(memorySelectionRow.excluded ?? 0),
      sourceImportsIncluded: Number(memorySelectionRow.sourceImportsIncluded ?? 0),
      unbucketedIncluded: Number(memorySelectionRow.unbucketedIncluded ?? 0),
      bucketedExcluded: Number(memorySelectionRow.bucketedExcluded ?? 0),
      decryptFailures: Number(memorySelectionRow.decryptFailures ?? 0),
      fallbackEventsAdded: Number(memorySelectionRow.fallbackEventsAdded ?? 0),
      fallbackEventsReplaced: Number(memorySelectionRow.fallbackEventsReplaced ?? 0),
      eventFeedAfterFallback: Number(memorySelectionRow.eventFeedAfterFallback ?? 0),
    } : undefined,
    memoryDecisionLog,
    patternTrace,
    phaseUsage: {
      episodeBuilder: phaseUsageRow.episodeBuilder ? readPhase(phaseUsageRow.episodeBuilder) : undefined,
      loopDetector: phaseUsageRow.loopDetector ? readPhase(phaseUsageRow.loopDetector) : undefined,
      loopEvaluator: phaseUsageRow.loopEvaluator ? readPhase(phaseUsageRow.loopEvaluator) : undefined,
      dnaGenerator: phaseUsageRow.dnaGenerator ? readPhase(phaseUsageRow.dnaGenerator) : undefined,
    },
  };
}

function mapSuggestion(row: WorkflowSuggestionRow): LoopMinerWorkflowSuggestionView {
  return {
    id: row.id,
    title: row.title,
    reason: row.reason,
    suggestedPrompt: row.suggested_prompt,
    status: "pending",
    confidence: Number(row.confidence),
    fingerprint: row.fingerprint,
    triggerCount: row.trigger_count,
    createdAt: row.created_at,
    metadata: row.metadata_json,
  };
}

export class LoopMinerRepository implements LoopMinerRepositoryContract {
  private episodeAugmentedColumnsAvailable: boolean | null = null;

  private async ensureEpisodeAugmentedColumns(): Promise<boolean> {
    if (this.episodeAugmentedColumnsAvailable === false) return false;
    try {
      await pool.query(`
        ALTER TABLE episodes
        ADD COLUMN IF NOT EXISTS source_fingerprint TEXT,
        ADD COLUMN IF NOT EXISTS extraction_version TEXT,
        ADD COLUMN IF NOT EXISTS embedding_text_hash TEXT,
        ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_episodes_source_fingerprint
          ON episodes(tenant_id, user_id, source_fingerprint, extraction_version, sealed_at DESC);
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_episodes_embedding_status
          ON episodes(tenant_id, user_id, embedding_status, sealed_at DESC);
      `);
      this.episodeAugmentedColumnsAvailable = true;
      return true;
    } catch {
      this.episodeAugmentedColumnsAvailable = false;
      return false;
    }
  }

  async hasRunningDailyRun(auth: AuthContext): Promise<boolean> {
    const result = await pool.query<{ id: string }>(
      `SELECT id
       FROM loop_miner_runs
       WHERE tenant_id = $1
         AND user_id = $2
         AND status = 'running'
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       LIMIT 1`,
      [auth.tenantId, auth.userId]
    );
    return result.rows.length > 0;
  }

  async hasCompletedDailyRunToday(auth: AuthContext): Promise<boolean> {
    const result = await pool.query<{ id: string }>(
      `SELECT id
       FROM loop_miner_runs
       WHERE tenant_id = $1
         AND user_id = $2
         AND status = 'completed'
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       LIMIT 1`,
      [auth.tenantId, auth.userId]
    );
    return result.rows.length > 0;
  }

  async createRun(input: { auth: AuthContext; runReason: LoopMinerRunReason }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO loop_miner_runs
       (id, tenant_id, user_id, status, summary_json)
       VALUES ($1, $2, $3, 'running', $4::jsonb)`,
      [
        id,
        input.auth.tenantId,
        input.auth.userId,
        JSON.stringify({ runReason: input.runReason }),
      ]
    );
    return id;
  }

  async completeRun(input: {
    auth: AuthContext;
    runId: string;
    status: "completed" | "failed";
    summary: LoopMinerSummary;
    error?: unknown;
  }): Promise<void> {
    await pool.query(
      `UPDATE loop_miner_runs
       SET status = $4,
           episodes_built = $5,
           loops_detected = $6,
           loops_qualified = $7,
           suggestions_created = $8,
           summary_json = $9::jsonb,
           error_json = $10::jsonb,
           completed_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3`,
      [
        input.runId,
        input.auth.tenantId,
        input.auth.userId,
        input.status,
        input.summary.episodesBuilt,
        input.summary.loopsDetected,
        input.summary.loopsQualified,
        input.summary.suggestionsCreated,
        JSON.stringify(input.summary),
        JSON.stringify(input.error ?? {}),
      ]
    );
  }

  async listRecentEvents(auth: AuthContext, days: number): Promise<MinerEvent[]> {
    const activityResult = await pool.query<AiActivityRow>(
      `SELECT id, source, activity_type, content_text, metadata_json, created_at
       FROM ai_activity_events
       WHERE tenant_id = $1
         AND user_id = $2
         AND created_at >= NOW() - ($3::text || ' days')::interval
       ORDER BY created_at ASC
       LIMIT 500`,
      [auth.tenantId, auth.userId, days]
    );

    const collabResult = await pool.query<CollabTaskRow>(
      `SELECT id, title, brief, state, last_actor, iteration, context, transcript, created_at, updated_at
       FROM collab_tasks
       WHERE tenant_id = $1
         AND user_id = $2
         AND created_at >= NOW() - ($3::text || ' days')::interval
       ORDER BY created_at ASC
       LIMIT 300`,
      [auth.tenantId, auth.userId, days]
    );

    const memoryResult = await pool.query<MemoryRecordEventRow>(
      `SELECT id, content_ciphertext, platform, memory_type, category, is_pinned, importance, summary_json, created_at
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND superseded_by IS NULL
         AND created_at >= NOW() - ($3::text || ' days')::interval
         AND (
           summary_json->>'source_import' = 'true'
           OR (
             memory_type IN ('fact', 'decision', 'preference')
             AND (
               NOT (summary_json ? 'cleanup_bucket')
               OR summary_json->>'cleanup_bucket' IN ('long_term', 'permanent')
             )
           )
         )
       ORDER BY
         CASE WHEN summary_json->>'source_import' = 'true' THEN 0 ELSE 1 END,
         created_at ASC
       LIMIT 300`,
      [auth.tenantId, auth.userId, days]
    );

    const activities: MinerEvent[] = activityResult.rows.map((row) => ({
      id: row.id,
      sourceEventType: "ai_activity_event",
      createdAt: row.created_at,
      platform: row.source,
      contentSummary: safeSummary(row.content_text),
      role: inferRole(row.metadata_json),
      metadata: {
        activityType: row.activity_type,
        metadata: row.metadata_json,
      },
    }));

    const collabTasks: MinerEvent[] = collabResult.rows.map((row) => ({
      id: row.id,
      sourceEventType: "collab_task",
      createdAt: row.created_at,
      platform: "tallei_collab",
      contentSummary: collabTaskSummary(row),
      role: "user",
      metadata: {
        state: row.state,
        lastActor: row.last_actor,
        iteration: row.iteration,
        updatedAt: row.updated_at,
      },
    }));

    const memoryEvents = memoryResult.rows
      .map((row) => memoryRecordSummary(row))
      .filter((event): event is MinerEvent => event !== null);

    return [...activities, ...collabTasks, ...memoryEvents].sort((a, b) => {
      const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      if (byTime !== 0) return byTime;
      const aImportance = readRecord(a.metadata).minerImportance;
      const bImportance = readRecord(b.metadata).minerImportance;
      return Number(bImportance ?? 0) - Number(aImportance ?? 0);
    });
  }

  async listMemoryDecisionLog(auth: AuthContext, days: number): Promise<LoopMinerMemoryDecision[]> {
    const result = await pool.query<MemoryRecordEventRow>(
      `SELECT id, content_ciphertext, platform, memory_type, category, is_pinned, importance, summary_json, created_at
       FROM memory_records
       WHERE tenant_id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND superseded_by IS NULL
         AND created_at >= NOW() - ($3::text || ' days')::interval
       ORDER BY
         CASE WHEN summary_json->>'source_import' = 'true' THEN 0 ELSE 1 END,
         CASE WHEN NOT (summary_json ? 'cleanup_bucket') THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 500`,
      [auth.tenantId, auth.userId, days]
    );
    return result.rows.map((row) => memoryDecisionForRow(row));
  }

  async createEpisode(input: {
    auth: AuthContext;
    runId: string;
    extraction: EpisodeExtraction;
    turns: EpisodeTurnRecord[];
    sourceFingerprint?: string;
    extractionVersion?: string;
  }): Promise<EpisodeRecord> {
    const client = await pool.connect();
    const episodeId = randomUUID();
    try {
      await client.query("BEGIN");
      const sealedAt = input.turns.map((turn) => turn.createdAt).sort().at(-1) ?? new Date().toISOString();
      let row;
      try {
        row = await client.query<EpisodeRow>(
          `INSERT INTO episodes
           (id, tenant_id, user_id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, miner_run_id, source_fingerprint, extraction_version, sealed_at)
           VALUES ($1, $2, $3, $4, $5::text[], $6, $7::text[], $8, $9, $10::jsonb, $11, $12, $13, $14::timestamptz)
           RETURNING id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, source_fingerprint, extraction_version, embedding_text_hash, embedding_status, embedded_at, sealed_at`,
          [
            episodeId,
            input.auth.tenantId,
            input.auth.userId,
            input.extraction.intent,
            input.extraction.sources,
            input.extraction.outputType,
            input.extraction.toolNames,
            input.turns.length,
            input.extraction.approved,
            JSON.stringify(input.extraction),
            input.runId,
            input.sourceFingerprint ?? null,
            input.extractionVersion ?? null,
            sealedAt,
          ]
        );
      } catch (error) {
        const upgraded = isMissingEpisodeAugmentedColumn(error) ? await this.ensureEpisodeAugmentedColumns() : false;
        if (upgraded) {
          row = await client.query<EpisodeRow>(
            `INSERT INTO episodes
             (id, tenant_id, user_id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, miner_run_id, source_fingerprint, extraction_version, sealed_at)
             VALUES ($1, $2, $3, $4, $5::text[], $6, $7::text[], $8, $9, $10::jsonb, $11, $12, $13, $14::timestamptz)
             RETURNING id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, source_fingerprint, extraction_version, embedding_text_hash, embedding_status, embedded_at, sealed_at`,
            [
              episodeId,
              input.auth.tenantId,
              input.auth.userId,
              input.extraction.intent,
              input.extraction.sources,
              input.extraction.outputType,
              input.extraction.toolNames,
              input.turns.length,
              input.extraction.approved,
              JSON.stringify(input.extraction),
              input.runId,
              input.sourceFingerprint ?? null,
              input.extractionVersion ?? null,
              sealedAt,
            ]
          );
        } else {
          row = await client.query<EpisodeRow>(
            `INSERT INTO episodes
             (id, tenant_id, user_id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, miner_run_id, sealed_at)
             VALUES ($1, $2, $3, $4, $5::text[], $6, $7::text[], $8, $9, $10::jsonb, $11, $12::timestamptz)
             RETURNING id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json,
                       NULL::text AS source_fingerprint,
                       NULL::text AS extraction_version,
                       NULL::text AS embedding_text_hash,
                       'pending'::text AS embedding_status,
                       NULL::timestamptz AS embedded_at,
                       sealed_at`,
            [
              episodeId,
              input.auth.tenantId,
              input.auth.userId,
              input.extraction.intent,
              input.extraction.sources,
              input.extraction.outputType,
              input.extraction.toolNames,
              input.turns.length,
              input.extraction.approved,
              JSON.stringify(input.extraction),
              input.runId,
              sealedAt,
            ]
          );
        }
      }

      for (const turn of input.turns) {
        await client.query(
          `INSERT INTO episode_turns
           (id, episode_id, role, content_summary, source_event_type, source_event_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
          [
            randomUUID(),
            episodeId,
            turn.role,
            turn.contentSummary,
            turn.sourceEventType,
            turn.sourceEventId,
            turn.createdAt,
          ]
        );
      }

      await client.query("COMMIT");
      return mapEpisode(row.rows[0], input.turns);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async findReusableEpisodeBySourceFingerprint(input: {
    auth: AuthContext;
    sourceFingerprint: string;
    extractionVersion: string;
  }): Promise<EpisodeRecord | null> {
    let row;
    try {
      row = await pool.query<EpisodeRow>(
        `SELECT id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, source_fingerprint, extraction_version, embedding_text_hash, embedding_status, embedded_at, sealed_at
         FROM episodes
         WHERE tenant_id = $1
           AND user_id = $2
           AND source_fingerprint = $3
           AND extraction_version = $4
         ORDER BY sealed_at DESC
         LIMIT 1`,
        [input.auth.tenantId, input.auth.userId, input.sourceFingerprint, input.extractionVersion]
      );
    } catch (error) {
      const upgraded = isMissingEpisodeAugmentedColumn(error) ? await this.ensureEpisodeAugmentedColumns() : false;
      if (!upgraded) return null;
      row = await pool.query<EpisodeRow>(
        `SELECT id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, source_fingerprint, extraction_version, embedding_text_hash, embedding_status, embedded_at, sealed_at
         FROM episodes
         WHERE tenant_id = $1
           AND user_id = $2
           AND source_fingerprint = $3
           AND extraction_version = $4
         ORDER BY sealed_at DESC
         LIMIT 1`,
        [input.auth.tenantId, input.auth.userId, input.sourceFingerprint, input.extractionVersion]
      );
    }
    const episode = row.rows[0];
    if (!episode) return null;
    const turns = await pool.query<EpisodeTurnRow>(
      `SELECT episode_id, role, content_summary, source_event_type, source_event_id, created_at
       FROM episode_turns
       WHERE episode_id = $1
       ORDER BY created_at ASC`,
      [episode.id]
    );
    return mapEpisode(episode, turns.rows.map((turn) => ({
      role: turn.role,
      contentSummary: turn.content_summary,
      sourceEventType: turn.source_event_type,
      sourceEventId: turn.source_event_id,
      createdAt: turn.created_at,
    })));
  }

  async updateEpisodeEmbeddingMetadata(input: {
    auth: AuthContext;
    episodeId: string;
    embeddingTextHash: string;
    status: "pending" | "ready" | "failed";
    embeddedAt?: string | null;
  }): Promise<void> {
    try {
      await pool.query(
        `UPDATE episodes
         SET embedding_text_hash = $4,
             embedding_status = $5,
             embedded_at = $6::timestamptz
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3`,
        [
          input.episodeId,
          input.auth.tenantId,
          input.auth.userId,
          input.embeddingTextHash,
          input.status,
          input.embeddedAt ?? null,
        ]
      );
    } catch (error) {
      const upgraded = isMissingEpisodeAugmentedColumn(error) ? await this.ensureEpisodeAugmentedColumns() : false;
      if (!upgraded) return;
      await pool.query(
        `UPDATE episodes
         SET embedding_text_hash = $4,
             embedding_status = $5,
             embedded_at = $6::timestamptz
         WHERE id = $1
           AND tenant_id = $2
           AND user_id = $3`,
        [
          input.episodeId,
          input.auth.tenantId,
          input.auth.userId,
          input.embeddingTextHash,
          input.status,
          input.embeddedAt ?? null,
        ]
      );
    }
  }

  async listEpisodeContext(auth: AuthContext, episodeIds: string[]): Promise<EpisodeRecord[]> {
    if (episodeIds.length === 0) return [];
    let episodes;
    try {
      episodes = await pool.query<EpisodeRow>(
        `SELECT id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, source_fingerprint, extraction_version, embedding_text_hash, embedding_status, embedded_at, sealed_at
         FROM episodes
         WHERE tenant_id = $1
           AND user_id = $2
           AND id = ANY($3::uuid[])
         ORDER BY sealed_at ASC`,
        [auth.tenantId, auth.userId, episodeIds]
      );
    } catch (error) {
      const upgraded = isMissingEpisodeAugmentedColumn(error) ? await this.ensureEpisodeAugmentedColumns() : false;
      if (upgraded) {
        episodes = await pool.query<EpisodeRow>(
          `SELECT id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, source_fingerprint, extraction_version, embedding_text_hash, embedding_status, embedded_at, sealed_at
           FROM episodes
           WHERE tenant_id = $1
             AND user_id = $2
             AND id = ANY($3::uuid[])
           ORDER BY sealed_at ASC`,
          [auth.tenantId, auth.userId, episodeIds]
        );
      } else {
        episodes = await pool.query<EpisodeRow>(
          `SELECT id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json,
                  NULL::text AS source_fingerprint,
                  NULL::text AS extraction_version,
                  NULL::text AS embedding_text_hash,
                  'pending'::text AS embedding_status,
                  NULL::timestamptz AS embedded_at,
                  sealed_at
           FROM episodes
           WHERE tenant_id = $1
             AND user_id = $2
             AND id = ANY($3::uuid[])
           ORDER BY sealed_at ASC`,
          [auth.tenantId, auth.userId, episodeIds]
        );
      }
    }
    const turns = await pool.query<EpisodeTurnRow>(
      `SELECT episode_id, role, content_summary, source_event_type, source_event_id, created_at
       FROM episode_turns
       WHERE episode_id = ANY($1::uuid[])
       ORDER BY created_at ASC`,
      [episodeIds]
    );
    const turnsByEpisode = new Map<string, EpisodeTurnRecord[]>();
    for (const turn of turns.rows) {
      const current = turnsByEpisode.get(turn.episode_id) ?? [];
      current.push({
        role: turn.role,
        contentSummary: turn.content_summary,
        sourceEventType: turn.source_event_type,
        sourceEventId: turn.source_event_id,
        createdAt: turn.created_at,
      });
      turnsByEpisode.set(turn.episode_id, current);
    }
    return episodes.rows.map((row) => mapEpisode(row, turnsByEpisode.get(row.id) ?? []));
  }

  async createWorkflowSuggestion(input: {
    auth: AuthContext;
    runId: string;
    candidateLoop: CandidateLoop;
    evaluation: LoopEvaluation;
    dna: WorkflowDNA;
    suggestedPrompt: string;
    fingerprint: string;
  }): Promise<LoopMinerSuggestion | null> {
    const existingPending = await pool.query<{ id: string }>(
      `SELECT id
       FROM workflow_suggestions
       WHERE tenant_id = $1
         AND user_id = $2
         AND fingerprint = $3
         AND status = 'pending'
       LIMIT 1`,
      [input.auth.tenantId, input.auth.userId, input.fingerprint]
    );
    if (existingPending.rows.length > 0) return null;

    const existingWorkflow = await pool.query<{ id: string }>(
      `SELECT id
       FROM workflows
       WHERE tenant_id = $1
         AND user_id = $2
         AND fingerprint = $3
         AND status IN ('active', 'paused')
       LIMIT 1`,
      [input.auth.tenantId, input.auth.userId, input.fingerprint]
    );
    if (existingWorkflow.rows.length > 0) return null;

    const dismissedCooldown = await pool.query<{ id: string }>(
      `SELECT id
       FROM workflow_suggestions
       WHERE tenant_id = $1
         AND user_id = $2
         AND fingerprint = $3
         AND status = 'dismissed'
         AND updated_at >= NOW() - interval '60 days'
       LIMIT 1`,
      [input.auth.tenantId, input.auth.userId, input.fingerprint]
    );
    if (dismissedCooldown.rows.length > 0) return null;

    const id = randomUUID();
    const title = input.dna.name.slice(0, 120);
    const reason = input.evaluation.reasoning.slice(0, 1000);
    const createdAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO workflow_suggestions
       (id, tenant_id, user_id, fingerprint, title, reason, suggested_prompt, status, confidence, trigger_count, source, metadata_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, 'loop_miner', $10::jsonb, $11::timestamptz, $11::timestamptz)`,
      [
        id,
        input.auth.tenantId,
        input.auth.userId,
        input.fingerprint,
        title,
        reason,
        input.suggestedPrompt,
        input.evaluation.confidence,
        input.evaluation.episodeIds.length,
        JSON.stringify({
          loopMinerRunId: input.runId,
          dna: input.dna,
          evaluation: input.evaluation,
          candidateLoop: input.candidateLoop,
          episodeIds: input.evaluation.episodeIds,
          metadataHash: createHash("sha256").update(JSON.stringify(input.dna)).digest("hex"),
        }),
        createdAt,
      ]
    );

    return {
      id,
      title,
      reason,
      suggestedPrompt: input.suggestedPrompt,
      status: "pending",
      confidence: input.evaluation.confidence,
      fingerprint: input.fingerprint,
      triggerCount: input.evaluation.episodeIds.length,
      createdAt,
    };
  }

  async listRunViews(auth: AuthContext, limit = 10): Promise<LoopMinerRunView[]> {
    const result = await pool.query<LoopMinerRunRow>(
      `SELECT id, status, summary_json, error_json, created_at, completed_at
       FROM loop_miner_runs
       WHERE tenant_id = $1
         AND user_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [auth.tenantId, auth.userId, limit]
    );

    return Promise.all(result.rows.map((row) => this.getRunView(auth, row.id))).then((runs) =>
      runs.filter((run): run is LoopMinerRunView => Boolean(run))
    );
  }

  async getRunView(auth: AuthContext, runId: string): Promise<LoopMinerRunView | null> {
    const runResult = await pool.query<LoopMinerRunRow>(
      `SELECT id, status, summary_json, error_json, created_at, completed_at
       FROM loop_miner_runs
       WHERE id = $1
         AND tenant_id = $2
         AND user_id = $3
       LIMIT 1`,
      [runId, auth.tenantId, auth.userId]
    );
    const run = runResult.rows[0];
    if (!run) return null;

    let episodeRows;
    try {
      episodeRows = await pool.query<EpisodeRow>(
        `SELECT id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, source_fingerprint, extraction_version, embedding_text_hash, embedding_status, embedded_at, sealed_at
         FROM episodes
         WHERE tenant_id = $1
           AND user_id = $2
           AND miner_run_id = $3
         ORDER BY sealed_at ASC`,
        [auth.tenantId, auth.userId, runId]
      );
    } catch (error) {
      const upgraded = isMissingEpisodeAugmentedColumn(error) ? await this.ensureEpisodeAugmentedColumns() : false;
      if (upgraded) {
        episodeRows = await pool.query<EpisodeRow>(
          `SELECT id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json, source_fingerprint, extraction_version, embedding_text_hash, embedding_status, embedded_at, sealed_at
           FROM episodes
           WHERE tenant_id = $1
             AND user_id = $2
             AND miner_run_id = $3
           ORDER BY sealed_at ASC`,
          [auth.tenantId, auth.userId, runId]
        );
      } else {
        episodeRows = await pool.query<EpisodeRow>(
          `SELECT id, intent, sources, output_type, tool_names, turn_count, approved, extraction_json,
                  NULL::text AS source_fingerprint,
                  NULL::text AS extraction_version,
                  NULL::text AS embedding_text_hash,
                  'pending'::text AS embedding_status,
                  NULL::timestamptz AS embedded_at,
                  sealed_at
           FROM episodes
           WHERE tenant_id = $1
             AND user_id = $2
             AND miner_run_id = $3
           ORDER BY sealed_at ASC`,
          [auth.tenantId, auth.userId, runId]
        );
      }
    }
    const episodeIds = episodeRows.rows.map((episode) => episode.id);
    const turnRows = episodeIds.length === 0
      ? { rows: [] as EpisodeTurnRow[] }
      : await pool.query<EpisodeTurnRow>(
          `SELECT episode_id, role, content_summary, source_event_type, source_event_id, created_at
           FROM episode_turns
           WHERE episode_id = ANY($1::uuid[])
           ORDER BY created_at ASC`,
          [episodeIds]
        );
    const turnsByEpisode = new Map<string, EpisodeTurnRecord[]>();
    for (const turn of turnRows.rows) {
      const current = turnsByEpisode.get(turn.episode_id) ?? [];
      current.push({
        role: turn.role,
        contentSummary: turn.content_summary,
        sourceEventType: turn.source_event_type,
        sourceEventId: turn.source_event_id,
        createdAt: turn.created_at,
      });
      turnsByEpisode.set(turn.episode_id, current);
    }

    const suggestions = await pool.query<WorkflowSuggestionRow>(
      `SELECT id, title, reason, suggested_prompt, confidence, fingerprint, trigger_count, created_at, metadata_json
       FROM workflow_suggestions
       WHERE tenant_id = $1
         AND user_id = $2
         AND source = 'loop_miner'
         AND metadata_json->>'loopMinerRunId' = $3
       ORDER BY created_at ASC`,
      [auth.tenantId, auth.userId, runId]
    );

    return {
      id: run.id,
      status: run.status,
      summary: readSummary(run.summary_json),
      error: run.error_json,
      createdAt: run.created_at,
      completedAt: run.completed_at,
      episodes: episodeRows.rows.map((episode) => mapEpisode(episode, turnsByEpisode.get(episode.id) ?? [])),
      suggestions: suggestions.rows.map(mapSuggestion),
    };
  }
}
