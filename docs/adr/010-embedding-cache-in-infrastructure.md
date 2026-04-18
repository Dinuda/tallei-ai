# ADR-010 — Embedding cache lives in infrastructure, not the provider

**Status**: Accepted  
**Date**: 2026-04-18

## Context

The original `src/services/embeddings.ts` mixed two concerns: cache management (in-memory LRU + Redis backing) and OpenAI SDK invocation. When swapping to a different provider, the cache had to be rewritten too. When writing tests, the whole embeddings module needed to be stubbed to avoid hitting OpenAI.

An alternative was to put the cache inside `OllamaProvider.embed()` — but then caching would be reimplemented per provider, and the cache invalidation semantics would be duplicated.

## Decision

The embedding cache is a cross-cutting infrastructure concern, not a provider detail. It lives at `src/infrastructure/cache/embedding-cache.ts` and provides:

```typescript
embedText(text: string): Promise<number[]>
```

Internally it:
1. Checks an in-memory LRU (keyed by `sha256(text)`, 1000 entries, 10-min TTL).
2. Falls through to `ProviderRegistry.embed(req)` on a miss.
3. Writes the result back to the LRU.

The provider adapters (`OpenAiProvider`, `OllamaProvider`) never touch the cache. They only implement `embed(req)` → `EmbeddingResponse`.

## Consequences

- Swapping the active provider leaves the embedding cache intact and warm.
- Tests that want to exercise embedding-cached paths inject a stub `embedText` function — no provider mock needed.
- The cache key is content-hash-based, making it stable across provider swaps (same text → same cache hit regardless of which provider produced the vector).
- `src/services/embeddings.ts` is replaced by a re-export shim during the transition period and deleted in Phase 5.
- Redis-backed embedding cache (if enabled) uses the same key scheme, allowing cache warm-up to persist across restarts.
