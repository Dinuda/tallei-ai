# ADR-012: Remove the Graph Extraction Layer

**Status:** Accepted  
**Date:** 2026-04-20

---

## Context

Tallei originally included an LLM-powered graph layer that extracted entities and relationships from every saved memory, stored them in four Postgres tables (`memory_entities`, `memory_entity_mentions`, `memory_relations`, `memory_graph_jobs`), and exposed them via four MCP tools and three HTTP routes.

The layer was designed to reveal relational insights (contradictions, entity connections, stale decisions) that pure vector search misses.

---

## Decision

Remove the entire graph extraction layer.

Deleted:
- `src/orchestration/graph/` — 6 files (recall-v2, precomputed-recall, graph-insights, extract-graph usecase + worker, index)
- `src/infrastructure/repositories/memory-graph.repository.ts`
- `src/infrastructure/repositories/memory-graph-job.repository.ts`
- `src/providers/ai/prompt-templates/graph-extractor.prompt.ts`
- `test/integration/graph-memory-flow.test.ts`
- `dashboard/app/dashboard/memory-graph/` — graph visualisation page
- `dashboard/app/api/memories/{graph,insights,recall-v2}/` — dashboard API routes

Removed from surviving code:
- 4 MCP tools: `recall_memories_v2`, `list_memory_entities`, `explain_memory_connection`, `memory_graph_insights`
- 4 HTTP routes: `GET /api/memories/recall-v2`, `/graph`, `/entities`, `/insights`
- 4 Postgres tables and all their indexes and RLS policies
- 4 config flags: `graphExtractionEnabled`, `recallV2Enabled`, `recallV2ShadowMode`, `dashboardGraphV2Enabled`
- `RecallSource` variants: `precomputed_graph_hit`, `precomputed_graph_miss`, `precomputed_graph_stale`
- `recall_v2` timing surface in request-timing middleware

---

## Rationale

### The core insight

The host LLM (Claude/GPT-4 with a 200k context window) already does relationship reasoning in-context for free. Any query that benefits from graph traversal — "what contradicts my preference for remote work?", "which projects use this tech stack?" — is answered correctly by the LLM once the right memories are in the context block.

The graph layer was solving a problem the model itself handles, at significant cost.

### Specific problems with the graph layer

**1. Cost per save.** Every memory triggered an LLM call (`gpt-4o-mini`) to extract entities and relationships. At scale this is a meaningful per-save cost multiplier with no latency benefit (fire-and-forget means users don't feel it, but the bill does).

**2. Extraction quality is inconsistent.** LLM entity extraction produces different canonical labels for the same concept across saves ("Next.js", "NextJS", "Next JS"). Deduplication requires fuzzy matching which adds complexity without reliability guarantees.

**3. Graph queries require graph-aware prompts.** To actually use entity relationships during recall you need to craft retrieval queries that traverse the graph. This is non-trivial and the results are worse than asking the LLM to reason about a full context block.

**4. The visualisation adds no recall accuracy.** The memory graph dashboard was aesthetically interesting but didn't improve what memories were retrieved or how accurately the LLM answered questions.

**5. Dead code risk.** The feature was behind flags (`graphExtractionEnabled`, `recallV2Enabled`) that were `false` in production. Maintaining an off-by-default pipeline that nobody runs is pure maintenance debt.

### Why the host LLM is a better graph

Claude and GPT-4 receive the entire context block from `bucketRecall`. With ~8000 tokens of memory, the LLM:
- Detects contradictions between memories without us pointing them out
- Infers entity relationships implicitly ("You use React on your main project and you prefer TypeScript — these are related")
- Ranks relevance to the current query without a separate reranker pass

This "graph reasoning in-context" is free (no extra API calls), always current (no stale extraction jobs), and higher quality than our deterministic pipeline.

### Alternatives considered

**Keep graph as opt-in.** Rejected. Dead code behind a flag is maintenance debt. If the feature isn't on by default in production it shouldn't exist.

**Replace LLM extraction with deterministic NER.** A lightweight spaCy-style NER model would cut cost but the quality drop would make entity deduplication even harder. Still solving a problem the host LLM handles for free.

**Keep graph for contradiction detection only.** The most compelling use case. Rejected because the host LLM catches contradictions in-context without needing a graph, and "soft contradictions" (changing preferences over time) are better handled by the superseded_by column on memory_records than by a graph relation.

---

## Consequences

**Removed capabilities:**
- Memory graph visualisation in the dashboard
- `recall_memories_v2` (graph-traversal recall) MCP tool
- `list_memory_entities`, `explain_memory_connection`, `memory_graph_insights` MCP tools
- Entity/relationship/insights API endpoints

**Gained:**
- ~500 fewer lines of application code
- 4 fewer Postgres tables, ~15 fewer indexes
- No LLM call per save (graph extraction was fire-and-forget but still ran)
- Simpler save pipeline — the background worker no longer exists
- 4 config flags removed, simplifying deployment config

**Unchanged:**
- `memory_type`, `category`, `is_pinned`, `reference_count`, `superseded_by` columns — these power the three-bucket recall system and are kept
- Three-bucket recall (ADR-011) — still the primary recall path
- All seven remaining MCP tools: `save_memory`, `save_preference`, `recall_memories`, `list_preferences`, `forget_preference`, `list_memories`, `delete_memory`

---

## Related

- ADR-011: Three-bucket recall (the architecture that made graph retrieval unnecessary)
