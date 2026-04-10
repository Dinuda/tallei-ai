import { randomUUID, createHash } from "crypto";
import { config } from "../config.js";
import type { AuthContext } from "../types/auth.js";
import type { ConversationSummary } from "./summarizer.js";
import { summarizeConversation } from "./summarizer.js";
import { decryptMemoryContent, encryptMemoryContent, hashMemoryContent } from "./crypto.js";
import { embedText } from "./embeddings.js";
import { MemoryRepository } from "../repositories/memoryRepository.js";
import { VectorRepository } from "../repositories/vectorRepository.js";
import {
  legacyDeleteMemory,
  legacyListMemories,
  legacyRecallMemories,
  legacySaveMemory,
} from "./legacyMemory.js";

const memoryRepository = new MemoryRepository();
const vectorRepository = new VectorRepository();

const RECALL_TTL_MS = 10 * 60_000;
const VECTOR_BYPASS_TTL_MS = config.nodeEnv === "production" ? 0 : 60_000;
const VECTOR_WARN_INTERVAL_MS = 30_000;
const MEMORY_DB_TIMEOUT_MS = config.nodeEnv === "production" ? 10_000 : 2_500;

interface CachedRecall {
  result: RecallResult;
  exp: number;
}

const recallCache = new Map<string, CachedRecall>();
const prewarmedUsers = new Set<string>();
let vectorBypassUntil = 0;
let lastVectorWarnAt = 0;
let lastMemoryDbWarnAt = 0;

function cacheScopeKey(auth: AuthContext): string {
  return `${auth.tenantId}:${auth.userId}`;
}

function recallCacheKey(auth: AuthContext, query: string, limit: number): string {
  return `${cacheScopeKey(auth)}:${limit}:${query}`;
}

function invalidateRecallCache(auth: AuthContext): void {
  const prefix = `${cacheScopeKey(auth)}:`;
  for (const key of recallCache.keys()) {
    if (key.startsWith(prefix)) {
      recallCache.delete(key);
    }
  }
}

function isVectorInfraError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Qdrant|timeout|aborted|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|No route to host/i.test(error.message);
}

function shouldBypassVector(): boolean {
  return VECTOR_BYPASS_TTL_MS > 0 && Date.now() < vectorBypassUntil;
}

