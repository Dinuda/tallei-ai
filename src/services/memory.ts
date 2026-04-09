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

interface CachedRecall {
  result: RecallResult;
  exp: number;
}

const recallCache = new Map<string, CachedRecall>();
const prewarmedUsers = new Set<string>();

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

  const vector = await embedText(memoryText);
  const { pointId } = await vectorRepository.upsertMemoryVector({
    auth,
    memoryId,
    vector,
    platform,
    createdAt,
  });

  await memoryRepository.create(auth, {
    id: memoryId,
    contentCiphertext: encrypted,
    contentHash,
    platform,
    summaryJson: summary,
    qdrantPointId: pointId,
  });

  await memoryRepository.logEvent({
    auth,
    action: "save",
    memoryId,
    ipHash: ipHash(requesterIp),
    metadata: { platform },
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

  const queryVector = await embedText(query);
  const vectorResults = await vectorRepository.searchVectors(auth, queryVector, limit);
  const memoryIds = vectorResults.map((v) => v.memoryId);
  const rows = await memoryRepository.getByIds(auth, memoryIds);

  const rowMap = new Map(rows.map((row) => [row.id, row]));
  const memories = vectorResults
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

  await memoryRepository.logEvent({
    auth,
    action: "recall",
    ipHash: ipHash(requesterIp),
    metadata: { query, limit, hits: memories.length },
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

  await memoryRepository.logEvent({
    auth,
    action: "list",
    metadata: { count: memories.length },
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

  await vectorRepository.deleteMemoryVector(auth, memoryId);
  await memoryRepository.logEvent({
    auth,
    action: "delete",
    memoryId,
    ipHash: ipHash(requesterIp),
  });

  if (config.memoryDualWriteEnabled) {
    void legacyDeleteMemory(memoryId).catch((error) => {
      console.error("[memory] legacy delete failed", error);
    });
  }

  invalidateRecallCache(auth);
  return { success: true };
}
