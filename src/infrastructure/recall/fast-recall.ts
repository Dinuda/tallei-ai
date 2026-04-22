import { createHash } from "crypto";
import type { AuthContext } from "../../domain/auth/index.js";
import { decryptMemoryContent } from "../crypto/memory-crypto.js";
import { MemoryRepository } from "../repositories/memory.repository.js";
import { getCacheJson, incrementWithTtl, setCacheJson } from "../cache/redis-cache.js";
import { config } from "../../config/index.js";
import type { MemoryType } from "../../orchestration/memory/memory-types.js";

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

export interface RecallCacheLookupTimings {
  recall_local_ms: number;
  recall_stamp_ms: number;
  recall_redis_ms: number;
}

type RecallCacheSlot = "v1" | "v2";
type RecallCacheKind = "exact" | "warm";

const memoryRepository = new MemoryRepository();

const FAST_RECALL_EXACT_TTL_SECONDS = 120;
const FAST_RECALL_WARM_TTL_SECONDS = 45;
const FAST_RECALL_STAMP_TTL_SECONDS = 60 * 60 * 24 * 30;
const FAST_RECALL_STAMP_SYNC_MS = 10_000;
const FAST_RECALL_SWR_MULTIPLIER = 2;

const localCache = new Map<string, LocalCacheEntry<RecallCacheEnvelope>>();
const localStampByScope = new Map<string, number>();
const localStampSyncedAtByScope = new Map<string, number>();
const localEnrichmentInFlight = new Map<string, Promise<void>>();
const inflightStampByScope = new Map<string, Promise<number>>();
const inflightEnvelopeByKey = new Map<string, Promise<RecallCacheEnvelope | null>>();

function scopeKey(auth: AuthContext): string {
  return `${auth.tenantId}:${auth.userId}`;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Collapse slash-joined abbreviations like "A/L", "A/Ls" → "al", "als"
    .replace(/([a-z])\/([a-z])/g, "$1$2")
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
  localCache.set(key, {
    exp: Date.now() + ttlSeconds * FAST_RECALL_SWR_MULTIPLIER * 1000,
    value: value as RecallCacheEnvelope,
  });
}

function isRecallCacheEnvelope(value: unknown): value is RecallCacheEnvelope {
  if (!value || typeof value !== "object") return false;
  const parsed = value as Partial<RecallCacheEnvelope>;
  return typeof parsed.createdAt === "string" && typeof parsed.payloads === "object" && parsed.payloads !== null;
}

