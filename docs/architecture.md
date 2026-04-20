# Tallei — Architecture

## System overview

Tallei is a cross-AI ghost memory service that bridges Claude, ChatGPT, and Gemini through an OAuth-gated memory store.

```
┌──────────────┐     MCP (HTTP SSE)     ┌──────────────────────────────────────┐
│  Claude.ai   │ ─────────────────────► │                                      │
│  ChatGPT     │     HTTP REST API      │          Tallei Backend               │
│  Gemini      │ ─────────────────────► │         (Node.js / Express)           │
└──────────────┘                        └──────────────────────────────────────┘
                                                        │
                          ┌─────────────────────────────┼──────────────────┐
                          ▼                             ▼                  ▼
                   ┌─────────────┐             ┌──────────────┐    ┌──────────────┐
                   │  PostgreSQL  │             │    Qdrant    │    │    Redis     │
                   │  (memories, │             │  (vectors)   │    │   (cache,    │
                   │   graphs)   │             │              │    │    quota)    │
                   └─────────────┘             └──────────────┘    └──────────────┘
```

---

## Layer diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  bootstrap/                                                              │
│  composition-root.ts · container.ts · server.ts · workers.ts           │
│  (sole wiring point — imports everything; nothing imports from here)    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ wires
          ┌─────────────────────────┼───────────────────────┐
          ▼                         ▼                        ▼
┌─────────────────┐      ┌───────────────────┐    ┌───────────────────────┐
│   transport/    │      │  orchestration/   │    │    providers/ai/      │
│                 │      │                   │    │                       │
│  http/          │─────►│  memory/          │───►│  AiProvider iface     │
│   routes/       │      │   save.usecase    │    │  OpenAiProvider       │
│   middleware/   │      │   recall.usecase  │    │  OllamaProvider       │
│   dto/          │      │   list.usecase    │    │  ProviderRegistry     │
│  mcp/           │      │   delete.usecase  │    │  prompt-templates/    │
│   tools/        │      │                   │    └─────────┬─────────────┘
│   schemas.ts    │      │  ai/              │              │ uses
│  (FROZEN API)   │      │   summarize       │    ┌─────────▼─────────────┐
└─────────────────┘      │   rerank          │    │    resilience/        │
                         │   fact-extract    │    │                       │
                         │                   │    │  retry.ts             │
                         │                   │    │  timeout.ts           │
                         │  browser/         │    │  circuit-breaker.ts   │
                         │  billing/         │    │  policy.ts            │
                         └────────┬──────────┘    │  policies.ts          │
                                  │ depends on    │  registry.ts          │
          ┌───────────────────────┼───────────────┴───────────────────────┘
          ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  infrastructure/                                                         │
│                                                                          │
│  repositories/          vector/              cache/                      │
│   memory.repository     qdrant-client        redis-cache                 │
│   vector.repository    vector-store         memory-cache                │
│                                              embedding-cache             │
│                                                                          │
│  db/                    crypto/              auth/                       │
│   pool                  memory-crypto        jwt                         │
│   schema                                     supabase-client             │
│   migrations                                                             │
│                                                                          │
│  recall/                browser/             billing/                    │
│   bucket-recall         browser-worker       lemonsqueezy.client         │
│   hybrid-retrieval      fallback-cache                                   │
│   fast-recall (cache)                                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                  │ pure types only
          ┌───────────────────────┼──────────────────────────────────────────┐
          ▼                       ▼                                           ▼
┌──────────────────┐   ┌────────────────────┐   ┌─────────────────────────────┐
│    domain/       │   │  observability/    │   │        shared/              │
│                  │   │                   │   │                             │
│  memory/         │   │  logger.ts         │   │  errors/                   │
│  auth/           │   │  metrics.ts        │   │   AppError hierarchy       │
│  tenant/         │   │  request-timing.ts │   │  result.ts                 │
│  (pure types,    │   │  tracing.ts        │   │  async-safe.ts             │
│   no I/O)        │   │                   │   │  ids.ts                    │
│                  │   └───────────────────┘   └─────────────────────────────┘
└──────────────────┘
          │
          ▼
┌──────────────────┐
│    config/       │
│                  │
│  load.ts         │
│  schema.ts       │
│  feature-flags.ts│
└──────────────────┘
```

---

## Request flow — MCP `save_memory`

```
Claude.ai
    │  POST /mcp  {"method":"tools/call","params":{"name":"save_memory",...}}
    ▼
transport/mcp/tools/save-memory.ts
    │  verifies OAuth token (oauthTokens cache, 10-min TTL)
    │  validates input with frozen JSON Schema
    ▼
orchestration/memory/save.usecase.ts  (SaveMemoryUseCase.execute)
    │
    ├─ summarize + classify memory type/category (server-decided)
    ├─ dedup pass (content hash + high-sim vector match) -> bump reference_count if duplicate
    ├─ encrypt content (infrastructure/crypto/memory-crypto.ts)
    ├─ consume monthly quota (Redis; fail-open for free plan)
    ├─ INSERT row → infrastructure/repositories/memory.repository.ts → PG
    ├─ for preferences: supersede conflicting active preference rows via superseded_by
    │
    └─ BACKGROUND (fire-and-forget):
        ├─ embed text  → providers/ai/registry.ts → OpenAiProvider.embed
        │               (wrapped by embedPolicy: 5s timeout, 3× retry, CB)
        ├─ upsert vector → infrastructure/vector/vector-store.ts → Qdrant
        │                  (wrapped by vectorUpsertPolicy)
        ├─ extract facts → orchestration/ai/fact-extract.usecase.ts
        └─ summarize + update row → orchestration/ai/summarize.usecase.ts
    │
    └─ returns {memoryId, title, summary} immediately (~10–30ms p50)
