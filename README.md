# Tallei

> Ghost memory layer for ChatGPT, Claude, and Gemini. One place, all your AIs.

Tell one AI how you like things. Every other AI already knows. No re-explaining, no copy-pasting, no starting from scratch.

![Tallei Home](./dashboard/public/tallei-home.png)

---

## Recall: The Journey

```
Apr 14  ████████████████████████████  ~30,000ms  baseline
Apr 15  ██████████████████████████    ~24,000ms  in-memory cache
Apr 16  ████                          ~717ms     multi-layer cache — WRONG on first call
Apr 20  ██                            ~30ms / ~400ms  three-bucket recall, always correct
```

| Date | p50 | Approach | Accurate? |
|------|-----|----------|-----------|
| Apr 14 | ~30s | Full pipeline sync per call | ✓ |
| Apr 15 | ~24s | In-memory cache (60s TTL) | ✓ |
| Apr 16 | ~717ms | Multi-layer + async enrichment | ✗ first call |
| **Apr 20** | **~30ms / ~400ms** | **Three-bucket — always sync** | **✓ always** |

Apr 16 looked like a win. It wasn't. Fast wrong answer is worse than slow right answer.

---

## Three-Bucket Recall

```
recall_memories(query)
        │
        ▼
  LRU in-process cache  ~0ms  (10 min)
        │ miss
        ▼
  Redis exact cache      ~5ms  (120s, query-hash keyed)
        │ miss
        ▼
  Postgres: single fetch, decrypt all rows
        │
        ├── PREFERENCE bucket  (1,500 tok)  pinned → refcount order
        ├── LONG-TERM bucket   (4,800 tok)  dump-all ~30ms | hybrid ~400ms
        │     overflow: vector top-25 + BM25 top-15 + temporal top-5
        └── SHORT-TERM bucket  (1,700 tok)  ≤60 days, recency-first
        │
        └── write to LRU + Redis → return
```

Token estimation: `ceil(chars / 4)` — no tokeniser, zero overhead.

**Sorting within buckets:** preferences sort by pin → frequency; long-term dump-all by frequency; long-term overflow by a combined vector + BM25 + activity score; short-term strictly by recency with a decay penalty. See [ADR-011](docs/adr/011-three-bucket-recall.md) for the exact formulas.

**What's coming:**
- Promotion — short-term memories referenced 3+ times graduate to long-term automatically
- Eviction — long-term memories untouched for a year get soft-archived (still searchable, excluded from dump-all)
- Per-user short-term window — currently 60 days hardcoded, will tune based on memory volume

**Deliberately not doing:** LLM rerank (the host model already does this in-context for free), HyDE pre-embedding (adds latency, unnecessary for most users).

---

## Memory System

### Types

Seven types, classified automatically at save time.

| Type | Bucket | Detected by |
|------|--------|-------------|
| `preference` | preference | always pinned; identity, settings, favorites |
| `fact` | long-term | default |
| `decision` | long-term | architectural choices, commitments |
| `event` | short-term | timestamped occurrences |
| `note` | short-term | loose observations |
| `lesson` | long-term | "best practice", "learned that", "never do" |
| `failure` | long-term | "broke", "crashed", "outage", "postmortem" |

`lesson` and `failure` are first-class — they land in long-term and get recalled like facts, not buried.

### Access Freshness

Every recall hit bumps `reference_count` and updates `last_referenced_at`. Overflow scoring weights frequently-accessed memories higher, with exponential decay over 21 days so stale memories fade naturally.

### Provenance & Confidence

Confidence is inferred from `reference_count` — `UNCONFIRMED` at 1, `MED` at 2+, `HIGH` at 5+. Every memory also carries a `platform` tag and a `provenance` block (platform + timestamp) so you always know where it came from. Cross-platform conflicts on the same subject get flagged. Preferences supersede each other — old version soft-deleted, latest canonical.

---

## Fire-and-Forget Saves

```
save_memory() → return ~15ms ✓
               [background] summarize → embed → upsert vector → dedup check
```

Never await the full pipeline in the MCP handler. Background worker handles the rest.

---

## Gotchas

- **Fire-and-forget is intentional.** Don't await the save pipeline in the MCP handler.
- **Cache everything that hits OpenAI or pgvector.** OAuth token cache (10 min), LRU recall (10 min), Redis (120s).

---

## Docs

- [Setup guide](./setup.md)
- [Deployment](./docs/README.md)
- [ADR-011: Three-bucket recall](docs/adr/011-three-bucket-recall.md)
- [ADR-012: Graph layer removal](docs/adr/012-remove-graph-layer.md)

---

Business Source License 1.1.
