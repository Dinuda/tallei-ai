import { Memory } from "mem0ai/oss";
import { config } from "../config.js";
import { summarizeConversation } from "./summarizer.js";
import type { ConversationSummary } from "./summarizer.js";

// ── Singleton Memory instance ────────────────────────────────────────────────
// Creating a new Memory() on every call re-initialises DB connections and
// provider clients from scratch. One shared instance eliminates that overhead.
let _memory: InstanceType<typeof Memory> | null = null;

function getMemory(): InstanceType<typeof Memory> {
  if (!_memory) {
    _memory = new Memory({
      llm: {
        provider: "openai",
        config: {
          model: "gpt-4o-mini",
          apiKey: config.openaiApiKey,
        },
      },
      embedder: {
        provider: "openai",
        config: {
          model: "text-embedding-3-small",
          apiKey: config.openaiApiKey,
        },
      },
      vectorStore: {
        provider: "pgvector",
        config: {
          user: "tallei",
          password: "tallei",
          host: "localhost",
          port: 5432,
          dbname: "tallei",
          collectionName: "tallei_memories",
          embeddingModelDims: 1536,
        },
      },
    });
  }
  return _memory;
}

// ── Recall cache ─────────────────────────────────────────────────────────────
// Memories don't change second-to-second. Cache aggressively:
// - 10 min TTL for normal results (user prefs/context barely changes mid-session)
// - Cache is invalidated immediately when a new save completes
const RECALL_TTL_MS = 10 * 60_000;
interface CachedRecall {
  result: RecallResult;
  exp: number;
}
const recallCache = new Map<string, CachedRecall>();

function recallCacheKey(userId: string, query: string, limit: number): string {
  return `${userId}:${limit}:${query}`;
}

// ── Cache pre-warm ────────────────────────────────────────────────────────────
// Call this as soon as a user is authenticated. Kicks off a background embed
// for the most common query so the first real recall is a cache hit (~5ms).
const prewarmedUsers = new Set<string>();

export function prewarmRecallCache(userId: string): void {
  if (prewarmedUsers.has(userId)) return;
  prewarmedUsers.add(userId);
  void recallMemories("user projects preferences and tech stack", userId, 5).catch(() => {});
}

// ── Types ────────────────────────────────────────────────────────────────────
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

// ── save_memory ──────────────────────────────────────────────────────────────
// The heavy work (summarise → embed → store) runs in the background.
// The caller receives a placeholder result immediately so Claude is not blocked.
export async function saveMemory(
  content: string,
  userId: string,
  platform: string
): Promise<SaveMemoryResult> {
  // Return a stub immediately; persist in the background.
  const placeholder: SaveMemoryResult = {
    memoryId: crypto.randomUUID(),
    title: "Processing…",
    summary: {
      title: "Processing…",
      keyPoints: [],
      decisions: [],
      summary: "",
    },
  };

  // Fire-and-forget — errors are logged but don't block the response.
  void persistMemoryInBackground(content, userId, platform).catch((err) => {
    console.error("[memory] background save failed:", err);
  });

  return placeholder;
}

async function persistMemoryInBackground(
  content: string,
  userId: string,
  platform: string
): Promise<void> {
  // Run summariser and start building the store text.
  const summary = await summarizeConversation(content);

  const memoryText = [
    `[${platform.toUpperCase()}] ${summary.title}`,
    `Key Points: ${summary.keyPoints.join("; ")}`,
    summary.decisions.length > 0
      ? `Decisions: ${summary.decisions.join("; ")}`
      : "",
    `Summary: ${summary.summary}`,
  ]
    .filter(Boolean)
    .join("\n");

  const memory = getMemory();
  await memory.add(memoryText, {
    userId,
    metadata: { platform, title: summary.title },
  });

  // Invalidate cached recalls for this user so the next recall is fresh.
  for (const key of recallCache.keys()) {
    if (key.startsWith(`${userId}:`)) recallCache.delete(key);
  }
}

// ── recall_memories ──────────────────────────────────────────────────────────
export async function recallMemories(
  query: string,
  userId: string,
  limit: number = 5
): Promise<RecallResult> {
  const cacheKey = recallCacheKey(userId, query, limit);
  const cached = recallCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) {
    return cached.result;
  }

  const memory = getMemory();
  const results = await memory.search(query, { userId, limit });

  const memories = (results?.results ?? []).map((r: any) => ({
    id: r.id ?? "",
    text: r.memory ?? "",
    score: r.score ?? 0,
    metadata: r.metadata ?? {},
  }));

  const lines = memories.map((m) => {
    const platform = (m.metadata?.platform as string) ?? "unknown";
    return `[${platform.toUpperCase()}] ${m.text}`;
  });

  const contextBlock =
    lines.length > 0
      ? `--- Your Past Context ---\n${lines.join("\n")}\n---`
      : "--- No relevant memories found ---";

  const result: RecallResult = { contextBlock, memories };
  recallCache.set(cacheKey, { result, exp: Date.now() + RECALL_TTL_MS });
  return result;
}

// ── list_memories ─────────────────────────────────────────────────────────────
export async function listMemories(userId: string) {
  const memory = getMemory();
  const results = await memory.getAll({ userId });
  return (results?.results ?? []).map((r: any) => ({
    id: r.id ?? "",
    text: r.memory ?? "",
    metadata: r.metadata ?? {},
    createdAt: r.created_at ?? null,
  }));
}

// ── delete_memory ─────────────────────────────────────────────────────────────
export async function deleteMemory(memoryId: string) {
  const memory = getMemory();
  await memory.delete(memoryId);
  return { success: true };
}
