import { createHash } from "node:crypto";

import { getCacheJson, setCacheJson } from "../../infrastructure/cache/redis-cache.js";
import { deleteTtlCacheEntry, getTtlCacheEntry, setTtlCacheEntry, type TtlCacheStore } from "../../infrastructure/cache/ttl-cache.js";

export type ComposioMetadataCachePolicy = {
  freshTtlMs: number;
  staleTtlMs: number;
  emptyTtlMs: number;
};

export type ComposioMetadataCacheEnvelope<T> = {
  value: T;
  fetchedAt: number;
  contentHash: string;
};

type ComposioMetadataCacheDependencies = {
  now?: () => number;
};

const LOCAL_CACHE_MAX_SIZE = 512;
const localCache: TtlCacheStore<ComposioMetadataCacheEnvelope<unknown>> = new Map();
const inflightRefreshes = new Map<string, Promise<ComposioMetadataCacheEnvelope<unknown>>>();

function stableJsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ttlForValue<T>(value: T, policy: ComposioMetadataCachePolicy): number {
  return Array.isArray(value) && value.length === 0 ? policy.emptyTtlMs : policy.freshTtlMs;
}

function staleTtlForValue<T>(value: T, policy: ComposioMetadataCachePolicy): number {
  return Array.isArray(value) && value.length === 0 ? policy.emptyTtlMs : policy.staleTtlMs;
}

function setLocalCacheEntry<T>(key: string, envelope: ComposioMetadataCacheEnvelope<T>, policy: ComposioMetadataCachePolicy): void {
  deleteTtlCacheEntry(localCache, key);
  setTtlCacheEntry(localCache, key, envelope, staleTtlForValue(envelope.value, policy), LOCAL_CACHE_MAX_SIZE);
}

function getLocalCacheEntry<T>(key: string, now: number, policy: ComposioMetadataCachePolicy): ComposioMetadataCacheEnvelope<T> | null {
  const cached = getTtlCacheEntry(localCache, key) as ComposioMetadataCacheEnvelope<T> | undefined;
  if (!cached) return null;
  const age = now - cached.fetchedAt;
  if (age >= staleTtlForValue(cached.value, policy)) {
    deleteTtlCacheEntry(localCache, key);
    return null;
  }
  return cached;
}

function isFresh<T>(entry: ComposioMetadataCacheEnvelope<T>, now: number, policy: ComposioMetadataCachePolicy): boolean {
  return now - entry.fetchedAt < ttlForValue(entry.value, policy);
}

function isStale<T>(entry: ComposioMetadataCacheEnvelope<T>, now: number, policy: ComposioMetadataCachePolicy): boolean {
  const age = now - entry.fetchedAt;
  return age >= ttlForValue(entry.value, policy) && age < staleTtlForValue(entry.value, policy);
}

function getNow(dependencies?: ComposioMetadataCacheDependencies): number {
  return dependencies?.now?.() ?? Date.now();
}

function startRefresh<T>(
  key: string,
  load: () => Promise<T>,
  policy: ComposioMetadataCachePolicy,
  dependencies?: ComposioMetadataCacheDependencies,
): Promise<ComposioMetadataCacheEnvelope<T>> {
  const existing = inflightRefreshes.get(key) as Promise<ComposioMetadataCacheEnvelope<T>> | undefined;
  if (existing) return existing;

  const pending = (async () => {
    const remote = await getCacheJson<ComposioMetadataCacheEnvelope<T>>(key).catch(() => null);
    const now = getNow(dependencies);
    if (remote) {
      setLocalCacheEntry(key, remote, policy);
      if (isFresh(remote, now, policy)) {
        return remote;
      }
    }

    const value = await load();
    const envelope: ComposioMetadataCacheEnvelope<T> = {
      value,
      fetchedAt: getNow(dependencies),
      contentHash: stableJsonHash(value),
    };
    setLocalCacheEntry(key, envelope, policy);
    await setCacheJson(key, envelope, Math.max(1, Math.ceil(staleTtlForValue(value, policy) / 1000)));
    return envelope;
  })().finally(() => {
    const active = inflightRefreshes.get(key);
    if (active === pending) inflightRefreshes.delete(key);
  });

  inflightRefreshes.set(key, pending);
  return pending;
}

export async function readComposioMetadata<T>(
  key: string,
  load: () => Promise<T>,
  policy: ComposioMetadataCachePolicy,
  dependencies?: ComposioMetadataCacheDependencies,
): Promise<T> {
  const now = getNow(dependencies);
  const local = getLocalCacheEntry<T>(key, now, policy);
  if (local) {
    if (isFresh(local, now, policy)) return local.value;
    if (isStale(local, now, policy)) {
      void startRefresh(key, load, policy, dependencies).catch(() => {});
      return local.value;
    }
  }

  const inflight = inflightRefreshes.get(key) as Promise<ComposioMetadataCacheEnvelope<T>> | undefined;
  if (inflight) {
    const envelope = await inflight;
    return envelope.value;
  }

  const remote = await getCacheJson<ComposioMetadataCacheEnvelope<T>>(key).catch(() => null);
  const remoteNow = getNow(dependencies);
  if (remote) {
    setLocalCacheEntry(key, remote, policy);
    if (isFresh(remote, remoteNow, policy)) return remote.value;
    if (isStale(remote, remoteNow, policy)) {
      void startRefresh(key, load, policy, dependencies).catch(() => {});
      return remote.value;
    }
  }

  const envelope = await startRefresh(key, load, policy, dependencies);
  return envelope.value;
}

export function resetComposioMetadataCacheForTests(): void {
  localCache.clear();
  inflightRefreshes.clear();
}
