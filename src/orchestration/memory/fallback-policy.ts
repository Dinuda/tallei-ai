export type RecallSource =
  | "exact_cache"
  | "warm_cache"
  | "recent_fallback"
  | "semantic_enriched";

export type SnapshotStatus = "hit" | "miss" | "stale" | "error" | "disabled";

export function selectFallbackSource(_status: SnapshotStatus): RecallSource {
  return "recent_fallback";
}

export function buildFallbackTimings(input: {
  readonly cacheLookupMs: number;
  readonly fallbackElapsedMs: number;
  readonly relevanceMiss: boolean;
}): Record<string, number> {
  return {
    cache_lookup_ms: input.cacheLookupMs,
    fallback_ms: input.fallbackElapsedMs,
    total_ms: input.fallbackElapsedMs,
    relevance_miss: input.relevanceMiss ? 1 : 0,
  };
}
