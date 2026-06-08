# Current Memory Retrieval

This is the memory path as it exists today, with the parts that are most likely
to surface irrelevant memories for prompts like:

`look at my memory and pull up past Tallei product updates`

## The Important Split

There are two different retrieval paths in this codebase:

1. `list_memories`
   - File: `src/transport/mcp/tools/index.ts`
   - Calls `listMemories(auth)`
   - Returns a recent raw list of memories
   - No intent filtering, no reranking, no Tallei-specific narrowing

2. `recallMemories`
   - Files:
     - `src/services/memory.ts`
     - `src/orchestration/memory/recall.usecase.ts`
     - `src/infrastructure/recall/bucket-recall.ts`
   - Query-driven retrieval with caches and semantic/lexical scoring

If the model chooses `list_memories` because the prompt says "look at my memory",
the result can be noisy by definition. That tool is effectively "show me recent
stored memories", not "retrieve the most relevant memories for this task".

## Generic Recall Flow

The query-driven path is:

1. `recallMemories(...)`
   - `src/services/memory.ts`
   - Public entrypoint used by routes and shared chat actions.

2. `RecallMemoryUseCase.execute(...)`
   - `src/orchestration/memory/recall.usecase.ts`
   - Checks:
     - in-process LRU cache
     - Redis exact cache
     - falls through to bucket recall

3. `bucketRecall(...)`
   - `src/infrastructure/recall/bucket-recall.ts`
   - Splits memories into:
     - preferences
     - long-term facts/decisions
     - short-term events/notes

4. Long-term overflow path
   - same file
   - Uses:
     - vector search
     - BM25
     - temporal fallback
   - Merges candidates and packs them into a token budget

This path is better than the raw list path, but it still does not understand
"Tallei product updates" as a first-class retrieval constraint. It relies on the
query text and generic ranking signals.

## Builder-Specific Recall Flow

The loop builder adds another layer on top:

1. `designLoopFromIntent(...)`
   - `src/services/loop-engine/architect.ts`

2. `recallForDesigner(...)`
   - `src/services/loop-engine/recall.ts`

3. `buildFacetQueries(prompt)`
   - same file
   - Expands one prompt into four broad searches:
     - output format / structure
     - tone / style / audience
     - domain context / prior work / product updates
     - recurring loop / workflow / template patterns

4. Each facet calls `recallMemories(query, auth, 10)`
   - results are merged
   - deduped by id
   - filtered by score floor
   - truncated to top K

This is the main reason the builder path can feel shaky. It is intentionally
broad. For a prompt about a Tallei sync email, the style/workflow facets can
pull in unrelated "write this post", "reply to this message", or generic product
writing memories because they share vocabulary with the prompt.

## Runtime Curated Search

The stable runtime has a separate memory search path:

- `src/services/loop-runtime/curated-memory-search.ts`

This path is more constrained than generic recall:

- creates a query plan
- retrieves candidates with vector/BM25/entity matching
- runs shortlist validation
- emits trace data for review

This is closer to the right shape, but it is only used inside the loop runtime.
It is not the universal memory retrieval path for the app.

## Why The Current System Surfaces Irrelevant Memories

The bad results are coming from a few concrete design choices:

1. The raw `list_memories` tool is not retrieval.
   - It exposes recent memories, not relevant memories.

2. The builder recall fans out into broad facet queries.
   - `style`
   - `prior work product updates`
   - `workflow patterns`
   These overlap with a lot of unrelated historical writing tasks.

3. There is no hard domain filter for "Tallei-only" or "product-update-only".
   - The system does not require company/project/entity matches before ranking.

4. The generic recall path does not run a final task-specific validator.
   - It ranks memories, but it does not explicitly ask:
     - is this about Tallei?
     - is this a past product update?
     - is this still relevant to the requested sync?

5. Prompt wording can accidentally steer tool choice toward `list_memories`.
   - "look at my memory" is a bad fit for a raw list tool because the model may
     choose it over a ranked recall call.

## Files That Matter Most

- `src/transport/mcp/tools/index.ts`
  - exposes `list_memories`
- `src/services/memory.ts`
  - public recall/list entrypoints
- `src/orchestration/memory/recall.usecase.ts`
  - cache orchestration and bucket recall handoff
- `src/infrastructure/recall/bucket-recall.ts`
  - generic ranking and token-budget packing
- `src/services/loop-engine/recall.ts`
  - builder-specific facet query expansion
- `src/services/loop-engine/architect.ts`
  - builder prompt assembly that consumes recalled memories
- `src/services/loop-runtime/curated-memory-search.ts`
  - more stable runtime-only retrieval path
- `src/transport/shared/chat-actions.ts`
  - generic chat recall assembly and document blending

## What To Change If You Want Stability

1. Stop exposing `list_memories` as the default tool for open-ended recall asks.
2. Route all "find relevant memory for this task" requests through one ranked path.
3. Remove broad facet fan-out from builder recall.
4. Add hard filters for:
   - company/product/entity
   - timeframe
   - artifact type
5. Add a final validator step that can reject near-match but irrelevant memories.
6. Keep events/audit separate from retrieval state, same way the new loop runtime
   separates events from execution state.
