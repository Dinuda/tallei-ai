# ADR-004 — Removal of legacy mem0ai fallback path

**Status**: Accepted  
**Date**: 2026-04-18

## Context

`src/services/legacyMemory.ts` was a wrapper around the `mem0ai` SDK used as a last-resort fallback when the primary recall path failed. It was reached only when both vector search and lexical recall failed entirely — an extremely rare condition. The `mem0ai` package added ~45MB to `node_modules`, brought its own OpenAI client instance (conflicting with our adapter pattern), and had no resilience wiring compatible with the new circuit-breaker registry.

The new resilience layer (ADR-002) handles transient failures at the capability level. When vector search is unavailable, the recall path degrades to lexical BM25. When both are unavailable, the fallback chain returns an empty result set with `source: "empty"` — this is honest and auditable rather than silently switching to a third retrieval system with different semantics.

## Decision

`src/services/legacyMemory.ts` is deleted. The `mem0ai` package is uninstalled. The recall degradation chain is:

```
vector cache hit → return cached
exact Redis hit  → return cached, enrich in background
warm Redis hit   → return warm, enrich in background
precomputed graph snapshot hit → return snapshot
recent BM25 fallback → return recent, enrich in background
empty → return { memories: [], contextBlock: "" }
```

No step in this chain calls `mem0ai`.

## Consequences

- `mem0ai` removed from `package.json` and `node_modules` (148 packages collectively removed with other unused SDKs).
- `legacyMemory.ts` deleted; no import references remain.
- Recall degradation is fully observable via the `source` field in recall results and `action: "recall"` audit events.
- In the extremely unlikely case of simultaneous vector + lexical failure, users receive an empty recall rather than a fallback that may return stale or semantically mismatched memories from a separate store.
