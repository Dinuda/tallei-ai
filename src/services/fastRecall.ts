import { createHash } from "crypto";
import type { AuthContext } from "../types/auth.js";
import { decryptMemoryContent } from "./crypto.js";
import { MemoryRepository } from "../repositories/memoryRepository.js";
import { getCacheJson, incrementWithTtl, setCacheJson } from "./cache.js";
import { config } from "../config.js";

export interface FastRecallMemoryItem {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

interface LocalCacheEntry<T> {
  exp: number;
  value: T;
}

interface RecallCachedPayloads {
  v1?: unknown;
  v2?: unknown;
}

interface RecallCacheEnvelope {
  createdAt: string;
  payloads: RecallCachedPayloads;
}

type RecallCacheSlot = "v1" | "v2";
type RecallCacheKind = "exact" | "warm";

const memoryRepository = new MemoryRepository();

const FAST_RECALL_EXACT_TTL_SECONDS = 120;
const FAST_RECALL_WARM_TTL_SECONDS = 45;
const FAST_RECALL_STAMP_TTL_SECONDS = 60 * 60 * 24 * 30;
const FAST_RECALL_STAMP_SYNC_MS = 2_000;

const localCache = new Map<string, LocalCacheEntry<RecallCacheEnvelope>>();
const localStampByScope = new Map<string, number>();
const localStampSyncedAtByScope = new Map<string, number>();
const localEnrichmentInFlight = new Map<string, Promise<void>>();

function scopeKey(auth: AuthContext): string {
  return `${auth.tenantId}:${auth.userId}`;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function recencyScore(createdAtIso: string): number {
  const days = Math.max(0, (Date.now() - new Date(createdAtIso).getTime()) / 86_400_000);
  return Math.max(0, 1 - days / 30);
}

function lexicalRelevance(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(tokenize(text));
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

function queryHash(query: string): string {
  return createHash("sha256").update(normalizeQuery(query)).digest("hex");
}

function stampCacheKey(auth: AuthContext): string {
  return `recall:stamp:${auth.tenantId}:${auth.userId}`;
}

function exactCacheKey(auth: AuthContext, query: string, stamp: number): string {
  return `recall:exact:${auth.tenantId}:${auth.userId}:${queryHash(query)}:${stamp}`;
}

function warmCacheKey(auth: AuthContext, stamp: number): string {
  return `recall:warm:${auth.tenantId}:${auth.userId}:${stamp}`;
}

function getLocalCache<T>(key: string): T | null {
  const entry = localCache.get(key);
  if (!entry) return null;
  if (entry.exp <= Date.now()) {
    localCache.delete(key);
    return null;
  }
  return entry.value as T;
}

function setLocalCache<T>(key: string, value: T, ttlSeconds: number): void {
  localCache.set(key, { exp: Date.now() + ttlSeconds * 1000, value: value as RecallCacheEnvelope });
}

async function readCacheEnvelope(key: string, ttlSeconds: number): Promise<RecallCacheEnvelope | null> {
  const local = getLocalCache<RecallCacheEnvelope>(key);
  if (local) return local;

  const cached = await getCacheJson<RecallCacheEnvelope>(key);
  if (cached) {
    setLocalCache(key, cached, ttlSeconds);
  }
  return cached;
}

async function writeCacheEnvelope(key: string, value: RecallCacheEnvelope, ttlSeconds: number): Promise<void> {
  setLocalCache(key, value, ttlSeconds);
  await setCacheJson(key, value, ttlSeconds);
}

export async function readRecallStamp(auth: AuthContext): Promise<number> {
  const scope = scopeKey(auth);
  const localStamp = localStampByScope.get(scope);
  if (typeof localStamp === "number") {
    const lastSyncedAt = localStampSyncedAtByScope.get(scope) ?? 0;
    if (Date.now() - lastSyncedAt >= FAST_RECALL_STAMP_SYNC_MS) {
      localStampSyncedAtByScope.set(scope, Date.now());
      void getCacheJson<number>(stampCacheKey(auth))
        .then((remoteStamp) => {
          if (typeof remoteStamp !== "number") return;
          const next = Math.max(localStampByScope.get(scope) ?? 0, remoteStamp);
          localStampByScope.set(scope, next);
        })
        .catch(() => {});
    }
    return localStamp;
  }

  const remoteStamp = await getCacheJson<number>(stampCacheKey(auth));
  const stamp = typeof remoteStamp === "number" ? remoteStamp : 0;
  localStampByScope.set(scope, stamp);
  localStampSyncedAtByScope.set(scope, Date.now());
  return stamp;
}

export async function bumpRecallStamp(auth: AuthContext): Promise<void> {
  const scope = scopeKey(auth);
  const next = (localStampByScope.get(scope) ?? 0) + 1;
  localStampByScope.set(scope, next);
  localStampSyncedAtByScope.set(scope, Date.now());
  await incrementWithTtl(stampCacheKey(auth), FAST_RECALL_STAMP_TTL_SECONDS);
}

async function readPayload<T>(
  auth: AuthContext,
  query: string,
  slot: RecallCacheSlot,
  kind: RecallCacheKind
): Promise<{ payload: T; createdAt: string } | null> {
  const stamp = await readRecallStamp(auth);
  const key = kind === "exact" ? exactCacheKey(auth, query, stamp) : warmCacheKey(auth, stamp);
  const ttl = kind === "exact" ? FAST_RECALL_EXACT_TTL_SECONDS : FAST_RECALL_WARM_TTL_SECONDS;
  const envelope = await readCacheEnvelope(key, ttl);
  const payload = envelope?.payloads?.[slot];
  if (!payload) return null;
  return { payload: payload as T, createdAt: envelope.createdAt };
}

async function writePayload<T>(
  auth: AuthContext,
  query: string,
  slot: RecallCacheSlot,
  payload: T,
  kind: RecallCacheKind
): Promise<void> {
  const stamp = await readRecallStamp(auth);
  const key = kind === "exact" ? exactCacheKey(auth, query, stamp) : warmCacheKey(auth, stamp);
  const ttl = kind === "exact" ? FAST_RECALL_EXACT_TTL_SECONDS : FAST_RECALL_WARM_TTL_SECONDS;
  const existing = (await readCacheEnvelope(key, ttl)) ?? {
    createdAt: new Date().toISOString(),
    payloads: {},
  };
  const envelope: RecallCacheEnvelope = {
    createdAt: new Date().toISOString(),
    payloads: {
      ...existing.payloads,
      [slot]: payload,
    },
  };
  await writeCacheEnvelope(key, envelope, ttl);
}

export async function readExactRecallPayload<T>(
  auth: AuthContext,
  query: string,
  slot: RecallCacheSlot
): Promise<T | null> {
  const hit = await readPayload<T>(auth, query, slot, "exact");
  return hit?.payload ?? null;
}

export async function readWarmRecallPayload<T>(
  auth: AuthContext,
  query: string,
  slot: RecallCacheSlot
): Promise<T | null> {
  const hit = await readPayload<T>(auth, query, slot, "warm");
  return hit?.payload ?? null;
}

export async function writeRecallPayload<T>(
  auth: AuthContext,
  query: string,
  slot: RecallCacheSlot,
  payload: T
): Promise<void> {
  await writePayload(auth, query, slot, payload, "exact");
  await writePayload(auth, query, slot, payload, "warm");
}

function buildContextBlock(memories: FastRecallMemoryItem[]): string {
  if (memories.length === 0) {
    return "--- No relevant memories found ---";
  }
  const lines = memories.map((memory) => {
    const platformValue = memory.metadata.platform;
    const platform = typeof platformValue === "string" && platformValue.length > 0
      ? platformValue
      : "unknown";
    return `[${platform.toUpperCase()}] ${memory.text}`;
  });
  return `--- Your Past Context ---\n${lines.join("\n")}\n---`;
}

export async function buildRecentFallback(
  auth: AuthContext,
  query: string,
  limit: number
): Promise<{ contextBlock: string; memories: FastRecallMemoryItem[]; elapsedMs: number; relevanceMiss: boolean }> {
  const startedAt = Date.now();
  const bounded = Math.min(20, Math.max(1, limit));
  const maxRecent = Math.min(3, bounded);
  const rows = await memoryRepository.list(auth, Math.max(bounded * 2, 12));
  const queryTokens = new Set(tokenize(normalizeQuery(query)));

  const candidates = rows.map((row) => {
    let text = "";
    try {
      text = decryptMemoryContent(row.content_ciphertext);
    } catch {
      text = "[Encrypted memory unavailable]";
    }
    const lexical = lexicalRelevance(queryTokens, text);
    const recency = recencyScore(row.created_at);
    const metadata = (row.summary_json && typeof row.summary_json === "object"
      ? (row.summary_json as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    return {
      id: row.id,
      text,
      lexical,
      recency,
      metadata: {
        ...metadata,
        platform: row.platform,
        createdAt: row.created_at,
        retrieval: "recent_fallback",
        query: normalizeQuery(query),
        lexical_relevance: Number(lexical.toFixed(4)),
      },
    };
  });

  const relevantCandidates = queryTokens.size === 0
    ? candidates
    : candidates.filter((candidate) => candidate.lexical >= config.memoryFallbackMinRelevance);

  const memories = relevantCandidates
    .sort((a, b) => {
      if (b.lexical !== a.lexical) return b.lexical - a.lexical;
      return b.recency - a.recency;
    })
    .slice(0, maxRecent)
    .map((candidate, index) => ({
      id: candidate.id,
      text: candidate.text,
      score: Number((candidate.lexical * 0.85 + candidate.recency * 0.15 - index * 0.01).toFixed(4)),
      metadata: candidate.metadata,
    }));

  return {
    contextBlock: buildContextBlock(memories),
    memories,
    elapsedMs: Date.now() - startedAt,
    relevanceMiss: queryTokens.size > 0 && memories.length === 0,
  };
}

export function runBackgroundRecallEnrichment(key: string, task: () => Promise<void>): void {
  if (localEnrichmentInFlight.has(key)) return;
  const runner = task()
    .catch(() => {})
    .finally(() => {
      localEnrichmentInFlight.delete(key);
    });
  localEnrichmentInFlight.set(key, runner);
}
