import { randomUUID } from "crypto";

import { config } from "../../config/index.js";
import { embedText } from "../../infrastructure/cache/embedding-cache.js";
import { encryptMemoryContent, hashMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import type { ExtractedFact } from "../../orchestration/ai/fact-extract.usecase.js";
import { summarizeConversation, type ConversationSummary } from "../../orchestration/ai/summarize.usecase.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { classifyMemory } from "./memory-classification.js";
import { normalizeMemoryType, type MemoryType } from "./memory-types.js";

export interface SaveMemoryResult {
  memoryId: string;
  title: string;
  summary: ConversationSummary;
  deduped?: boolean;
}

interface RequestTimingValues {
  [key: string]: string | number | boolean | null | undefined;
}

interface SaveMemoryUseCaseDeps {
  readonly consumeMonthlySaveQuota: (auth: AuthContext) => Promise<number>;
  readonly memoryRepository: {
    create(auth: AuthContext, input: {
      id: string;
      contentCiphertext: string;
      contentHash: string;
      platform: string;
      summaryJson: unknown;
      qdrantPointId: string;
      memoryType?: string;
      category?: string | null;
      isPinned?: boolean;
      referenceCount?: number;
      lastReferencedAt?: string | null;
    }): Promise<void>;
    findActiveByContentHash(auth: AuthContext, contentHash: string): Promise<{
      id: string;
      summary_json: unknown;
    } | null>;
    incrementReferenceScoped(auth: AuthContext, memoryId: string, delta?: number, referencedAtIso?: string): Promise<boolean>;
    updateContentAndSummaryScoped(auth: AuthContext, memoryId: string, input: {
      contentCiphertext: string;
      contentHash: string;
      summaryJson: unknown;
    }): Promise<unknown>;
    softDeleteScoped(auth: AuthContext, memoryId: string): Promise<unknown>;
    markSupersededPreferences(auth: AuthContext, input: {
      supersededById: string;
      preferenceKey?: string | null;
      category?: string | null;
      excludeContentHash?: string;
    }): Promise<string[]>;
    getByIds(auth: AuthContext, ids: string[], includeSuperseded?: boolean): Promise<Array<{
      id: string;
      memory_type: string;
    }>>;
    logEvent(input: {
      auth: AuthContext;
      action: string;
      memoryId?: string;
      ipHash?: string | null;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  readonly vectorRepository: {
    upsertMemoryVector(input: {
      auth: AuthContext;
      memoryId: string;
      pointId: string;
      vector: number[];
      platform: string;
      createdAt: string;
    }): Promise<unknown>;
    searchVectors(auth: AuthContext, queryVector: number[], limit: number): Promise<Array<{
      memoryId: string;
      score: number;
    }>>;
  };
  readonly shouldBypassVector: () => boolean;
  readonly noteVectorFailure: (error: unknown, context: string) => void;
  readonly noteMemoryDbFailure: (error: unknown, context: string) => void;
  readonly setRequestTimingFields: (fields: RequestTimingValues) => void;
  readonly invalidateRecallCache: (auth: AuthContext) => void;
  readonly invalidateBm25Cache: (auth: AuthContext) => void;
  readonly bumpRecallStamp: (auth: AuthContext) => Promise<void>;
  readonly ipHash: (ip?: string) => string | null;
  readonly createQuotaExceededError: (message: string) => Error;
  readonly extractFacts: (content: string) => Promise<ExtractedFact[]>;
  readonly isEvalMode: boolean;
  readonly freeSaveLimit: number;
}

export interface SaveMemoryUseCaseInput {
  readonly content: string;
  readonly auth: AuthContext;
  readonly platform: string;
  readonly requesterIp?: string;
  readonly memoryType?: MemoryType;
  readonly category?: string | null;
  readonly isPinned?: boolean;
  readonly preferenceKey?: string | null;
  readonly runFactExtraction?: boolean;
}

const DEFAULT_MEMORY_EMBED_TIMEOUT_MS = config.nodeEnv === "production" ? 4_000 : 2_500;
const MEMORY_EMBED_TIMEOUT_MS = Math.max(DEFAULT_MEMORY_EMBED_TIMEOUT_MS, config.memoryRecallEmbedTimeoutMs);
const MEMORY_VECTOR_UPSERT_TIMEOUT_MS = config.memoryVectorUpsertTimeoutMs;
const SUMMARY_TIMEOUT_MS = config.nodeEnv === "production" ? 3_200 : 2_000;
const DEDUP_VECTOR_LIMIT = 8;
const DEDUP_VECTOR_SIMILARITY_THRESHOLD = 0.92;
const MEMORY_EMBED_MAX_CHARS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function buildFallbackSummary(rawContent: string): ConversationSummary {
  const cleaned = rawContent.trim().replace(/\s+/g, " ");
  const snippet = cleaned.slice(0, 180);
  return {
    title: snippet.length > 0 ? snippet : "Untitled Memory",
    keyPoints: snippet.length > 0 ? [snippet] : [],
    decisions: [],
    summary: snippet.length > 0 ? snippet : "No summary available.",
    memory_type: "fact",
    category: null,
    is_pinned_suggested: false,
    preference_key: null,
  };
}

function summaryFromRow(summaryJson: unknown, rawContent: string): ConversationSummary {
  if (!summaryJson || typeof summaryJson !== "object") return buildFallbackSummary(rawContent);
  const summary = summaryJson as Partial<ConversationSummary>;
  const fallback = buildFallbackSummary(rawContent);
  return {
    title: typeof summary.title === "string" ? summary.title : fallback.title,
    keyPoints: Array.isArray(summary.keyPoints)
      ? summary.keyPoints.filter((value): value is string => typeof value === "string").slice(0, 5)
      : fallback.keyPoints,
    decisions: Array.isArray(summary.decisions)
      ? summary.decisions.filter((value): value is string => typeof value === "string").slice(0, 3)
      : fallback.decisions,
    summary: typeof summary.summary === "string" ? summary.summary : fallback.summary,
    memory_type: summary.memory_type,
    category: typeof summary.category === "string" ? summary.category : null,
    is_pinned_suggested: Boolean(summary.is_pinned_suggested),
    preference_key: typeof summary.preference_key === "string" ? summary.preference_key : null,
  };
}

function buildMemoryText(
  platform: string,
  summary: ConversationSummary,
  rawContent: string,
  memoryType: MemoryType
): string {
  if (memoryType === "preference") {
    return rawContent.trim();
  }
  return [
    `[${platform.toUpperCase()}] ${summary.title}`,
    summary.keyPoints.length > 0 ? `Key Points: ${summary.keyPoints.join("; ")}` : "",
    summary.decisions.length > 0 ? `Decisions: ${summary.decisions.join("; ")}` : "",
    `Summary: ${summary.summary}`,
    `Raw: ${rawContent.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildEmbeddingText(platform: string, rawContent: string): string {
  const compact = rawContent.trim().replace(/\s+/g, " ");
  const clipped = compact.length > MEMORY_EMBED_MAX_CHARS
    ? compact.slice(0, MEMORY_EMBED_MAX_CHARS)
    : compact;
  return `[${platform.toUpperCase()}]\n${clipped}`;
}

export class SaveMemoryUseCase {
  private readonly deps: SaveMemoryUseCaseDeps;

  constructor(deps: SaveMemoryUseCaseDeps) {
    this.deps = deps;
  }

  private invalidateRecallArtifacts(auth: AuthContext): void {
    this.deps.invalidateRecallCache(auth);
    this.deps.invalidateBm25Cache(auth);
    void this.deps.bumpRecallStamp(auth).catch(() => {});
  }

  private async dedupeByVector(
    input: SaveMemoryUseCaseInput,
    classificationType: MemoryType
  ): Promise<{ memoryId: string } | null> {
    if (classificationType === "preference") return null;
    if (this.deps.shouldBypassVector()) return null;

    let vector: number[] | null = null;
    try {
      if (!vector) {
        vector = await withTimeout(
          embedText(buildEmbeddingText(input.platform, input.content.trim())),
          MEMORY_EMBED_TIMEOUT_MS,
          "save.embed.dedup"
        );
      }
      const hits = await withTimeout(
        this.deps.vectorRepository.searchVectors(input.auth, vector, DEDUP_VECTOR_LIMIT),
        MEMORY_VECTOR_UPSERT_TIMEOUT_MS,
        "save.search.dedup"
      );
      const strongHit = hits.find((candidate) => candidate.score >= DEDUP_VECTOR_SIMILARITY_THRESHOLD);
      if (!strongHit) return null;
      const scopedRows = await this.deps.memoryRepository.getByIds(input.auth, [strongHit.memoryId], false);
      const row = scopedRows[0];
      if (!row || row.memory_type !== classificationType) return null;
      await this.deps.memoryRepository.incrementReferenceScoped(input.auth, row.id);
      return { memoryId: row.id };
    } catch (error) {
      this.deps.noteVectorFailure(error, "save-dedup-vector");
      return null;
    }
  }

  async execute(input: SaveMemoryUseCaseInput): Promise<SaveMemoryResult> {
    const saveStartedAt = process.hrtime.bigint();
    const normalizedContent = input.content.trim();
    const contentHash = hashMemoryContent(normalizedContent);
    const createdAt = new Date().toISOString();

    const exactDuplicate = await this.deps.memoryRepository.findActiveByContentHash(input.auth, contentHash);
    if (exactDuplicate) {
      await this.deps.memoryRepository.incrementReferenceScoped(input.auth, exactDuplicate.id);
      this.invalidateRecallArtifacts(input.auth);
      const summary = summaryFromRow(exactDuplicate.summary_json, normalizedContent);
      return {
        memoryId: exactDuplicate.id,
        title: summary.title,
        summary,
        deduped: true,
      };
    }

    let summary: ConversationSummary = buildFallbackSummary(normalizedContent);
    let summaryFromModel = false;
    let summaryMs = 0;
    if (!this.deps.isEvalMode) {
      try {
        const summaryStartedAt = process.hrtime.bigint();
        summary = await withTimeout(
          summarizeConversation(normalizedContent),
          SUMMARY_TIMEOUT_MS,
          "save.summary"
        );
        summaryMs = Number(process.hrtime.bigint() - summaryStartedAt) / 1_000_000;
        summaryFromModel = true;
      } catch {
        summary = buildFallbackSummary(normalizedContent);
      }
    }

    const classified = classifyMemory(normalizedContent, {
      memory_type: summary.memory_type,
      category: summary.category,
      is_pinned_suggested: summary.is_pinned_suggested,
    });

    const memoryType = normalizeMemoryType(input.memoryType, classified.memoryType);
    const category = input.category ?? classified.category;
    const isPinned = typeof input.isPinned === "boolean"
      ? input.isPinned || memoryType === "preference"
      : (classified.isPinned || memoryType === "preference");
    const preferenceKey = input.preferenceKey ?? summary.preference_key ?? classified.preferenceKey;

    const summaryForStorage: ConversationSummary & { provenance?: { platform: string; written_at: string } } = {
      ...summary,
      memory_type: memoryType,
      category,
      is_pinned_suggested: isPinned,
      preference_key: preferenceKey,
      provenance: {
        platform: input.platform,
        written_at: createdAt,
      },
    };

    const vectorDuplicate = await this.dedupeByVector(input, memoryType);
    if (vectorDuplicate) {
      this.invalidateRecallArtifacts(input.auth);
      return {
        memoryId: vectorDuplicate.memoryId,
        title: summaryForStorage.title,
        summary: summaryForStorage,
        deduped: true,
      };
    }

    const memoryId = randomUUID();
    const memoryText = buildMemoryText(input.platform, summaryForStorage, normalizedContent, memoryType);

    const encryptStartedAt = process.hrtime.bigint();
    const encrypted = encryptMemoryContent(memoryText);
    const encryptMs = Number(process.hrtime.bigint() - encryptStartedAt) / 1_000_000;

    const quotaPromise = (async () => {
      const startedAt = process.hrtime.bigint();
      const count = await this.deps.consumeMonthlySaveQuota(input.auth);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      return { count, elapsedMs };
    })();

    const insertPromise = (async () => {
      const startedAt = process.hrtime.bigint();
      await this.deps.memoryRepository.create(input.auth, {
        id: memoryId,
        contentCiphertext: encrypted,
        contentHash,
        platform: input.platform,
        summaryJson: summaryForStorage,
        qdrantPointId: memoryId,
        memoryType,
        category,
        isPinned,
        referenceCount: 1,
        lastReferencedAt: null,
      });
      return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    })();

    const [quotaOutcome, insertOutcome] = await Promise.allSettled([quotaPromise, insertPromise]);
    if (insertOutcome.status === "rejected") {
      throw insertOutcome.reason;
    }

    const insertMs = insertOutcome.value;
    const quotaMs = quotaOutcome.status === "fulfilled" ? quotaOutcome.value.elapsedMs : 0;
    const quotaCount = quotaOutcome.status === "fulfilled" ? quotaOutcome.value.count : 0;
    const quotaMode = this.deps.isEvalMode
      ? "bypassed_eval"
      : input.auth.plan === "free"
        ? (quotaOutcome.status === "fulfilled" ? "redis" : "fail_open")
        : "skipped";

    if (input.auth.plan === "free" && quotaCount > this.deps.freeSaveLimit) {
      await this.deps.memoryRepository.softDeleteScoped(input.auth, memoryId).catch((error) => {
        this.deps.noteMemoryDbFailure(error, "save-quota-soft-delete");
      });
      throw this.deps.createQuotaExceededError(
        `Free plan limit reached: ${this.deps.freeSaveLimit} saves/month. Upgrade to Pro at tallei.app/dashboard/billing.`
      );
    }

    if (memoryType === "preference" && (preferenceKey || category)) {
      await this.deps.memoryRepository.markSupersededPreferences(input.auth, {
        supersededById: memoryId,
        preferenceKey,
        category,
        excludeContentHash: contentHash,
      }).catch((error) => {
        this.deps.noteMemoryDbFailure(error, "save-preference-supersede");
      });
    }

    const saveTotalMs = Number(process.hrtime.bigint() - saveStartedAt) / 1_000_000;
    this.deps.setRequestTimingFields({
      save_summary_ms: summaryFromModel ? summaryMs : 0,
      save_quota_ms: quotaMs,
      save_encrypt_ms: encryptMs,
      save_insert_ms: insertMs,
      save_db_write_ms: insertMs,
      save_service_ms: saveTotalMs,
      save_quota_mode: quotaMode,
      save_vector_mode: this.deps.shouldBypassVector() ? "bypass" : "background",
      save_memory_type: memoryType,
      save_memory_pinned: isPinned,
    });

    void (async () => {
      const embedAndUpsert = async () => {
        if (this.deps.shouldBypassVector()) return;
        try {
          const vector = await withTimeout(
            embedText(buildEmbeddingText(input.platform, normalizedContent)),
            MEMORY_EMBED_TIMEOUT_MS,
            "save.embed"
          );
          await withTimeout(
            this.deps.vectorRepository.upsertMemoryVector({
              auth: input.auth,
              memoryId,
              pointId: memoryId,
              vector,
              platform: input.platform,
              createdAt,
            }),
            MEMORY_VECTOR_UPSERT_TIMEOUT_MS,
            "save.upsert"
          );
        } catch (error) {
          this.deps.noteVectorFailure(error, "save_bg");
        }
      };

      const extractAndSaveFacts = async () => {
        if (input.runFactExtraction === false) return;
        try {
          const facts = await this.deps.extractFacts(normalizedContent);
          for (const fact of facts) {
            try {
              const factText = `[FACT] ${fact.text}${fact.temporal_context ? ` (${fact.temporal_context})` : ""}`;
              const factEncrypted = encryptMemoryContent(factText);
              const factHash = hashMemoryContent(factText);
              const factId = randomUUID();
              await this.deps.memoryRepository.create(input.auth, {
                id: factId,
                contentCiphertext: factEncrypted,
                contentHash: factHash,
                platform: `fact:${input.platform}`,
                summaryJson: { source: "extracted_fact", subject: fact.subject, supersedes: fact.supersedes_pattern },
                qdrantPointId: factId,
                memoryType: "fact",
                category: "fact_extract",
                isPinned: false,
              });
              const factVector = await embedText(factText).catch(() => null);
              if (factVector) {
                await this.deps.vectorRepository.upsertMemoryVector({
                  auth: input.auth,
                  memoryId: factId,
                  pointId: factId,
                  vector: factVector,
                  platform: `fact:${input.platform}`,
                  createdAt: new Date().toISOString(),
                }).catch(() => {});
              }
            } catch {
              // Best-effort; fact save failures don't block the primary memory.
            }
          }
          this.deps.invalidateBm25Cache(input.auth);
        } catch {
          // Best-effort; fact extraction failures don't block the primary memory.
        }
      };

      await Promise.allSettled([
        embedAndUpsert(),
        extractAndSaveFacts(),
      ]);
    })();

    void this.deps.memoryRepository.logEvent({
      auth: input.auth,
      action: "save",
      memoryId,
      ipHash: this.deps.ipHash(input.requesterIp),
      metadata: {
        platform: input.platform,
        memory_type: memoryType,
        category,
        is_pinned: isPinned,
        preference_key: preferenceKey,
      },
    }).catch((error) => {
      this.deps.noteMemoryDbFailure(error, "save-log");
    });

    this.invalidateRecallArtifacts(input.auth);

    return {
      memoryId,
      title: summaryForStorage.title,
      summary: summaryForStorage,
    };
  }
}
