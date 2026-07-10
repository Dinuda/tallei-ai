# Current Memory Retrieval

How memory retrieval works today, including common pitfalls for prompts like:

`look at my memory and pull up past Tallei product updates`

## The Important Split

There are two different retrieval paths:

1. **`list_memories`**
   - Handler: `src/transport/mcp/tools/index.ts`
   - Calls `listMemories(auth)`
   - Returns a recent raw list — no intent filtering, no reranking

2. **`recall_memories`**
   - `src/services/memory.ts` → `src/orchestration/memory/recall.usecase.ts` → `src/infrastructure/recall/bucket-recall.ts`
   - Query-driven retrieval with caches and semantic/lexical scoring

If the model chooses `list_memories` because the prompt says "look at my memory", results can be noisy. That tool shows recent stored memories, not the most relevant ones for the task.

## Generic Recall Flow

1. **`recallMemories(...)`** — `src/services/memory.ts` (routes, MCP, ChatGPT Actions)
2. **`RecallMemoryUseCase.execute(...)`** — LRU cache → Redis exact cache → bucket recall
3. **`bucketRecall(...)`** — splits into preference / long-term / short-term buckets
4. **Long-term overflow** — vector top-25 + BM25 top-15 + temporal top-5, packed to token budget

See [ADR-011](adr/011-three-bucket-recall.md) for bucket caps and sorting rules.

This path does not treat "Tallei product updates" as a first-class constraint. It ranks by query text and generic signals.

## Why Irrelevant Memories Surface

1. **`list_memories` is not retrieval** — it exposes recency, not relevance.
2. **No hard domain filter** — no required company/project/entity match before ranking.
3. **No final task-specific validator** — memories are ranked but not validated against intent.
4. **Prompt wording** — "look at my memory" can steer the model toward `list_memories` instead of `recall_memories`.

## Files That Matter

| File | Role |
|------|------|
| `src/transport/mcp/tools/index.ts` | MCP tool handlers |
| `src/services/memory.ts` | Public recall/list entrypoints |
| `src/orchestration/memory/recall.usecase.ts` | Cache orchestration |
| `src/infrastructure/recall/bucket-recall.ts` | Ranking and token packing |
| `src/transport/shared/chat-actions.ts` | ChatGPT `prepare_response` recall assembly |

## Improvement Directions

1. Route open-ended recall asks through `recall_memories`, not `list_memories`.
2. Add optional filters: entity, timeframe, memory type.
3. Add a final relevance validator for high-stakes recall.
4. Tune `TALLEI_MISC__RECALL_HYBRID_SIMILARITY_FLOOR` for overflow path strictness.
