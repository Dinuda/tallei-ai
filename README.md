# Tallei AI

> A ghost memory system that lets Claude, ChatGPT, and Gemini actually remember stuff. Cross-AI, graph-aware, blazing fast.

Tallei's a memory layer for when you want your AI to not forget who you are. It remembers facts, preferences, and context across sessions and different AI platforms. The real differentiator? A graph layer that goes way beyond vector search—so it catches contradictions, shows you relationships between ideas, and doesn't slow down your workflow.

![Tallei Home](./dashboard/public/tallei-home.png)

## What You Get

### Recent Changes (April 2026)
- **Three-bucket recall** — memories are now split into preference / long-term / short-term buckets, each with a fixed token budget. Semantic search runs synchronously so the first call always returns the right memory. See [ADR-011](docs/adr/011-three-bucket-recall.md).
- **Graph layer removed** — LLM entity extraction pipeline removed. The host LLM (Claude/GPT-4) does relationship reasoning in-context for free, with higher accuracy and no extra API cost. See [ADR-012](docs/adr/012-remove-graph-layer.md).
- **Dump-all for small memory sets** — users with < ~60 long-term memories get everything injected directly (ChatGPT-style). No embedding, no vector search, ~30ms.
- **Recall-first hybrid for overflow** — union of vector top-25 + BM25 top-15 + temporal top-5, no similarity floor, token-budget-capped. Maximises recall so the host LLM acts as reranker.
- **Abbreviation expansion** — static dict expands "AL" → "advanced level exam results" before embedding and BM25, fixing retrieval for regional/domain abbreviations.
- **Preference-first memory model** — memories now have `memory_type`, `category`, `is_pinned`, `reference_count`, `last_referenced_at`, and `superseded_by`.
- **Deduplicated saves** — duplicate content or near-duplicate vector matches increment `reference_count` instead of creating noisy rows.
- **New preference tools/APIs** — `save_preference`, `list_preferences`, `forget_preference` and type-scoped recall (`types` filter).
- **Split runtime instructions** — Claude and ChatGPT now have separate instruction sets (`instructions/claude.md`, `instructions/chatgpt.md`).
- **ChatGPT Actions OpenAPI endpoint** — stable importer URL: `/chatgpt/actions/openapi.json`.

### The Basics
- **Share memories across Claude, ChatGPT, and Gemini** via OAuth. One memory graph, all your AIs.
- **Sub-15ms saves** — we return instantly, then do the heavy lifting in the background.
- **Fast recall under real load** — LRU cache hits ~0ms, Redis hits ~5ms, dump-all cold miss ~30ms, overflow hybrid ~400ms. Always semantically correct on the first call.
- **Smart summaries** — `gpt-4o-mini` pulls out titles, key points, and decisions without you asking.


### The Dashboard
- **Clean UI** — light greenish-yellow and lime theme (because dark mode is boring).
- **Memory feed** — search, filter, all your saved stuff in one place.
- **Interactive graph explorer** — drag around entities, see relationships, get insights.
- **Setup wizards** — copy-paste to connect Claude, ChatGPT, Gemini. Takes 2 minutes.

## Stack

- **Backend:** Node.js, Express, MCP (talking to Claude/ChatGPT/Gemini)
- **Frontend:** Next.js, Tailwind CSS v4, React
- **Database:** Postgres + pgvector for vectors, plus native tables for the graph (entities, relations, mentions)
- **AI:** OpenAI embeddings, gpt-4o-mini for summaries, mem0ai SDK
- **Auth:** Google OAuth, JWT sessions
## How It's Built

### Backend (`/src`)
The MCP server that Claude and friends talk to:
- **MCP tools** — save_memory, save_preference, recall_memories, list_memories, list_preferences, delete_memory, forget_preference
- **Vector layer** — embeddings and semantic search via OpenAI
- **Three-bucket recall** — preference / long-term / short-term buckets, each with a fixed token budget. Dump-all for small sets, recall-first hybrid for overflow.
- **Caching** — OAuth token cache (10 min), in-process LRU recall cache (10 min), Redis exact cache (120s).

### Frontend (`/dashboard`)
- **Memory feed** — browse what you've saved, search it, see where it came from
- **Setup wizard** — 4-step walk-through to connect Claude/ChatGPT/Gemini. Done in 2 min.
- **Dashboard** — sidebar nav, search bar. Responsive, works on phone too.

## Technical Highlights

### Recall Latency: The Journey (Production)

```
End-to-end recall latency (p50, production)

Apr 14  ████████████████████████████████████████████████████████████  ~30,000ms  (baseline)
Apr 15  ████████████████████████████████████████████████  ~24,000ms  (in-memory cache)
Apr 16  ████  ~717ms  (multi-layer cache + background enrichment)
Apr 20  ██    ~30ms dump-all / ~400ms overflow  (three-bucket recall, always correct)

           0                    10s                   20s                   30s
```

| Date   | p50 latency | Approach | Accuracy |
|--------|-------------|----------|----------|
| Apr 14 | ~30s | Baseline — full pipeline synchronous per call | ✓ |
| Apr 15 | ~24s | In-memory recall cache (60s TTL) | ✓ |
| Apr 16 | ~717ms handler | Multi-layer cache + lexical fallback + background semantic enrichment | ✗ first call |
| **Apr 20** | **~30ms / ~400ms** | **Three-bucket recall — synchronous, always correct** | **✓ always** |

Apr 16 looked fast but the first response to any novel query was the wrong memory. Apr 20 is slightly slower on overflow but always returns the semantically correct result on the first call.

---

### Three-Bucket Recall Architecture