function envelopeAgeMs(envelope: RecallCacheEnvelope): number {
  const createdAtMs = Date.parse(envelope.createdAt);
  if (!Number.isFinite(createdAtMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - createdAtMs);
}

function isWithinSwrWindow(envelope: RecallCacheEnvelope, ttlSeconds: number): boolean {
  return envelopeAgeMs(envelope) < ttlSeconds * FAST_RECALL_SWR_MULTIPLIER * 1000;
}

function isStale(envelope: RecallCacheEnvelope, ttlSeconds: number): boolean {
  return envelopeAgeMs(envelope) >= ttlSeconds * 1000;
}

async function fetchEnvelopeFromRedis(key: string): Promise<RecallCacheEnvelope | null> {
  let pending = inflightEnvelopeByKey.get(key);
  if (!pending) {
    pending = getCacheJson<RecallCacheEnvelope>(key)
      .catch(() => null)
      .finally(() => {
      const active = inflightEnvelopeByKey.get(key);
      if (active === pending) inflightEnvelopeByKey.delete(key);
    });
    inflightEnvelopeByKey.set(key, pending);
  }
  return pending;
}

function addLookupTiming(
  timings: Partial<RecallCacheLookupTimings> | undefined,
  key: keyof RecallCacheLookupTimings,
  deltaMs: number
): void {
  if (!timings) return;
  timings[key] = (timings[key] ?? 0) + deltaMs;
}

async function readCacheEnvelope(
  key: string,
  ttlSeconds: number,
  timings?: Partial<RecallCacheLookupTimings>
): Promise<RecallCacheEnvelope | null> {
  const localStartedAt = process.hrtime.bigint();
  const local = getLocalCache<RecallCacheEnvelope>(key);
  addLookupTiming(
    timings,
    "recall_local_ms",
    Number(process.hrtime.bigint() - localStartedAt) / 1_000_000
  );
  if (local) {
    if (isStale(local, ttlSeconds) && isWithinSwrWindow(local, ttlSeconds)) {
      // SWR: return stale data immediately and refresh Redis value in the background.
      void fetchEnvelopeFromRedis(key).then((fresh) => {
        if (fresh) setLocalCache(key, fresh, ttlSeconds);
      }).catch(() => {});
    }
    return local;
  }

  const redisStartedAt = process.hrtime.bigint();
  const cached = await fetchEnvelopeFromRedis(key);
  addLookupTiming(
    timings,
    "recall_redis_ms",
    Number(process.hrtime.bigint() - redisStartedAt) / 1_000_000
  );
  if (cached) {
    setLocalCache(key, cached, ttlSeconds);
  }
  return cached;
}

async function writeCacheEnvelope(key: string, value: RecallCacheEnvelope, ttlSeconds: number): Promise<void> {
  setLocalCache(key, value, ttlSeconds);
  await setCacheJson(key, value, ttlSeconds);
}

export async function readRecallStamp(
  auth: AuthContext,
  timings?: Partial<RecallCacheLookupTimings>
): Promise<number> {
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

  let pending = inflightStampByScope.get(scope);
  if (!pending) {
    pending = (async () => {
      try {
        const remoteStamp = await getCacheJson<number>(stampCacheKey(auth));
        if (typeof remoteStamp === "number" && Number.isFinite(remoteStamp)) {
          return Math.max(0, remoteStamp);
        }
        return 0;
      } catch {
        return 0;
      }
    })().finally(() => {
      const active = inflightStampByScope.get(scope);
      if (active === pending) inflightStampByScope.delete(scope);
    });
    inflightStampByScope.set(scope, pending);
  }
  const stampStartedAt = process.hrtime.bigint();
  const initialStamp = await pending;
  addLookupTiming(
    timings,
    "recall_stamp_ms",
    Number(process.hrtime.bigint() - stampStartedAt) / 1_000_000
  );

  localStampByScope.set(scope, initialStamp);
  localStampSyncedAtByScope.set(scope, Date.now());
  return initialStamp;
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
  kind: RecallCacheKind,
  timings?: Partial<RecallCacheLookupTimings>
): Promise<{ payload: T; createdAt: string } | null> {
  const scope = scopeKey(auth);
  const localStamp = localStampByScope.get(scope);
  const ttl = kind === "exact" ? FAST_RECALL_EXACT_TTL_SECONDS : FAST_RECALL_WARM_TTL_SECONDS;
  if (typeof localStamp === "number") {
    const key = kind === "exact" ? exactCacheKey(auth, query, localStamp) : warmCacheKey(auth, localStamp);
    const localStartedAt = process.hrtime.bigint();
    const localEnvelope = getLocalCache<RecallCacheEnvelope>(key);
    addLookupTiming(
      timings,
      "recall_local_ms",
      Number(process.hrtime.bigint() - localStartedAt) / 1_000_000
    );
    if (localEnvelope) {
      const localPayload = localEnvelope.payloads?.[slot];
      if (localPayload) return { payload: localPayload as T, createdAt: localEnvelope.createdAt };
    }

    const stampStartedAt = process.hrtime.bigint();
    const remoteStampPromise = getCacheJson<number>(stampCacheKey(auth))
      .catch(() => null)
      .finally(() => {
        addLookupTiming(
          timings,
          "recall_stamp_ms",
          Number(process.hrtime.bigint() - stampStartedAt) / 1_000_000
        );
      });
    const envelopeStartedAt = process.hrtime.bigint();
    const remoteEnvelopePromise = fetchEnvelopeFromRedis(key)
      .finally(() => {
        addLookupTiming(
          timings,
          "recall_redis_ms",
          Number(process.hrtime.bigint() - envelopeStartedAt) / 1_000_000
        );
      });
    const [remoteStampValue, remoteEnvelope] = await Promise.all([
      remoteStampPromise,
      remoteEnvelopePromise,
    ]);

    let effectiveStamp = localStamp;
    if (typeof remoteStampValue === "number" && Number.isFinite(remoteStampValue)) {
      effectiveStamp = Math.max(localStamp, remoteStampValue);
      localStampByScope.set(scope, effectiveStamp);
      localStampSyncedAtByScope.set(scope, Date.now());
    }

    if (remoteEnvelope && effectiveStamp === localStamp) {
      setLocalCache(key, remoteEnvelope, ttl);
      const remotePayload = remoteEnvelope.payloads?.[slot];
      if (remotePayload) return { payload: remotePayload as T, createdAt: remoteEnvelope.createdAt };
      return null;
    }

    if (effectiveStamp !== localStamp) {
      const nextKey = kind === "exact"
        ? exactCacheKey(auth, query, effectiveStamp)
        : warmCacheKey(auth, effectiveStamp);
      const nextEnvelope = await readCacheEnvelope(nextKey, ttl, timings);
      const nextPayload = nextEnvelope?.payloads?.[slot];
      if (!nextPayload) return null;
      return { payload: nextPayload as T, createdAt: nextEnvelope.createdAt };
    }
    return null;
  }

  const stamp = await readRecallStamp(auth, timings);
  const key = kind === "exact" ? exactCacheKey(auth, query, stamp) : warmCacheKey(auth, stamp);
  const envelope = await readCacheEnvelope(key, ttl, timings);
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
  slot: RecallCacheSlot,
  timings?: Partial<RecallCacheLookupTimings>
): Promise<T | null> {
  const hit = await readPayload<T>(auth, query, slot, "exact", timings);
  return hit?.payload ?? null;
}

export async function readWarmRecallPayload<T>(
  auth: AuthContext,
  query: string,
  slot: RecallCacheSlot,
  timings?: Partial<RecallCacheLookupTimings>
): Promise<T | null> {
  const hit = await readPayload<T>(auth, query, slot, "warm", timings);
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
  limit: number,
  types?: MemoryType[]
): Promise<{ contextBlock: string; memories: FastRecallMemoryItem[]; elapsedMs: number; relevanceMiss: boolean }> {
  const startedAt = Date.now();
  const bounded = Math.min(20, Math.max(1, limit));
  const maxRecent = Math.min(3, bounded);
  const rows = await memoryRepository.list(auth, Math.max(bounded * 2, 12), {
    types,
    includeSuperseded: false,
  });
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
