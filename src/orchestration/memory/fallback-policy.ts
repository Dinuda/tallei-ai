export type RecallSource =
  | "exact_cache"
  | "warm_cache"
  | "recent_fallback"
  | "semantic_enriched"
  | "precomputed_graph_hit"
  | "precomputed_graph_miss"
  | "precomputed_graph_stale";

export type SnapshotStatus = "hit" | "miss" | "stale" | "error" | "disabled";

export function selectFallbackSource(status: SnapshotStatus): RecallSource {
  if (status === "miss") return "precomputed_graph_miss";
  if (status === "stale") return "precomputed_graph_stale";
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