function noteVectorFailure(error: unknown, context: string): void {
  if (VECTOR_BYPASS_TTL_MS > 0 && isVectorInfraError(error)) {
    vectorBypassUntil = Date.now() + VECTOR_BYPASS_TTL_MS;
  }

  if (config.nodeEnv !== "production") {
    const now = Date.now();
    if (now - lastVectorWarnAt >= VECTOR_WARN_INTERVAL_MS) {
      lastVectorWarnAt = now;
      console.warn(`[memory] vector pipeline degraded (${context})`, error);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
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

function noteMemoryDbFailure(error: unknown, context: string): void {
  if (config.nodeEnv === "production") return;
  const now = Date.now();
  if (now - lastMemoryDbWarnAt < VECTOR_WARN_INTERVAL_MS) return;
  lastMemoryDbWarnAt = now;
  console.warn(`[memory] db pipeline degraded (${context})`, error);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function fallbackScore(query: string, text: string, createdAt: string): number {
  const queryTokens = new Set(tokenize(query));
  const textTokens = tokenize(text);
  let overlap = 0;
  for (const token of textTokens) {
    if (queryTokens.has(token)) overlap += 1;
  }

  const recencyDays = Math.max(
    0,
    (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  const recencyScore = Math.max(0, 1 - recencyDays / 30);
  const lexicalScore = queryTokens.size === 0 ? 0 : overlap / queryTokens.size;

  return Number((lexicalScore * 0.75 + recencyScore * 0.25).toFixed(4));
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

function ipHash(ip?: string): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex");
}

function compareShadowResults(primary: RecallResult, legacy: { memories: Array<{ id: string }> }): boolean {
  if (primary.memories.length !== legacy.memories.length) return false;
  const left = primary.memories.map((m) => m.id).sort();
  const right = legacy.memories.map((m) => m.id).sort();
  if (left.length !== right.length) return false;
  return left.every((value, idx) => value === right[idx]);
}

export interface SaveMemoryResult {
  memoryId: string;
  title: string;
  summary: ConversationSummary;
}

export interface RecallResult {
  contextBlock: string;
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
}

export function prewarmRecallCache(auth: AuthContext): void {
  const key = cacheScopeKey(auth);
  if (prewarmedUsers.has(key)) return;
  prewarmedUsers.add(key);
  void recallMemories("user projects preferences and tech stack", auth, 5).catch(() => {});
}

export async function saveMemory(
  content: string,
  auth: AuthContext,
  platform: string,
  requesterIp?: string
): Promise<SaveMemoryResult> {
  const summary = await summarizeConversation(content).catch((err) => {
    console.error("[memory] summarize failed, using fallback:", err);
    return buildFallbackSummary(content);
  });

  const memoryText = buildMemoryText(platform, summary, content);
  const encrypted = encryptMemoryContent(memoryText);
  const contentHash = hashMemoryContent(memoryText);
  const createdAt = new Date().toISOString();
  const memoryId = randomUUID();

  let pointId: string = memoryId;
  if (!shouldBypassVector()) {
    try {
      const vector = await embedText(memoryText);
      const upserted = await vectorRepository.upsertMemoryVector({
        auth,
        memoryId,
        vector,
        platform,
        createdAt,
      });
      pointId = upserted.pointId;
    } catch (error) {
      noteVectorFailure(error, "save");
    }
  }

  await memoryRepository.create(auth, {
    id: memoryId,
    contentCiphertext: encrypted,
    contentHash,
    platform,
    summaryJson: summary,
    qdrantPointId: pointId,
  });

  void memoryRepository.logEvent({
    auth,
    action: "save",
    memoryId,
    ipHash: ipHash(requesterIp),
    metadata: { platform },
  }).catch((error) => {
    noteMemoryDbFailure(error, "save-log");
  });

  invalidateRecallCache(auth);

  if (config.memoryDualWriteEnabled) {
    void legacySaveMemory(content, auth.userId, platform).catch((error) => {
      console.error("[memory] legacy dual-write failed", error);
    });
  }

  return {
    memoryId,
    title: summary.title,
    summary,
  };
}

export async function recallMemories(
  query: string,
  auth: AuthContext,
  limit = 5,
  requesterIp?: string
): Promise<RecallResult> {
  const cacheKey = recallCacheKey(auth, query, limit);
  const cached = recallCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) {
    return cached.result;
  }

  let vectorResults: Array<{ pointId: string; memoryId: string; score: number }> = [];
  let rows = [] as Awaited<ReturnType<typeof memoryRepository.getByIds>>;

  if (!shouldBypassVector()) {
    try {
      const queryVector = await embedText(query);
      vectorResults = await vectorRepository.searchVectors(auth, queryVector, limit);
      const memoryIds = vectorResults.map((v) => v.memoryId);
      rows = await withTimeout(
        memoryRepository.getByIds(auth, memoryIds),
        MEMORY_DB_TIMEOUT_MS,
        "recall.getByIds"
      );
    } catch (error) {
      noteVectorFailure(error, "recall");
    }
  }

  const rowMap = new Map(rows.map((row) => [row.id, row]));
  let memories = vectorResults
    .map((vectorHit) => {
      const row = rowMap.get(vectorHit.memoryId);
      if (!row) return null;

      let text = "";
      try {
        text = decryptMemoryContent(row.content_ciphertext);
      } catch (error) {
        console.error("[memory] decrypt failed for memory", row.id, error);
        text = "[Encrypted memory unavailable]";
      }

      const metadata = (row.summary_json && typeof row.summary_json === "object"
        ? (row.summary_json as Record<string, unknown>)
        : {}) as Record<string, unknown>;

      return {
        id: row.id,
        text,
        score: vectorHit.score,
        metadata: {
          ...metadata,
          platform: row.platform,
          createdAt: row.created_at,
        },
      };
    })
    .filter((memory): memory is NonNullable<typeof memory> => Boolean(memory));

  if (memories.length === 0) {
    let fallbackRows = [] as Awaited<ReturnType<typeof memoryRepository.list>>;
    try {
      fallbackRows = await withTimeout(
        memoryRepository.list(auth, Math.max(limit * 6, 30)),
        MEMORY_DB_TIMEOUT_MS,
        "recall.listFallback"
      );
    } catch (error) {
      noteMemoryDbFailure(error, "recall-list-fallback");
      fallbackRows = [];
    }
    memories = fallbackRows
      .map((row) => {
        let text = "";
        try {
          text = decryptMemoryContent(row.content_ciphertext);
        } catch {
          text = "[Encrypted memory unavailable]";
        }

        const metadata = (row.summary_json && typeof row.summary_json === "object"
          ? (row.summary_json as Record<string, unknown>)
          : {}) as Record<string, unknown>;

        return {
          id: row.id,
          text,
          score: fallbackScore(query, text, row.created_at),
          metadata: {
            ...metadata,
            platform: row.platform,
            createdAt: row.created_at,
            retrieval: "fallback",
          },
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  const lines = memories.map((memory) => {
    const platformValue = memory.metadata.platform;
    const platform =
      typeof platformValue === "string" && platformValue.length > 0
        ? platformValue
        : "unknown";
    return `[${platform.toUpperCase()}] ${memory.text}`;
  });

  const contextBlock =
    lines.length > 0
      ? `--- Your Past Context ---\n${lines.join("\n")}\n---`
      : "--- No relevant memories found ---";

  const result: RecallResult = { contextBlock, memories };
  recallCache.set(cacheKey, { result, exp: Date.now() + RECALL_TTL_MS });

  void memoryRepository.logEvent({
    auth,
    action: "recall",
    ipHash: ipHash(requesterIp),
    metadata: { query, limit, hits: memories.length },
  }).catch((error) => {
    noteMemoryDbFailure(error, "recall-log");
  });

  if (config.memoryShadowReadEnabled && config.memoryDualWriteEnabled) {
    void legacyRecallMemories(query, auth.userId, limit)
      .then(async (legacyResult) => {
        if (!compareShadowResults(result, legacyResult)) {
          await memoryRepository.logEvent({
            auth,
            action: "shadow_divergence",
            metadata: {
              query,
              limit,
              primaryCount: result.memories.length,
              legacyCount: legacyResult.memories.length,
            },
          });
        }
      })
      .catch((error) => {
        console.error("[memory] shadow-read failed", error);
      });
  }

  return result;
}

export async function listMemories(auth: AuthContext) {
  const rows = await memoryRepository.list(auth, 200);

  const memories = rows.map((row) => {
    let text = "";
    try {
      text = decryptMemoryContent(row.content_ciphertext);
    } catch {
      text = "[Encrypted memory unavailable]";
    }

    const metadata = (row.summary_json && typeof row.summary_json === "object"
      ? (row.summary_json as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    return {
      id: row.id,
      text,
      metadata: {
        ...metadata,
        platform: row.platform,
      },
      createdAt: row.created_at,
    };
  });

  void memoryRepository.logEvent({
    auth,
    action: "list",
    metadata: { count: memories.length },
  }).catch((error) => {
    noteMemoryDbFailure(error, "list-log");
  });

  if (config.memoryShadowReadEnabled && config.memoryDualWriteEnabled) {
    void legacyListMemories(auth.userId)
      .then(async (legacy) => {
        if (legacy.length !== memories.length) {
          await memoryRepository.logEvent({
            auth,
            action: "shadow_divergence",
            metadata: {
              operation: "list",
              primaryCount: memories.length,
              legacyCount: legacy.length,
            },
          });
        }
      })
      .catch((error) => {
        console.error("[memory] legacy list shadow-read failed", error);
      });
  }

  return memories;
}

export async function deleteMemory(memoryId: string, auth: AuthContext, requesterIp?: string) {
  const deleted = await memoryRepository.softDeleteScoped(auth, memoryId);
  if (!deleted) {
    throw new Error("Memory not found or not owned by user");
  }

  try {
    await vectorRepository.deleteMemoryVector(auth, memoryId);
  } catch (error) {
    noteVectorFailure(error, "delete");
  }
  void memoryRepository.logEvent({
    auth,
    action: "delete",
    memoryId,
    ipHash: ipHash(requesterIp),
  }).catch((error) => {
    noteMemoryDbFailure(error, "delete-log");
  });

  if (config.memoryDualWriteEnabled) {
    void legacyDeleteMemory(memoryId).catch((error) => {
      console.error("[memory] legacy delete failed", error);
    });
  }

  invalidateRecallCache(auth);
  return { success: true };
}
