import OpenAI from "openai";
import { config } from "../config.js";

function buildEmbeddingClient(): OpenAI {
  if (config.embeddingProvider === "ollama") {
    return new OpenAI({
      baseURL: config.ollamaBaseUrl,
      apiKey: "ollama",
    });
  }
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
  }
  return new OpenAI({ apiKey: config.openaiApiKey });
}

const embeddingClient = buildEmbeddingClient();

export const EMBEDDING_DIMS = config.embeddingDims;
const EMBEDDING_CACHE_TTL_MS = config.nodeEnv === "production" ? 5 * 60_000 : 60_000;
const MAX_EMBEDDING_CACHE_ENTRIES = 512;

interface CachedEmbedding {
  exp: number;
  vector: number[];
}

const embeddingCache = new Map<string, CachedEmbedding>();
const embeddingInFlight = new Map<string, Promise<number[]>>();

function normalizeEmbeddingInput(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function evictExpiredEmbeddings(now: number): void {
  for (const [key, entry] of embeddingCache.entries()) {
    if (entry.exp <= now) {
      embeddingCache.delete(key);
    }
  }
}

function enforceEmbeddingCacheLimit(): void {
  while (embeddingCache.size > MAX_EMBEDDING_CACHE_ENTRIES) {
    const oldestKey = embeddingCache.keys().next().value;
    if (!oldestKey) break;
    embeddingCache.delete(oldestKey);
  }
}

export async function embedText(text: string): Promise<number[]> {
  const normalized = normalizeEmbeddingInput(text);
  const now = Date.now();

  evictExpiredEmbeddings(now);
  const cached = embeddingCache.get(normalized);
  if (cached && cached.exp > now) {
    return cached.vector;
  }

  const inFlight = embeddingInFlight.get(normalized);
  if (inFlight) {
    return inFlight;
  }

  const request = embeddingClient.embeddings.create({
    model: config.embeddingModel,
    input: normalized,
  }).then((response) => {
    const vector = response.data[0]?.embedding;
    if (!vector || vector.length === 0) {
      throw new Error("Embedding provider returned empty vector");
    }

    embeddingCache.set(normalized, {
      exp: Date.now() + EMBEDDING_CACHE_TTL_MS,
      vector,
    });
    enforceEmbeddingCacheLimit();
    return vector;
  }).finally(() => {
    embeddingInFlight.delete(normalized);
  });

  embeddingInFlight.set(normalized, request);

  return request;
}
