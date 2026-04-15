# Tallei Architecture: How It All Works

## The Idea

Most memory systems are either fast or smart. Tallei tries to be both. We do semantic search (fast, find relevant stuff) plus relationship analysis (smart, catch contradictions and connections). This doc explains how we pulled it off without making the system super complex.

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Core Components](#core-components)
4. [Async Extraction Pipeline](#async-extraction-pipeline)
5. [Dual Recall Modes](#dual-recall-modes)
6. [Insight Engine](#insight-engine)
7. [Performance Optimizations](#performance-optimizations)
8. [Design Decisions](#design-decisions)
9. [Future Roadmap](#future-roadmap)

---

## The Problem

You've got vector search (Pinecone, Weaviate, etc). Super fast, finds semantically similar stuff. But:
- Can't tell you when you're contradicting yourself
- Can't show relationships between ideas
- Treats every memory like an island

You've got graph DBs (Neo4j, TigerGraph). Powerful relationships, but:
- Separate database, separate infrastructure
- More complex to deploy
- More expensive to run
- Another thing that can break

Tallei's bet: Lightweight graph on Postgres. No separate DB, no new infrastructure. Relationships without the operational overhead.

---

## How It's Wired

```
┌──────────────────────────────────────────┐
│  Claude / ChatGPT / Gemini               │
└────────────────┬─────────────────────────┘
                 │ (MCP calls)
                 ▼
┌──────────────────────────────────────────────────────────────┐
│  MCP Server (Node.js/Express)                                │
│  • Check OAuth tokens (cached 10 min)                        │
│  • Route tool calls (save, recall, etc)                      │
│  • Return fast (fire off background jobs)                    │
└────┬────────────────────────────────────┬────────────────────┘
     │                                    │
[FAST PATH]                    [SLOW PATH - runs async]
     │                                    │
     ▼                                    ▼
┌──────────────┐               ┌─────────────────────────────┐
│ Vector Recall│               │ Background Worker           │
│ (5ms warm)   │               │ • Pick up jobs from queue   │
│              │               │ • Call LLM for extraction   │
│ • Embed query│               │ • Normalize graph data      │
│ • Search     │               │ • Run insights analysis     │
│ • Cache hit  │               │ • No message queue (just DB)│
└──────┬───────┘               └──────────┬───────────────────┘
       │                                  │
       └──────────────┬───────────────────┘
                      ▼
         ┌────────────────────────────────────┐
         │  PostgreSQL                        │
         ├────────────────────────────────────┤
         │ Vector Stuff:                      │
         │ • embeddings (pgvector)            │
         │ • recall_cache (results, 60s TTL)  │
         │                                    │
         │ Graph Stuff:                       │
         │ • entities (concepts, tech, etc)   │
         │ • relations (uses, contradicts)    │
         │ • mentions (which memory has it)   │
         │ • extraction_jobs (pending work)   │
         └────────────────────────────────────┘
```

---

## The Main Parts

### MCP Server (`src/mcp/server.ts`)

This is what Claude/ChatGPT/Gemini talk to. Exposes tools:

- `save_memory` — Queue a memory save, return immediately
- `recall_memories` — Find similar memories (vector search)
- `recall_memories_v2` — Find similar + related stuff (graph)
- `explain_memory_connection` — Show me the path between two concepts
- `memory_graph_insights` — What's contradicting? What's stale?
- `list_memories` — Show me what I've saved
- `list_memory_entities` — Show me extracted concepts
- `delete_memory` — Forget something
- More...

**Speed:**
- `save_memory`: ~10ms (instant response, work happens later)
- `recall_memories`: ~5ms (if we've seen this query before), ~200ms (first time)
- `recall_memories_v2`: ~50–300ms (depends how deep we traverse the graph)
- `memory_graph_insights`: ~100–500ms (analyzing your whole graph)

### Vector Memory Service (`src/services/memory.ts`)

This handles embeddings and recall. Used to create a new Memory instance on every request (expensive!). Now it's a singleton—one instance, reused across requests.

**The Fire-and-Forget Pattern:**
```
saveMemory(userId, content) {
  1. Store memory in DB (instant)
  2. Queue extraction job (instant)
  3. Return response to MCP (10ms total) ✅
  
  [Meanwhile, in background]
  4. Worker embeds the content
  5. Worker summarizes it
  6. Worker extracts entities and relations
  7. Updates the graph
```

You get your response back instantly. The heavy lifting happens while you're working.

**Recall Cache:**
We cache results for 60 seconds. If you ask "show me stuff about React" twice in a row, second time is cached (~5ms). Miss the cache? ~200ms to search and retrieve. But you're hitting cache like 95% of the time.

### Background Worker (`src/services/memoryGraphWorker.ts`)

This runs in the background (same process, no external queue) and does the expensive work:

**How it works:**
- Polls the `extraction_jobs` table for pending work
- Picks up a job, processes it
- If it fails, retries with backoff
- Writes status to DB so it survives restarts

**What it does:**
```
1. Read memory content
2. Send to OpenAI: "Extract entities and relationships"
3. OpenAI returns:
   {
     entities: [
       {name: "React", type: "technology"},
       {name: "UI patterns", type: "concept"}
     ],
     relations: [
       {source: "React", target: "UI patterns", type: "enables"}
     ]
   }
4. Normalize it (deduplicate, type-check)
5. Store to Postgres (entities, relations, mention links)
6. Mark job complete
```

No message queue, no external dependencies. Just the database and a worker polling it.

### Graph Storage

We keep the graph in Postgres (not a separate DB). Here's the schema:

```sql
-- Concepts you mention (React, Python, "remote work", etc)
entities:
  - id, user_id
  - name (what is it?)
  - type (technology, concept, person, decision, etc)
  - embedding (vector for similarity search)

-- Relationships between concepts
relations:
  - source_id → target_id (React uses WebAssembly)
  - type (uses, contradicts, enables, etc)
  - strength (1-10, how strongly related)

-- Which memories mention which concepts
mentions:
  - entity_id, memory_id
  - context (snippet showing how it was mentioned)

-- Background job tracking
extraction_jobs:
  - status (pending, processing, completed, failed)
  - result (what we extracted)
  - error (if it failed, why)
```

**Why Postgres and not Neo4j?**
- One database, one connection pool
- ACID guarantees (atomic relation storage)
- Easy to query, normalized schema
- Simpler deployment (no extra infrastructure)
- Good enough performance (relationships aren't that deep)

### Insight Engine (`src/services/memoryInsights.ts`)

This looks at your whole graph and tells you interesting stuff:

**Contradictions:**
- "I prefer Python" (saved 3 months ago) vs "I hate Python" (saved last week)
- Different salary expectations, different role preferences, etc
- Flags: "You're saying conflicting things"

**Stale Decisions:**
- "I use Vue" mentioned 6 months ago, never again since
- "Remote work is great" from a year ago, but all recent memories say in-office
- Flags: "This decision might be outdated"

**High-Impact Entities:**
- React mentioned 50 times, but Python mentioned 5 times
- Entities that connect a lot of other stuff (hubs in the graph)
- Your core interests at a glance

**Hidden Connections:**
- Two projects both use React (shared interest)
- Technical decision A enables decision B enables decision C
- Patterns you didn't notice

---

## The Fire-and-Forget Pattern

This is the key innovation. Why?

**Without it (everything blocking):**
```
save_memory() 
  → embed it (500ms)
  → summarize (1s)
  → extract entities (1500ms)
  → store relations (100ms)
  → return (4.1s) ❌
```

Your AI is waiting 4 seconds. That's slow.

**With it (queue and return):**
```
save_memory()
  → store record (5ms)
  → queue job (5ms)
  → return (15ms) ✅
  
[background worker, no rush]
  → embed (500ms)
  → summarize (1s)
  → extract (1500ms)
  → store graph (100ms)
  → done
```

AI gets response back instantly, graph shows up in the next recall. User never notices the delay.

### How The Job Queue Works

```
User saves memory to Claude
    ↓
MCP server receives save_memory() call
    ↓
Server stores memory in DB, queues job
    ↓
Server returns response (15ms)
    ↓
[Meanwhile] Background worker keeps polling
    ↓
Worker sees new pending job
    ↓
Worker processes:
  1. Call OpenAI for entities/relations
  2. Store to Postgres
  3. Mark complete
    ↓
Next recall_memories call gets the graph data
```

**Reliability:**
- Jobs are in the database, not a message queue
- If the worker crashes, restarts pick up where it left off
- Failed jobs retry with backoff (exponential)
- You can check job status via API (monitoring)

---

## Two Recall Modes

### Vector Search (Fast)

`recall_memories(query)`

Fast semantic search:
- Embed your query
- Find similar memories
- Return them
- ~5ms if we've seen this query before, ~200ms first time

Use when: "Find me stuff about X"

```
You: "Show me what I remember about remote work"
Tallei: [finds 5 memories mentioning remote work]
Done in 5ms ✅
```

### Graph Recall (Rich)

`recall_memories_v2(query)`

Graph-aware recall:
- Vector search finds starting points
- Graph traversal finds related entities
- Collects all connected memories
- Returns with relationship context
- ~50–300ms depending on depth

Use when: "Tell me everything about X—projects, decisions, contradictions"

```
You: "Tell me about my tech stack"
Tallei:
  - Finds React, Python, PostgreSQL (vector search)
  - Finds all projects using them (graph)
  - Finds related decisions ("switched to React for performance")
  - Flags contradictions ("I said I like Vue, not React")
Done in ~200ms ✅
```

### Insights

`memory_graph_insights()`

Analyze your whole graph:
- What's contradicting?
- What's stale (decided months ago, never mentioned again)?
- What's your obsession (mentioned 50 times)?
- ~100–500ms

Use when: "Is my memory consistent? What am I forgetting?"

---

## Insight Engine

### How Contradictions Are Detected

```typescript
// Query: Find entities with conflicting relations
const contradictions = await db.query(`
  SELECT e.name, 
         array_agg(DISTINCT r.type) as conflicting_types
  FROM entities e
  JOIN relations r ON e.id IN (r.source_id, r.target_id)
  WHERE e.user_id = $1
  GROUP BY e.id
  HAVING count(DISTINCT r.type) > 1
    AND array_length(array_agg(DISTINCT r.type), 1) > 1
`);
```

**Example output:**
```
Entity: "Remote Work"
  Contradictions:
    - Memory A says: "I love remote work"
    - Memory B says: "I prefer in-office collaboration"
  Last mentioned: 3 days ago
  Recommendation: Review and consolidate
```

### How Stale Decisions Are Detected

```typescript
// Entities not mentioned in recent memories
const staleDecisions = await db.query(`
  SELECT e.name, 
         MAX(m.created_at) as last_mentioned,
         NOW() - MAX(m.created_at) as age
  FROM entities e
  LEFT JOIN mentions mt ON e.id = mt.entity_id
  LEFT JOIN memories m ON mt.memory_id = m.id
  WHERE e.user_id = $1
    AND e.type = 'decision'
  GROUP BY e.id
  HAVING (NOW() - MAX(m.created_at)) > INTERVAL '6 months'
  ORDER BY age DESC
`);
```

**Example output:**
```
Entity: "Use GraphQL for APIs"
  Last mentioned: 8 months ago
  Status: Potentially stale
  Recommendation: Review if still valid
```

---

## Performance Optimizations

### 1. Singleton Memory Instance

**Before:** Each MCP request created a new Memory instance
```
Request 1 → new Memory() → init connections → use → destroy
Request 2 → new Memory() → init connections → use → destroy
Request 3 → new Memory() → init connections → use → destroy
```

**After:** Single instance reused
```
Request 1 → Memory.instance → use (connections already warm)
Request 2 → Memory.instance → use
Request 3 → Memory.instance → use
```

**Result:** 200–400ms faster per request

### 2. Fire-and-Forget Saves

**Before:** Block until graph extraction completes (4.5s)
**After:** Queue and return (15ms)

**Result:** ~300× faster response time

### 3. Recall Result Cache (60s TTL)

```typescript
// Cache key: (userId, query, limit)
const cacheKey = `recall:${userId}:${query}:${limit}`;
const cached = await cache.get(cacheKey);
if (cached) return cached; // ~5ms

// Cache miss: do full search
const results = await vectorSearch(query);
await cache.set(cacheKey, results, { ttl: 60 });
return results;
```

**Result:** ~5ms for repeated queries, 60s window

### 4. OAuth Token Cache (10 min TTL)

```typescript
// Avoid repeated crypto verification
const tokenCache = new Map();
const cacheKey = token.substring(0, 20); // prefix

if (tokenCache.has(cacheKey)) {
  return tokenCache.get(cacheKey); // instant
}

const verified = await oauthVerifier.verify(token); // expensive
tokenCache.set(cacheKey, verified, { ttl: 10 * 60 * 1000 });
return verified;
```

**Result:** Eliminate repeated Google API calls

---

## Design Decisions (aka Why We Built It This Way)

### Postgres for Graphs, Not Neo4j

I could've used Neo4j. It's purpose-built for graphs. But:
- Postgres you already have (it's your main database)
- One connection pool, not two
- No sync issues (what if one succeeds, other fails?)
- No extra infrastructure to deploy and maintain
- ACID guarantees on everything

The tradeoff? Graph queries are maybe 10% slower than Neo4j. Worth it for not having to operate two databases.

### In-Process Worker, Not RabbitMQ/Redis

Lots of people use a message queue for background jobs. I went with a simple database-backed job queue (poll extraction_jobs table):
- No extra infrastructure
- Jobs survive restarts (they're in the database)
- Simple monitoring (just check the jobs table)
- Can always migrate to a real queue later if needed

Tradeoff? If the worker crashes, jobs sit pending until it restarts. But that's fine—extraction isn't time-sensitive, and the worker is part of the same process as the MCP server.

### Single Database Philosophy

Some designs would have:
- Main database for vectors
- Graph database for relations
- Cache layer for results
- Job queue for processing

That's a lot of moving parts. I kept it to:
- Postgres (everything)
- In-process worker (everything)

Simple > elegant when it comes to operational burden.

---

## What's Next

### Phase 1: Temporal Awareness (Fish-Brain) 🚀

What am I thinking about *right now*?
- Hot topics this week
- Mention velocity (growing vs. fading interests)
- Stale decisions (haven't revisited in months)

Real features:
- Hot topics widget (what's on my mind)
- Time-series charts (interest trends)
- Recency boost in recalls (weight recent memories higher)

Think of it like a fish brain—only remembers recent stuff. Perfect for tracking what matters *now*.

### Phase 2: Gemini Integration

Claude (MCP) ✅. ChatGPT (OAuth) ✅. Gemini next. Same setup, same memory, same graph. Just another AI you can connect.

### Phase 3: Memory Compression

Old memories pile up. Archive by summarizing old clusters while keeping the graph intact. Don't lose context, just save space.

### Phase 4: Better Relationship Queries

Multi-hop traversal:
- "Show me all projects using both React and Python"
- "What contradicts my decision to work remote?"
- "What am I most invested in?" (ego graphs)

### Phase 5: Custom Extraction

Let people define what they extract:
- "Find every business outcome"
- "Pull out technical decisions"
- "Get all my complaints about X"

Domain-specific pipelines for power users.

### Phase 6: Smarter Cross-AI Fusion

Right now each AI has separate memories. Eventually:
- Unified entities across all platforms
- Detect duplicates ("I saved this to both Claude and ChatGPT")
- Platform patterns ("You code in ChatGPT, read docs in Claude")

---

## Integration Tests

**Test coverage includes:**
1. **Full E2E flow**: save → job → extract → recall-v2 → insights
2. **Graph consistency**: Ensure relations don't orphan entities
3. **Concurrent saves**: Multiple saves don't corrupt graph state
4. **Cache invalidation**: New save invalidates recall cache
5. **Worker reliability**: Failed jobs retry and eventually complete

```typescript
// Example: Test E2E flow
it('should extract and recall graph connections', async () => {
  // Save a memory
  const memory = await saveMemory(userId, 'I use React and Python for web dev');
  
  // Wait for extraction job
  await waitForJobCompletion(memory.id);
  
  // Verify entities were extracted
  const entities = await getEntities(userId);
  expect(entities.map(e => e.name)).toContain('React');
  expect(entities.map(e => e.name)).toContain('Python');
  
  // Verify recall-v2 includes graph context
  const recall = await recall_memories_v2(userId, 'React');
  expect(recall.graphContext).toContain('Python');
  
  // Verify insights are available
  const insights = await memory_graph_insights(userId);
  expect(insights.highImpactEntities).toBeDefined();
});
```

---

## Memory Graph Visualization

The dashboard includes an interactive memory graph explorer:

```
┌─────────────────────────────────────────┐
│         Memory Graph Dashboard          │
├──────────────────┬──────────────────────┤
│                  │                      │
│  Interactive     │  Entity Details      │
│  Graph View      │  & Relations         │
│                  │                      │
│  • Entities      │  • Type              │
│    as nodes      │  • Mentions          │
│  • Relations     │  • Related facts     │
│    as edges      │  • Contradictions    │
│  • Click for     │                      │
│    insights      │  Insight Overlays    │
│                  │  • Stale decisions   │
│                  │  • Contradictions    │
│                  │  • High-impact       │
│                  │                      │
└──────────────────┴──────────────────────┘
```

**Screenshot:** [See Memory Graph in Action](./dashboard/public/memory-graph-screenshot.png)

---

## Why This Matters

Tallei solves the "AI forgets who you are" problem. But not just by throwing more vectors at it. By adding relationships, contradictions, temporal patterns, it makes memory *actually useful*.

The bet: lightweight > feature-complete. Single database > three databases. Fire-and-forget > blocking on extraction. Keep it simple, keep it fast.

It works. MCP tools respond in 10ms. Graph data shows up in recalls. Contradictions get flagged. The system is simple enough that I can deploy it on one server, hard enough that it catches things you'd miss.

That's Tallei.
