import { Memory } from "mem0ai/oss";
import { config } from "../config.js";
import { summarizeConversation } from "./summarizer.js";
import type { ConversationSummary } from "./summarizer.js";

let _memory: InstanceType<typeof Memory> | null = null;

function getPgVectorConfig() {
  const parsed = new URL(config.databaseUrl);
  const dbname = parsed.pathname.replace(/^\/+/, "") || "tallei";

  return {
    user: decodeURIComponent(parsed.username || "tallei"),
    password: decodeURIComponent(parsed.password || ""),
    host: parsed.hostname || "localhost",
    port: Number(parsed.port || 5432),
    dbname,
    collectionName: "tallei_memories",
    embeddingModelDims: 1536,
  };
}

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
        config: getPgVectorConfig(),
      },
    });
  }
  return _memory;
}

export interface LegacyRecallResult {
  contextBlock: string;
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
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

export async function legacySaveMemory(content: string, userId: string, platform: string): Promise<void> {
  const summary = await summarizeConversation(content).catch(() => buildFallbackSummary(content));
  const memoryText = buildMemoryText(platform, summary, content);
  const memory = getMemory();
  await memory.add(memoryText, {
    userId,
    infer: false,
    metadata: { platform, title: summary.title },
  });
}

export async function legacyRecallMemories(query: string, userId: string, limit = 5): Promise<LegacyRecallResult> {
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
      ? `--- Legacy Context ---\n${lines.join("\n")}\n---`
      : "--- No legacy memories found ---";

  return { contextBlock, memories };
}

export async function legacyListMemories(userId: string) {
  const memory = getMemory();
  const results = await memory.getAll({ userId });
  return (results?.results ?? []).map((r: any) => ({
    id: r.id ?? "",
    text: r.memory ?? "",
    metadata: r.metadata ?? {},
    createdAt: r.created_at ?? r.createdAt ?? null,
  }));
}

export async function legacyDeleteMemory(memoryId: string): Promise<void> {
  const memory = getMemory();
  await memory.delete(memoryId);
}
