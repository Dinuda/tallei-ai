export type TtlCacheEntry<T> = {
  value: T;
  exp: number;
};

export type TtlCacheStore<T> = Map<string, TtlCacheEntry<T>>;

export function getTtlCacheEntry<T>(store: TtlCacheStore<T>, key: string): T | undefined {
  const cached = store.get(key);
  if (!cached) return undefined;
  if (cached.exp <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return cached.value;
}

export function setTtlCacheEntry<T>(
  store: TtlCacheStore<T>,
  key: string,
  value: T,
  ttlMs: number,
  maxSize: number,
): void {
  if (store.size >= maxSize && !store.has(key)) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
  }
  store.set(key, { value, exp: Date.now() + ttlMs });
}

export function deleteTtlCacheEntry<T>(store: TtlCacheStore<T>, key: string): void {
  store.delete(key);
}