```

---

## Request flow — MCP `recall_memories`

```
Claude.ai
    │  POST /mcp  {"method":"tools/call","params":{"name":"recall_memories",...}}
    ▼
transport/mcp/tools/recall-memories.ts
    ▼
orchestration/memory/recall.usecase.ts  (RecallMemoryUseCase.execute)
    │
    ├─ check in-memory LRU cache (10 min TTL) → hit: return ~0ms
    ├─ check Redis exact-match cache (120s TTL) → hit: return ~5ms
    │
    └─ MISS PATH: infrastructure/recall/bucket-recall.ts (bucketRecall)
        │
        ├─ single DB fetch: all non-deleted memories (one Postgres query)
        ├─ decrypt all rows
        ├─ split into three buckets by memory_type:
        │
        ├─ PREFERENCE bucket (1 500 tok cap)
        │   sort: is_pinned DESC, reference_count DESC
        │   strategy: always inject, no search
        │
        ├─ LONG-TERM bucket (4 800 tok cap) — facts + decisions
        │   if total tokens ≤ 4 800:
        │     dump all, sorted by reference_count DESC  (~30ms total)
        │   else (overflow):
        │     1. expand query abbreviations (static dict, 0ms)
        │     2. vector top-25 → Qdrant (no score floor)
        │     3. BM25 top-15 → in-process (abbreviation-aware tokeniser)
        │     4. temporal top-5 (most recent, safety net)
        │     5. union + score + pack under budget
        │
        └─ SHORT-TERM bucket (1 700 tok cap) — events + notes ≤ 60 days old
            sort: created_at DESC
            strategy: recency-first, no search
        │
        ├─ write result to LRU + Redis exact cache
        └─ return combined context block (~30ms dump-all / ~400ms overflow)
```

See [ADR-011](adr/011-three-bucket-recall.md) for full rationale and trade-offs.

---

## Provider adapter

All LLM/embedding I/O flows through a single seam:

```typescript
// providers/ai/ai-provider.ts
interface AiProvider {
  readonly name: "openai" | "ollama";
  capabilities(): ProviderCapabilities;
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}
```

`ProviderRegistry` (singleton built in `composition-root.ts`) selects the active provider from `config.llmProvider`. Providers wrap SDK calls with `AbortSignal`-aware timeout + retry + circuit-breaker via `src/resilience/policies.ts`.

---

## Resilience policy matrix

| Capability | Timeout | Retry | Circuit breaker (fail/cool/probe) | Degradation |
|---|---|---|---|---|
| `chat` | 10 s | 2× exp-500ms, 2s cap | 5 / 30s / 2 | propagate to caller |
| `embed` | 5 s | 3× exp-300ms, 1.5s cap | 8 / 20s / 2 | recall falls to lexical |
| `rerank` | 8 s | 1× | 3 / 60s / 1 | return vector-only hits, `degraded=true` |
| `summarize` | 15 s | 1× | 3 / 60s / 1 | return raw content truncated |
| `fact-extract` | 10 s | 1× | 3 / 60s / 1 | skip; save without facts |
| `vector.search` | 8 s | 2× exp-300ms | 6 / 30s / 2 | fall to lexical |
| `vector.upsert` | 10 s | 3× exp-500ms | 6 / 30s / 2 | PG row persists; `degraded:"vector_unavailable"` |
| `cache (Redis)` | 800 ms | 0 | existing cooldown | miss = absent; writes swallowed |

Breakers are keyed by `(provider, capability)`: `openai:chat`, `openai:embed`, `ollama:chat`, `qdrant:search`, `qdrant:upsert`, `redis`.

---

## Frozen public contract

The following are **never** changed without a deprecation window and consumer notification:

**MCP tools** (names + `inputSchema`):
`save_memory`, `save_preference`, `recall_memories`, `list_memories`, `list_preferences`, `delete_memory`, `forget_preference`

**HTTP routes**: all routes in `src/transport/http/routes/` — paths and methods are frozen.

Contract tests in `test/contract/` snapshot these and fail on any drift.

---

## ADR index

| # | Title | Status |
|---|---|---|
| [001](adr/001-provider-adapter-interface.md) | Provider adapter interface shape | Accepted |
| [002](adr/002-single-provider-resilience.md) | Single-provider resilience, no cross-provider failover | Accepted |
| [003](adr/003-layered-architecture.md) | Layered architecture + dependency rules | Accepted |
| [004](adr/004-remove-legacymemory.md) | Removal of legacy mem0ai fallback path | Accepted |
| [005](adr/005-config-schema-zod.md) | Config schema + zod validation | Accepted |
| [006](adr/006-structured-logging-metrics.md) | Structured logging + metrics sinks | Accepted |
| [007](adr/007-feature-flagged-shadow-cutover.md) | Feature-flagged shadow cutover for memory.ts extraction | Accepted |
| [008](adr/008-frozen-http-mcp-contract.md) | Frozen HTTP/MCP public contract | Accepted |
| [009](adr/009-composition-root.md) | Composition root as sole wiring location | Accepted |
| [010](adr/010-embedding-cache-in-infrastructure.md) | Embedding cache lives in infrastructure, not provider | Accepted |
| [011](adr/011-three-bucket-recall.md) | Three-bucket recall — synchronous, accuracy-first retrieval | Accepted |
| [012](adr/012-remove-graph-layer.md) | Remove LLM graph extraction layer | Accepted |
