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
│   tools/        │      │  graph/           │    └─────────┬─────────────┘
│   schemas.ts    │      │   recall-v2       │              │ uses
│  (FROZEN API)   │      │   extract-graph   │    ┌─────────▼─────────────┐
└─────────────────┘      │  ai/              │    │    resilience/        │
                         │   summarize       │    │                       │
                         │   rerank          │    │  retry.ts             │
                         │   fact-extract    │    │  timeout.ts           │
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
│   memory-graph.repo     vector-store         memory-cache                │
│   vector.repository                          embedding-cache             │
│                                                                          │
│  db/                    crypto/              auth/                       │
│   pool                  memory-crypto        jwt                         │
│   schema                                     supabase-client             │
│   migrations                                                             │
│                                                                          │
│  recall/                browser/             billing/                    │
│   hybrid-retrieval      browser-worker       lemonsqueezy.client         │
│   fast-recall           fallback-cache                                   │
│   bm25                                                                   │
└─────────────────────────────────────────────────────────────────────────┘
                                  │ pure types only
          ┌───────────────────────┼──────────────────────────────────────────┐
          ▼                       ▼                                           ▼
┌──────────────────┐   ┌────────────────────┐   ┌─────────────────────────────┐
│    domain/       │   │  observability/    │   │        shared/              │
│                  │   │                   │   │                             │
│  memory/         │   │  logger.ts         │   │  errors/                   │
│  graph/          │   │  metrics.ts        │   │   AppError hierarchy       │
│  auth/           │   │  request-timing.ts │   │  result.ts                 │
│  tenant/         │   │  tracing.ts        │   │  async-safe.ts             │
│  (pure types,    │   │                   │   │  ids.ts                    │
│   no I/O)        │   └───────────────────┘   └─────────────────────────────┘
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
    ├─ encrypt content (infrastructure/crypto/memory-crypto.ts)
    ├─ consume monthly quota (Redis; fail-open for free plan)
    ├─ INSERT row → infrastructure/repositories/memory.repository.ts → PG
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
    ├─ check in-memory LRU cache (60s TTL) → hit: return ~2ms
    ├─ check Redis exact-match cache → hit: background enrich, return ~15ms
    ├─ check precomputed graph snapshot → hit: return ~20ms
    │
    └─ MISS PATH:
        ├─ buildRecentFallback (BM25 lexical, no I/O to Qdrant) → return immediately
        └─ BACKGROUND: hybridRecall
            ├─ embed query → providers/ai/registry.ts → OpenAiProvider.embed
            │               (embedPolicy: 5s timeout, 3× retry)
            ├─ vector search → infrastructure/vector/vector-store.ts → Qdrant
            │                  (vectorSearchPolicy: 8s, 2× retry, CB)
            ├─ BM25 lexical search → infrastructure/recall/bm25.ts
            ├─ RRF fusion + rerank → orchestration/ai/rerank.usecase.ts
            └─ write enriched result back to caches
```

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
| `graph-extract` | 30 s | 2× exp-2s, 10s cap | 5 / 120s / 2 | job marked failed, worker retries |
| `vector.search` | 8 s | 2× exp-300ms | 6 / 30s / 2 | fall to lexical |
| `vector.upsert` | 10 s | 3× exp-500ms | 6 / 30s / 2 | PG row persists; `degraded:"vector_unavailable"` |
| `cache (Redis)` | 800 ms | 0 | existing cooldown | miss = absent; writes swallowed |

Breakers are keyed by `(provider, capability)`: `openai:chat`, `openai:embed`, `ollama:chat`, `qdrant:search`, `qdrant:upsert`, `redis`.

---

## Frozen public contract

The following are **never** changed without a deprecation window and consumer notification:

**MCP tools** (names + `inputSchema`):
`save_memory`, `recall_memories`, `recall_memories_v2`, `list_memory_entities`, `explain_memory_connection`, `memory_graph_insights`, `recall_user_context`, `list_memories`, `delete_memory`, `remember_user_preference`

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
