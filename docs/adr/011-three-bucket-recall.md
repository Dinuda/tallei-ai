# ADR-011: Three-Bucket Recall Architecture

**Status:** Accepted  
**Date:** 2026-04-20  
**Authors:** Dinuda

---

## Context

The previous recall architecture was built around a "speed-first" principle: return something immediately (lexical fallback), then run semantic search in the background to enrich the cache for the *next* request. This produced fast p50 latency numbers but had a critical accuracy flaw — the first response to any novel query was almost always wrong.

### Specific failures observed

1. **Background-enrichment lag.** `recall_memories("based on my AL results what should I do")` immediately returned a lexical match ("User prefers notebooks over loose paper") because the background semantic search hadn't run yet. The correct memory ("User has 3 A's in A/Ls…") only appeared on a second identical query.

2. **Tokenizer–abbreviation mismatch.** "A/Ls" tokenized to `["a", "ls"]` (slash stripped), so BM25 never matched the query token `"al"`. The memory was effectively invisible to all lexical signals.

3. **Pinned-preference flooding.** Every pinned preference was injected unconditionally on top of ranked results, with artificial score `10 + refBoost`. With 8+ pinned prefs, they consumed the entire context budget regardless of relevance to the query.

4. **Similarity-floor over-filtering.** The `SIMILARITY_FLOOR = 0.35` operated on *normalised* signal scores within the candidate set. A relevant memory ranked 10th in vector results could have a normalised score of 0.20, get filtered, and never appear — even when it was the only semantically correct answer.

5. **Semantic search optimised for precision, not recall.** RRF fusion + similarity floor were designed to surface one best answer. But since the LLM consuming the context is itself a reranker, optimising for precision at retrieval time only added failure modes. The right goal was *recall@30*, not *precision@1*.

### Why the previous architecture existed

The background-enrichment pattern was correct for the use case it was solving: sub-100ms MCP tool response time. Embedding + Qdrant search typically takes 300–800ms, which would have been unacceptable latency in the foreground.

However, "fast wrong answer" turned out to be worse than "slightly slower correct answer." A 500ms correct response is net-positive. A 50ms response that misleads the host LLM is net-negative.

---

## Decision

Replace the five-layer cache + background-enrichment + lexical-fallback pipeline with a **three-bucket synchronous recall** architecture.

### Buckets

Memories are classified into three buckets based on `memory_type`:

| Bucket | Types | Token budget | Strategy |
|---|---|---|---|
| **Preference** | `preference` | 1,500 tok | Always inject; sorted pinned → refcount |
| **Long-term** | `fact`, `decision` | 4,800 tok | Dump-all if fits; recall-first hybrid if overflow |
| **Short-term** | `event`, `note` | 1,700 tok | Recency-first; max 60 days old |
| **Total** | — | **8,000 tok** | — |

Token estimation: `ceil(chars / 4)` — fast, no tokenizer dependency.

### Preference bucket

Preferences are injected unconditionally, sorted by `is_pinned DESC, reference_count DESC`. The 1,500-token cap prevents flooding. This mirrors how ChatGPT treats its memory facts: dump them all and let the model decide relevance.

### Long-term bucket — dump-all path

If the total token count of all facts + decisions is ≤ 4,800 tokens, every memory in the bucket is included, sorted by `reference_count DESC`. No embedding, no vector search, no LLM call. A single Postgres query. The host LLM selects what's relevant in-context.

This is the correct approach for the majority of users (< ~60 long-term memories). It is also the approach that matches ChatGPT's behaviour for small memory sets.

### Long-term bucket — recall-first hybrid (overflow only)

When long-term memories exceed 4,800 tokens:

1. **Query expansion (static dict, zero latency).** Expand abbreviations before embedding:
   - `"al"` → `"a/l advanced level exam results academic"`
   - `"o/l"`, `"ict"`, `"uni"`, `"gpa"`, etc.
   
2. **Three signals in parallel.**
   - Vector top-25 (Qdrant cosine, no score floor)
   - BM25 top-15 (in-process, abbreviation-aware tokeniser)
   - Temporal top-5 (most recent — safety net for poor embeddings)

3. **Union, not intersection.** All candidate IDs from all three signals are merged. No RRF cutoff. No similarity floor. Token budget is the only filter.

4. **Scoring.** `(vector_rrf * 0.7 + bm25_norm * 0.3) * log(1 + refcount)`. Vector rank dominates; BM25 provides abbreviation coverage; refcount rewards frequently-accessed memories.

5. **Pack under budget.** Scored candidates are packed until the 4,800-token cap is reached.

### Short-term bucket

Events and notes are sorted by `created_at DESC`, filtered to the last 60 days, and packed into 1,700 tokens. No search — recency is the only signal for ephemeral context.

### Synchronous execution

`bucketRecall` is always awaited in the foreground. The total timeout is `config.memoryRecallTotalTimeoutMs` (default 12s production, 20s dev). On timeout the use case returns an empty context block rather than a wrong one.

### Caching

