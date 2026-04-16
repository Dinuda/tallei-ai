# Changelog

All notable changes are documented here. Each entry covers what changed, why it matters, and the measured latency impact.

---

## [Unreleased] — 2026-04-16

### The Recall Latency Arc

```
Apr 14  ~30,000ms   baseline synchronous pipeline
Apr 15  ~24,000ms   basic in-memory cache
Apr 16  ~717ms      multi-layer cache + background enrichment (13x improvement)
```

---

### perf: multi-layer recall cache with background enrichment

**What changed:**

Replaced the single in-memory cache with a four-layer recall stack. Every recall now returns from the shallowest available layer without touching the embedding or vector search pipeline in the foreground:

```
Layer 1  In-process Map         ~0ms    10 min TTL
Layer 2  Redis exact cache      ~5ms    120s TTL, keyed on (userId, queryHash, limit)
Layer 3  Redis warm cache       ~5ms    45s TTL, serves stale + triggers async enrichment
Layer 4  Precomputed snapshot   ~50ms   built from graph data after every save
Layer 5  Recent fallback        ~200–700ms  lexical + recency scoring, zero I/O ops
```

Background enrichment: when Layers 3–5 are served, a background job runs the full semantic pipeline (embed → vector search → rerank) and writes the result back into Layers 2–3 for the next caller.

**Measured impact (production, 2026-04-16):**
```
duration_ms=2216   handler_ms=716   recall_total_ms=717
recall_embed_ms=0   recall_vector_ms=0   recall_source=precomputed_graph_miss
```

Cold boot (precomputed snapshot not yet warmed): **717ms handler, zero embedding ops**.  
Warm precomputed snapshot: **~50ms**.  
Exact or warm Redis cache: **~5ms**.

**Files:** `src/services/memory.ts`, `src/services/fastRecall.ts`, `src/services/precomputedGraphRecall.ts`

---

### perf: precomputed graph recall snapshots

**What changed:**

After every `save_memory` call, a background job (`queueSnapshotRefresh`) builds a compact JSON snapshot of the user's memory graph — entities, relations, memory metadata. On recall, this snapshot is scored against the query using entity-weighted lexical matching, returning results in ~50ms without touching the embedding API.

The snapshot is stored in Redis with the user's recall stamp. When a new save invalidates the stamp, the snapshot is marked stale and refreshed asynchronously. Callers get the stale result immediately (with a `recall_snapshot_status=stale` flag) while the refresh runs in the background.

**Files:** `src/services/precomputedGraphRecall.ts`

---

### feat: LLM reranker + RAG fallback

**What changed:**

Two accuracy layers added after vector search:

1. **LLM Reranker** (`gpt-4o-mini`): filters vector search results that don't actually answer the query. Eliminates bi-encoder false positives — e.g. "favorite language" and "favorite ice cream" sharing a semantic cluster.

2. **RAG Fallback**: when vector search and reranker both return nothing (stale index, missing embeddings), a full table scan loads every DB memory and asks the LLM which are relevant. Returns real results to the user immediately, then triggers a background reindex so vector search works next time.

**Files:** `src/services/reranker.ts`, `src/services/memory.ts`

---

## [0.3.0] — 2026-04-15

### perf: basic in-memory recall cache

Added an in-memory `Map<string, CachedRecall>` keyed on `(tenantId, userId, queryHash, limit)` with a 60s TTL. Warm cache hits returned in ~5ms. Cold misses still ran the full embed → vector search → fetch pipeline (~24s).

**Measured impact:** ~30s → ~24s for cold recalls. Cache hit rate ~70% in practice.

**Files:** `src/services/memory.ts`

---

### perf: singleton Memory instance + OAuth token cache

- **Singleton `MemoryRepository`/`VectorRepository`**: Previously instantiated on every request, re-initializing DB connection pool handles. Now created once at module load.
- **OAuth token cache (10 min TTL)**: `verifyAccessToken()` results cached per token hash. Avoids repeated crypto and DB lookups on every MCP tool call.

**Files:** `src/services/memory.ts`, `src/mcp/server.ts`

---

### perf: fire-and-forget save pipeline

`saveMemory()` now returns after writing the encrypted memory to Postgres (~15ms). Vector embedding, Qdrant upsert, and graph extraction are all kicked off as background work via unawaited async IIFEs and job queues.

Previous behavior: `summarize → embed → upsert vector → return` (~2–4s).  
New behavior: `summarize (async) → DB write → return (~15ms)` — everything else is background.

**Files:** `src/services/memory.ts`

---

## [0.2.0] — 2026-04-14

### feat: graph extraction pipeline

- Background worker extracts entities and relations from every saved memory using `gpt-4o-mini`.
- Entities and relations stored in Postgres (`memory_entities`, `memory_relations`, `memory_mentions` tables).
- `recall_memories_v2` added: graph-traversal recall that surfaces connected entities alongside direct matches.
- Insight engine: contradiction detection, stale decision flagging, high-frequency entity tracking.

**Files:** `src/services/memoryGraph.ts`, `src/services/memoryGraphExtractor.ts`, `src/services/memoryGraphWorker.ts`, `src/services/memoryInsights.ts`

---

### feat: dual-write + shadow read for migration safety

While migrating from `mem0ai` SDK to native Postgres, all saves and recalls ran against both paths simultaneously. Shadow reads logged divergences to `memory_events` for auditing without surfacing errors to users.

**Files:** `src/services/legacyMemory.ts`, `src/services/memory.ts`

---

## [0.1.0] — Initial release

- MCP server: `save_memory`, `recall_memories`, `list_memories`, `delete_memory` tools
- Google OAuth for dashboard + MCP connector auth
- Postgres + pgvector storage via `mem0ai` SDK
- OpenAI embeddings (`text-embedding-3-small`) + `gpt-4o-mini` summaries
- Next.js dashboard: memory feed, setup wizard, API key management
- Platform color badges: Claude (purple), ChatGPT (green), Gemini (blue)