Every recall request walks this path synchronously — no background jobs, no "correct answer on the second call":

```
recall_memories(query)
        │
        ▼
┌───────────────────────────────┐
│  LRU in-process cache         │  ~0ms   (10 min TTL)
└───────────────┬───────────────┘
                │ miss
                ▼
┌───────────────────────────────┐
│  Redis exact cache            │  ~5ms   (120s TTL, query-hash keyed)
└───────────────┬───────────────┘
                │ miss
                ▼
┌───────────────────────────────────────────────────────┐
│  bucketRecall (src/infrastructure/recall/bucket-recall.ts) │
│                                                       │
│  Single Postgres fetch → decrypt all rows             │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ PREFERENCE bucket  (1 500 tok cap)              │  │
│  │ Always inject, sorted: pinned → refcount        │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ LONG-TERM bucket   (4 800 tok cap)              │  │
│  │ facts + decisions                               │  │
│  │                                                 │  │
│  │  fits? → dump all, sorted by refcount    ~30ms  │  │
│  │  overflow? → recall-first hybrid:       ~400ms  │  │
│  │    1. expand abbreviations (static dict, 0ms)   │  │
│  │    2. vector top-25  (no score floor)           │  │
│  │    3. BM25 top-15    (abbrev-aware tokeniser)   │  │
│  │    4. temporal top-5 (safety net)               │  │
│  │    union → score → pack under budget            │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ SHORT-TERM bucket  (1 700 tok cap)              │  │
│  │ events + notes, ≤ 60 days old, recency-first    │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  → write to LRU + Redis → return context block        │
└───────────────────────────────────────────────────────┘
```

**The key insight:** the host LLM (Claude/GPT-4) is the reranker. The retrieval layer's job is **recall**, not precision — get the right memory into the context window and let the model decide what's relevant. "Fast wrong answer" is strictly worse than "slightly slower correct answer."

Token estimation is `ceil(chars / 4)` — no tokeniser dependency, zero overhead.

See [ADR-011](docs/adr/011-three-bucket-recall.md) for full rationale, alternatives considered, and trade-offs.

---

### Fire-and-Forget Saves

```
save_memory() ──→ summarize (async) ──→ DB write ──→ return ~15ms ✅
                                            │
                                            └──→ [background]
                                                  embed text
                                                  upsert vector
                                                  extract graph entities
                                                  queue snapshot refresh
```

The response comes back before the embedding even starts. Graph extraction and snapshot refresh are enqueued and run after the caller has moved on.

---

### LLM Reranker + RAG Fallback

Vector search has a known failure mode: bi-encoder models match semantic clusters, not intent. "Favorite language" and "favorite ice cream" look similar to an embedding model.

Two layers fix this:

1. **LLM Reranker** (`gpt-4o-mini`) — runs after vector search, filters candidates that don't actually answer the query. Kills false positives before they reach the context block.

2. **RAG Fallback** — when the vector index is stale or missing embeddings entirely, we full-scan every DB memory and ask the LLM which ones are relevant. Slower (~1–2s) but always correct. Triggers a background reindex so vector search works next time.

---

## Getting Started

To get Tallei running locally, check out our comprehensive setup guide:

**[Read the Setup Guide (setup.md)](./setup.md)**

## Deployment Docs

Production deployment and troubleshooting docs live under:

**[docs/README.md](./docs/README.md)**

## Why This Is Different

Three-bucket recall means memories are always injected in the right order: preferences first, then long-term facts, then recent events. For most users the entire context fits under the token budget with no vector search needed (~30ms). For larger memory sets the recall-first hybrid (vector + BM25 + temporal) optimises for recall — getting the right memory into the context window so the host LLM can do the reasoning.

### Fire-and-Forget: The Trick

```
save_memory() → return immediately (~15ms) ✅
               [background] embed → upsert vector → summarize → update row
```

Traditional approach: `save → extract → embed → store → return (~4.5s)`. Way too slow.

The full technical breakdown is in the [Technical Highlights](#technical-highlights) section above.

---

## What's Next

### Phase 1: Fish-Brain (What I'm Thinking About Lately)

The "recency and frequency" layer. I want to know what I've been obsessing over:

```
Your interests over time:
├── React (5 mentions this week, trending up)
├── Remote work (3 mentions, stable)
└── Kubernetes (1 mention, new interest?)
```

Real features:
- Hot topics widget (what's on your mind *right now*)
- Mention velocity (growing interest? losing interest?)
- Time-series graphs (are you still into this tech?)
- "Last touched" for decisions (which ones are stale?)
- Recency boost in recalls (recent memories ranked higher)

This is the "fish brain" thing—only remembers what matters *now*.

### Phase 2: Gemini Integration

Right now we support Claude (MCP) and ChatGPT (via OAuth). Adding Gemini next so it's truly cross-AI. Same setup, same memory.

### Phase 3: Memory Compression

Old memories stack up. Compress old clusters into summaries so you can archive stuff without losing the context.

### Phase 4: Cross-AI Fusion

Right now memories are tagged by platform. Phase 4 merges them:
- Unified memory namespace across all platforms
- "You mentioned this in Claude and ChatGPT—consolidate?"
- Platform-specific insights ("You mostly code in ChatGPT")

---

## Contributing

Want to add stuff? Cool. Just remember: if it's gonna be slow, we need to cache it. If it talks to OpenAI or the database, cache the result. The whole point is to keep MCP tool latency under 100ms.

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `perf:`. Just keep it clear.
- After changing stuff in `/dashboard`, run `npx tsc --noEmit` so we don't ship TypeScript errors.

## 📄 License

MIT License.