- **LRU in-process cache** (10-min TTL): unchanged. Still provides ~0ms repeat hits.
- **Redis exact cache** (120s TTL, keyed by `tenantId:userId:queryHash:stamp`): unchanged. Still survives restarts and cross-instance invalidation via stamp bump on save.
- **Redis warm cache**: removed. Was only needed to serve the background-enrichment path.
- **Precomputed graph snapshot**: removed from recall hot-path. The dump-all path makes it unnecessary for the majority of users.

---

## Tokenizer fix

Both `fast-recall.ts` and `hybrid-retrieval.ts` tokenisers now apply:

```typescript
.replace(/([a-z])\/([a-z])/g, "$1$2")  // A/L → al, A/Ls → als
```

before stripping non-alphanumeric characters. This makes "A/Ls" → "als" rather than "a" + "ls", enabling BM25 to match "al" queries against "A/Ls" text.

---

## Consequences

### Positive

- **First-call accuracy.** The correct memory is always in context on the first call, not only after a second identical query.
- **No pinned-preference flooding.** Preferences are capped at 1,500 tokens and cannot crowd out factual memories.
- **Simpler codebase.** Removed: `buildRecentFallback`, `readWarmRecallPayload`, `runBackgroundRecallEnrichment`, `lookupPrecomputedRecallV1`, `recallEnrichmentKey`, `semanticRecallMemories`. Net: ~200 lines deleted, ~250 lines added (bucket-recall.ts).
- **Deterministic context size.** Token budget caps mean the MCP response is always bounded and predictable.
- **Abbreviation coverage.** Static expansion dict handles common regional/domain abbreviations without an LLM call.

### Negative / trade-offs

- **First-call latency increases** for users with large memory sets (overflow path). Dump-all path: ~30ms. Overflow path: ~300–800ms (embed + Qdrant). Previously, the first call always returned in ~50ms (then corrected on the second call). Now the first call takes longer but is correct.
- **Warm cache removed.** Marginal latency benefit for repeat queries in the 45–120s window is lost.
- **Precomputed snapshots unused.** Snapshot infrastructure still exists and runs (for graph insights), but is no longer consulted in the recall hot-path.

### Neutral

- Save path unchanged. Fire-and-forget, background embedding, stamp-based cache invalidation — all unchanged.
- Shadow checks (`runRecallShadowChecks`) unchanged. v2 graph recall still runs in shadow mode.
- Quota enforcement moved inline to the `bucketRecall` wrapper in `services/memory.ts` rather than in a standalone function.

---

## Alternatives considered

### HyDE (Hypothetical Document Embeddings)

Generate a hypothetical memory text with gpt-4o-mini, embed it, search with the hypothetical embedding. Would improve recall for conversational queries where the query and stored text have low surface overlap.

**Rejected for now.** Adds ~150ms + ~$0.0002/call. The dump-all path makes it unnecessary for users with < ~60 long-term memories, which covers the majority. Can be added to the overflow path later if accuracy metrics show it's needed.

### LLM rerank

After hybrid retrieval, ask gpt-4o-mini "which of these memories is relevant to the query?" Keep only the flagged ones.

**Rejected for now.** Adds ~300ms + ~$0.0001/call. The host LLM (Claude/GPT-4) already does this reranking in-context for free. Only worth adding if precision@5 matters more than recall@30, which it doesn't given the host model.

### Cross-encoder rerank

Use a dedicated cross-encoder model (e.g., sentence-transformers reranker) to score (query, memory) pairs.

**Rejected.** Requires an additional inference endpoint. Complexity-to-benefit ratio too high for current scale.

### Keep background enrichment, fix the display

Show "loading..." in the context block while semantic search runs, update on next call.

**Rejected.** MCP tools don't support streaming responses or state updates mid-call. The host LLM sees one response per tool call.

---

## Future: promotion / eviction

Not in scope for this ADR, but the next natural extension:

- **Promotion:** short-term memory referenced 3+ times → convert `memory_type` to `"fact"`. Moves to long-term bucket automatically.
- **Eviction:** long-term memory not referenced for 1 year → soft-archive (keep in DB, exclude from dump-all, still searchable via overflow hybrid).
- **Short-term cutoff:** currently 60 days. Can be tuned per user based on memory volume.

---

## Files changed

| File | Change |
|---|---|
| `src/infrastructure/recall/bucket-recall.ts` | **New.** Three-bucket recall engine. |
| `src/orchestration/memory/recall.usecase.ts` | **Rewritten.** Simplified to LRU → Redis → bucketRecall. |
| `src/services/memory.ts` | Removed old deps; wired `bucketRecall` with quota check. |
| `src/infrastructure/recall/fast-recall.ts` | Removed `buildRecentFallback`; kept cache infrastructure. Fixed tokeniser. |
| `src/infrastructure/recall/hybrid-retrieval.ts` | Fixed tokeniser (`A/L` → `al`). Lowered `SIMILARITY_FLOOR` default to 0.15. Kept for overflow path. |
