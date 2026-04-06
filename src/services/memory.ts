import { Memory } from "mem0ai/oss";
import { config } from "../config.js";
import { summarizeConversation } from "./summarizer.js";
import type { ConversationSummary } from "./summarizer.js";

export function getMemory(): InstanceType<typeof Memory> {
  return new Memory({
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

export interface SaveMemoryResult {
  memoryId: string;
  title: string;
  summary: ConversationSummary;
}

export async function saveMemory(
  content: string,
  userId: string,
  platform: string
): Promise<SaveMemoryResult> {
  // 1. Summarize the conversation via Anthropic Haiku
  const summary = await summarizeConversation(content);

  // 2. Build the text to store in mem0
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

  // 3. Store via mem0
  const memory = await getMemory();
  const result = await memory.add(memoryText, {
    userId,
    metadata: { platform, title: summary.title },
  });

  // mem0 returns an array of results
  const memoryId =
    Array.isArray(result?.results) && result.results.length > 0
      ? result.results[0]?.id ?? crypto.randomUUID()
      : crypto.randomUUID();

  return {
    memoryId,
    title: summary.title,
    summary,
  };
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

export async function recallMemories(
  query: string,
  userId: string,
  limit: number = 5
): Promise<RecallResult> {
  const memory = await getMemory();
  const results = await memory.search(query, {
    userId,
    limit,
  });

  const memories = (results?.results ?? []).map((r: any) => ({
    id: r.id ?? "",
    text: r.memory ?? "",
    score: r.score ?? 0,
    metadata: r.metadata ?? {},
  }));

  // Format as an injectable context block
  const lines = memories.map((m) => {
    const platform = (m.metadata?.platform as string) ?? "unknown";
    return `[${platform.toUpperCase()}] ${m.text}`;
  });

  const contextBlock =
    lines.length > 0
      ? `--- Your Past Context ---\n${lines.join("\n")}\n---`
      : "--- No relevant memories found ---";

  return { contextBlock, memories };
}

export async function listMemories(userId: string) {
  const memory = await getMemory();
  const results = await memory.getAll({ userId });
  return (results?.results ?? []).map((r: any) => ({
    id: r.id ?? "",
    text: r.memory ?? "",
    metadata: r.metadata ?? {},
    createdAt: r.created_at ?? null,
  }));
}

export async function deleteMemory(memoryId: string) {
  const memory = await getMemory();
  await memory.delete(memoryId);
  return { success: true };
}
