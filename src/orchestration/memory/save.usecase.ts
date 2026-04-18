import { randomUUID } from "crypto";

import { config } from "../../config/index.js";
import { embedText } from "../../infrastructure/cache/embedding-cache.js";
import { encryptMemoryContent, hashMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { extractFacts } from "../../orchestration/ai/fact-extract.usecase.js";
import { summarizeConversation, type ConversationSummary } from "../../orchestration/ai/summarize.usecase.js";
import type { AuthContext } from "../../domain/auth/index.js";

export interface SaveMemoryResult {
  memoryId: string;
  title: string;
  summary: ConversationSummary;
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
    }): Promise<void>;
    updateContentAndSummaryScoped(auth: AuthContext, memoryId: string, input: {
      contentCiphertext: string;
      contentHash: string;
      summaryJson: unknown;
    }): Promise<unknown>;
    softDeleteScoped(auth: AuthContext, memoryId: string): Promise<unknown>;
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
  };
  readonly shouldBypassVector: () => boolean;
  readonly noteVectorFailure: (error: unknown, context: string) => void;
  readonly noteMemoryDbFailure: (error: unknown, context: string) => void;
  readonly setRequestTimingFields: (fields: RequestTimingValues) => void;
  readonly enqueueGraphExtractionJob: (auth: AuthContext, memoryId: string) => Promise<void>;
  readonly invalidateRecallCache: (auth: AuthContext) => void;
  readonly invalidateRecallV2Cache: (auth: AuthContext) => void;
  readonly invalidateBm25Cache: (auth: AuthContext) => void;
  readonly bumpRecallStamp: (auth: AuthContext) => Promise<void>;
  readonly markSnapshotStale: (auth: AuthContext) => Promise<void>;
  readonly queueSnapshotRefresh: (auth: AuthContext, reason: string, delayMs: number) => Promise<void>;
  readonly ipHash: (ip?: string) => string | null;
  readonly createQuotaExceededError: (message: string) => Error;
  readonly isEvalMode: boolean;
  readonly freeSaveLimit: number;
}

export interface SaveMemoryUseCaseInput {
  readonly content: string;
  readonly auth: AuthContext;
  readonly platform: string;
  readonly requesterIp?: string;
}

const MEMORY_EMBED_TIMEOUT_MS = config.nodeEnv === "production" ? 4_000 : 2_500;
const MEMORY_VECTOR_UPSERT_TIMEOUT_MS = config.memoryVectorUpsertTimeoutMs;

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
  };
}

function buildMemoryText(platform: string, summary: ConversationSummary, rawContent: string): string {
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
  return `[${platform.toUpperCase()}]\n${rawContent.trim()}`;
}

export class SaveMemoryUseCase {
  private readonly deps: SaveMemoryUseCaseDeps;

  constructor(deps: SaveMemoryUseCaseDeps) {
    this.deps = deps;
  }

  async execute(input: SaveMemoryUseCaseInput): Promise<SaveMemoryResult> {
    const saveStartedAt = process.hrtime.bigint();
    const normalizedContent = input.content.trim();
    const summary = buildFallbackSummary(normalizedContent);
    const memoryId = randomUUID();
    const createdAt = new Date().toISOString();

    const encryptStartedAt = process.hrtime.bigint();
    const encrypted = encryptMemoryContent(normalizedContent);
    const contentHash = hashMemoryContent(normalizedContent);
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
        summaryJson: summary,
        qdrantPointId: memoryId,
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

    const saveTotalMs = Number(process.hrtime.bigint() - saveStartedAt) / 1_000_000;
    this.deps.setRequestTimingFields({
      save_summary_ms: 0,
      save_quota_ms: quotaMs,
      save_encrypt_ms: encryptMs,
      save_insert_ms: insertMs,
      save_db_write_ms: insertMs,
      save_service_ms: saveTotalMs,
      save_quota_mode: quotaMode,
      save_vector_mode: this.deps.shouldBypassVector() ? "bypass" : "background",
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
        try {
          const facts = await extractFacts(normalizedContent);
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

      const summarizeAndUpdate = async () => {
        if (this.deps.isEvalMode) return;
        try {
          const refinedSummary = await summarizeConversation(normalizedContent);
          const refinedContent = buildMemoryText(input.platform, refinedSummary, normalizedContent);
          await this.deps.memoryRepository.updateContentAndSummaryScoped(input.auth, memoryId, {
            contentCiphertext: encryptMemoryContent(refinedContent),
            contentHash: hashMemoryContent(refinedContent),
            summaryJson: refinedSummary,
          });
        } catch (error) {
          if (config.nodeEnv !== "production") {
            console.warn("[memory] background summary update failed", error);
          }
        }
      };

      await Promise.allSettled([
        embedAndUpsert(),
        extractAndSaveFacts(),
        summarizeAndUpdate(),
      ]);
    })();

    void this.deps.enqueueGraphExtractionJob(input.auth, memoryId).catch((error) => {
      if (config.nodeEnv !== "production") {
        console.warn("[graph] failed to enqueue extraction job", error);
      }
    });

    void this.deps.memoryRepository.logEvent({
      auth: input.auth,
      action: "save",
      memoryId,
      ipHash: this.deps.ipHash(input.requesterIp),
      metadata: { platform: input.platform },
    }).catch((error) => {
      this.deps.noteMemoryDbFailure(error, "save-log");
    });

    this.deps.invalidateRecallCache(input.auth);
    this.deps.invalidateRecallV2Cache(input.auth);
    this.deps.invalidateBm25Cache(input.auth);
    void this.deps.bumpRecallStamp(input.auth).catch(() => {});
    void this.deps.markSnapshotStale(input.auth).catch(() => {});
    void this.deps.queueSnapshotRefresh(input.auth, "save_memory", 1_000).catch(() => {});

    return {
      memoryId,
      title: summary.title,
      summary,
    };
  }
}
