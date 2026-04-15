# System Diagrams

Visual walkthroughs of how everything connects. Read these if you want to understand the flow without reading code.

## The Full Picture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    Claude / ChatGPT / Gemini                              │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │ OAuth + MCP
                    ┌───────────────────▼────────────────────┐
                    │   Claude Desktop / Web Extensions      │
                    │   (MCP Client Configuration)           │
                    └───────────────────┬────────────────────┘
                                        │
                                        ▼
        ┌────────────────────────────────────────────────────────┐
        │        Tallei MCP Server (Node.js/Express)            │
        │  https://tallei.example.com/mcp                       │
        │                                                        │
        │  Tools Exposed:                                        │
        │  • save_memory (10ms)                                  │
        │  • recall_memories (5ms warm, 200ms cold)            │
        │  • recall_memories_v2 (50-300ms + graph)             │
        │  • memory_graph_insights (100-500ms)                 │
        │  • explain_memory_connection (graph path finding)    │
        │  • list_memory_entities (browse extracted facts)     │
        │  • delete_memory                                      │
        └────────────┬──────────────────────┬──────────────────┘
                     │                      │
        [CRITICAL]   │                      │  [BACKGROUND]
                     ▼                      ▼
    ┌─────────────────────────┐  ┌──────────────────────────┐
    │   Vector Recall Layer    │  │  Async Graph Worker      │
    │ (mem0ai + pgvector)      │  │                          │
    │                          │  │  • Job polling           │
    │ • Embed query (2ms)      │  │  • LLM extraction        │
    │ • Search index (3ms)     │  │  • Graph normalization   │
    │ • Cache check (0.5ms)    │  │  • Insight analysis      │
    └──────────┬───────────────┘  └────────────┬─────────────┘
               │                               │
               │              ┌────────────────┘
               │              │
               └──────────────▼─────────────────────┐
                     ┌────────────────────────────┐ │
                     │    PostgreSQL Database     │ │
                     │                            │ │
                     │  Vector Layer:             │ │
                     │  ├─ memories               │ │
                     │  ├─ embeddings (pgvector)  │ │
                     │  └─ recall_cache           │ │
                     │                            │ │
                     │  Graph Layer:              │ │
                     │  ├─ entities               │ │
                     │  ├─ relations              │ │
                     │  ├─ mentions               │ │
                     │  └─ extraction_jobs        │ │
                     └────────────────────────────┘ │
                                                    │
                     ┌──────────────────────────────┘
                     │
                     ▼
    ┌────────────────────────────┐
    │  OpenAI API                │
    │  • text-embedding-3-small  │
    │  • gpt-4o-mini (summary)   │
    │  • gpt-4 (extraction)      │
    └────────────────────────────┘
```

---

## 2. Memory Save Flow (Fire-and-Forget)

```
User saves: "I love React for UI and Python for backends"
│
├─ MCP Request
│  └─ save_memory(user_id, content)
│
├─ Backend Processing (Critical Path - FAST ⚡)
│  ├─ 1. Validate input (1ms)
│  ├─ 2. Create memory record in DB (2ms)
│  ├─ 3. Queue extraction job (2ms)
│  └─ 4. Return Response (10ms total) ✅ MCP tool unblocks
│
└─ Background Processing (Happens after response)
   ├─ 5. Extract vector embedding (500ms)
   │     └─ OpenAI text-embedding-3-small
   ├─ 6. Store embedding in pgvector (50ms)
   ├─ 7. Summarize content (1000ms)
   │     └─ OpenAI gpt-4o-mini
   ├─ 8. Extract entities & relations (1500ms)
   │     ├─ Entities: ["React", "Python", "UI", "Backend"]
   │     ├─ Types: [technology, technology, concept, concept]
   │     └─ Relations: [React→uses UI, Python→uses Backend]
   ├─ 9. Normalize graph data (100ms)
   ├─ 10. Upsert entities to DB (50ms)
   ├─ 11. Create mention links (30ms)
   ├─ 12. Store relations (30ms)
   ├─ 13. Run insight analysis (100ms)
   │      └─ Detect contradictions, stale data, hot topics
   └─ 14. Mark job complete (10ms)
      └─ Graph now available for next recall

Total background time: ~3.5 seconds (happens after response)
But: User's AI workflow unblocked after 10ms ✅
```

---

## 3. Dual Recall Modes

### Mode A: Vector Recall (Fast, Semantic)

```
Query: "What do I remember about React?"
│
├─ 1. Embed query using OpenAI (150ms)
├─ 2. Check recall cache (1ms)
│  └─ Cache key: (user_id, "react", limit=10)
│  └─ TTL: 60 seconds
│
├─ 3a. Cache HIT ✅
│     └─ Return cached results (1ms)
│     └─ User gets instant recall
│
└─ 3b. Cache MISS (first time or after 60s)
      ├─ Run pgvector similarity search (50ms)
      │  └─ SELECT * FROM memories ORDER BY embedding <-> query_vector
      ├─ Collect top-k results (5ms)
      ├─ Fetch full memory content (5ms)
      ├─ Store in cache with 60s TTL (5ms)
      └─ Return results (200ms total)

Total Latency:
  • Warm cache: ~5ms
  • Cold cache: ~200ms
  • Cached hits: 95%+ of requests (60s window)
```

### Mode B: Graph Recall v2 (Rich, Relational)

```
Query: "Show me everything about my tech stack and decisions"
│
├─ Phase 1: Vector Seed (150ms)
│  ├─ Embed query
│  ├─ Vector search finds seed entities
│  │  └─ E.g., ["React", "Python", "PostgreSQL"]
│  └─ Collect seed mentions
│
├─ Phase 2: Graph Traversal (100-200ms, depth=2)
│  ├─ Start from seed entities
│  ├─ Hop 1: Find all related entities
│  │  └─ React → [uses: UI Library, prefers: Frontend]
│  │  └─ Python → [uses: Backend, prefers: Data Analysis]
│  ├─ Hop 2: Find secondary relations
│  │  └─ UI Library → [used by: Projects, relates to: CSS]
│  └─ Collect all unique entities and relations
│
├─ Phase 3: Mention Aggregation (50ms)
│  ├─ Find all memories mentioning discovered entities
│  ├─ Collect context snippets for each mention
│  └─ De-duplicate mentions (same entity, multiple memories)
│
├─ Phase 4: Merge & Enrich (100ms)
│  ├─ Combine vector score with graph centrality
│  ├─ Rank by importance (mention frequency, recency)
│  ├─ Detect contradictions within context
│  └─ Annotate with insights
│
└─ Return Rich Context (300ms total)
   ├─ Core entities and their types
   ├─ All discovered relations
   ├─ Related memories with context
   ├─ Contradiction flags (if any)
   └─ High-impact entities (hubs in graph)

Total Latency:
  • Shallow depth (1): ~100-150ms
  • Medium depth (2): ~200-300ms
  • Deep analysis (3+): ~400-500ms
```

---

## 4. Insight Engine: Detecting Contradictions

```
Graph State:
  Entity: "Remote Work"
  ├─ Memory A: "I love remote work flexibility"
  │  ├─ Created: 2025-08-10
  │  └─ Relation: {remote_work → LOVES → flexibility}
  │
  ├─ Memory B: "Remote work reduces collaboration"
  │  ├─ Created: 2025-09-01 (newer)
  │  └─ Relation: {remote_work → REDUCES → collaboration}
  │
  └─ Memory C: "In-office is better for team dynamics"
       Created: 2025-09-15 (newest)
       Relation: {in_office → IMPROVES → team_dynamics}

Insight Engine Analysis:
┌─────────────────────────────────────────────────┐
│ CONTRADICTION DETECTED                          │
├─────────────────────────────────────────────────┤
│ Entity: Remote Work                             │
│                                                 │
│ Conflicting statements:                         │
│ 1. "I love remote work" (Aug 10)               │
│ 2. "Remote work reduces collaboration" (Sep 1) │
│ 3. "In-office improves dynamics" (Sep 15)      │
│                                                 │
│ Trend: Shifting away from remote preference    │
│                                                 │
│ Recommendation:                                 │
│ Update your preference — your recent            │
│ memories suggest you prefer in-office work     │
│                                                 │
│ Confidence: HIGH (consistent newer statements) │
│ Staleness: MEDIUM (1 month old)                │
└─────────────────────────────────────────────────┘
```

---

## 5. Entity Relationship Graph Example

```
Your Tech Stack Memory Graph:

                    ┌─────────────────┐
                    │   "I prefer"    │ ◄─────┐
                    │   functional"   │       │ "simplifies"
                    └────────┬────────┘       │
                             │                │
                             │ "aligns with" │
                  ┌──────────▼──────────┐  ┌──┴─────────┐
                  │   PROGRAMMING      │  │ FUNCTIONAL │
                  │   PARADIGM          │  │ PROGRAMMING│
                  │   (abstract)        │  └────────────┘
                  └──────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         "uses"         "uses"          "uses"
              │              │              │
    ┌─────────▼──────┐  ┌────▼────┐  ┌────▼──────┐
    │    PYTHON      │  │  HASKELL│  │  RUST     │
    │ (technology)   │  │(technol)│  │(technol)  │
    └─────┬──────────┘  └────┬────┘  └─────┬─────┘
          │                  │             │
    "used for"         "used for"     "used for"
          │                  │             │
    ┌─────▼──────┐      ┌───▼────┐   ┌────▼────┐
    │  DATA      │      │SYSTEMS │   │ SYSTEMS │
    │  ANALYSIS  │      │PROGRAMS│   │PROGRAMMING
    └────────────┘      └────────┘   └─────────┘
          │
     "relates to"
          │
    ┌─────▼──────────────┐
    │ MACHINE LEARNING   │ ◄── "contradicts"
    │ (specialty)        │       │
    └────────────────────┘       │
                            ┌────▼─────────────┐
                            │ "I prefer pure   │
                            │  mathematical"   │
                            └──────────────────┘

Extracted Facts:
├─ Entities (10): PYTHON, HASKELL, RUST, ...
├─ Relations (12): uses, used_for, relates_to, contradicts
├─ Mentions (8): 8 memories reference this graph
└─ Contradictions (1): Functional vs Mathematical preference
```

---

## 6. Database Schema Relationships

```
┌───────────────────────────────────────┐
│         PostgreSQL Database           │
└───────────────────────────────────────┘

memories
├─ id (PK)
├─ user_id (FK → auth_users)
├─ content (TEXT)
├─ embedding (vector<1536>) ◄─── pgvector
├─ summary (TEXT)
├─ created_at
└─ ...other fields

     │
     │ "mentioned in"
     │
entities
├─ id (PK)
├─ user_id (FK → auth_users)
├─ name (TEXT)
├─ type (TEXT) ◄─── 'technology', 'person', 'decision', etc
├─ embedding (vector<1536>)
├─ created_at
└─ UNIQUE(user_id, name, type)

     │
     │ "has relation"
     │
relations
├─ id (PK)
├─ source_id (FK → entities)
├─ target_id (FK → entities)
├─ type (TEXT) ◄─── 'uses', 'likes', 'contradicts', etc
├─ strength (INT) ◄─── 1-10 weight
├─ created_at
└─ INDEXES: (source_id), (target_id), (type)

     │
     │ "links to"
     │
mentions
├─ id (PK)
├─ entity_id (FK → entities)
├─ memory_id (FK → memories)
├─ context (TEXT) ◄─── snippet from memory
├─ created_at
└─ INDEXES: (entity_id), (memory_id)

     │
     │ "processes"
     │
extraction_jobs
├─ id (PK)
├─ user_id (FK → auth_users)
├─ memory_id (FK → memories)
├─ status (TEXT) ◄─── 'pending', 'processing', 'completed', 'failed'
├─ result (JSONB) ◄─── extracted entities & relations
├─ error (TEXT)
├─ created_at
├─ processed_at
└─ INDEXES: (user_id), (status), (memory_id)
```

---

## 7. Recency & Frequency (Future: Fish-Brain)

```
Entity "React" Over Time:

Mention Timeline:
├─ Jan 10: "Started learning React" ────┐
├─ Jan 25: "Built first React app"      ├─ Jan period: 3 mentions
├─ Feb 15: "React hooks are powerful"   ┤ (Interest emerging)
├─ Mar 01: "React state management"     ├─ Feb-Mar: 5 mentions
├─ Mar 15: "Switched to Next.js" ───────┤ (High velocity)
├─ Apr 01: "Using React daily" ─────────┤
├─ Apr 10: "Mastered React patterns" ───┴─ Apr: 3 mentions
│  [1 month gap]                           (Interest plateauing)
└─ May 15: "Consider Vue alternative"      (Interest fluctuating?)

Frequency Analysis:
┌──────────────────────────────────┐
│ Entity: React                    │
├──────────────────────────────────┤
│ Total mentions: 9                │
│ Time span: 135 days              │
│ Mention velocity: 0.067/day      │
│ Trend (last 30d): ↘️ declining  │
│ Status: CORE (but interest fade) │
│ Recommendation: Why the interest?│
│           Are you considering    │
│           alternatives?          │
└──────────────────────────────────┘

Dashboard Widget:
┌─────────────────────────────────┐
│ 🔥 Hot Topics (Last 7 days)     │
├─────────────────────────────────┤
│ 1. Vue.js ↗️ (5 mentions)       │
│ 2. TypeScript ↗️ (4 mentions)   │
│ 3. React → (2 mentions) [COOL]  │
│ 4. Node.js ↘️ (1 mention)       │
└─────────────────────────────────┘
```

---

## 8. Performance Comparison: With vs Without Graph

```
Traditional Vector-Only Memory:

Query: "What are my core interests?"

Response:
├─ Results from semantic search:
│  └─ React (score: 0.89)
│  └─ Python (score: 0.87)
│  └─ Kubernetes (score: 0.76)
│
└─ No insight into:
   ├─ ❌ Which are recent vs old?
   ├─ ❌ Which are frequently mentioned?
   ├─ ❌ Which projects use these together?
   ├─ ❌ Are there contradictions?
   └─ ❌ What's the actual decision history?

Latency: 200ms
Value: Medium (search only)

────────────────────────────────────────────

Tallei with Graph:

Query: "What are my core interests?"

Response:
├─ Vector search results (fast):
│  └─ React, Python, Kubernetes
│
├─ Graph enrichment (adds context):
│  ├─ React: 🔥 Most mentioned this week (12x)
│  ├─ Python: Trending ↗️ (5 mentions/week)
│  ├─ Kubernetes: Stable → (mentioned with DevOps)
│  │
│  ├─ Connections:
│  │  └─ React + Python used together (fullstack projects)
│  │  └─ Python contradicts R preference (from older memory)
│  │
│  ├─ High-impact entities:
│  │  └─ "Fullstack Development" (hub connecting all 3)
│  │  └─ "Performance Optimization" (shared concern)
│  │
│  └─ Insights:
│     ├─ ⚠️ CONTRADICTION: "I prefer Python" vs recent focus on JavaScript
│     ├─ 📊 RECENCY: React most active this month
│     └─ 🔗 PATTERN: Cluster around fullstack web development

Latency: 300ms (graph adds 100ms for rich context)
Value: HIGH (relationships + insights + decisions)

Trade-off: +100ms latency for 10x more useful response ✅
```

---

## 9. Integration: From Memory to Insight

```
┌──────────────────────────────┐
│  User Saves Memory to Claude │
│                              │
│  "I'm torn between React     │
│   and Vue. I prefer Vue's    │
│   simpler API, but React     │
│   has better ecosystem."     │
└────────────┬─────────────────┘
             │
             ▼
     ┌───────────────────┐
     │ MCP save_memory   │
     │ Returns in 10ms ✅│
     └────────┬──────────┘
              │
              ▼
     ┌───────────────────────────────┐
     │ Backend Job Queue             │
     │ (extraction_jobs table)       │
     └────────┬──────────────────────┘
              │
              ▼
     ┌─────────────────────────────────────┐
     │ Background Worker                   │
     │ • Summarizes: "React vs Vue choice" │
     │ • Extracts entities:                │
     │   - React (technology)              │
     │   - Vue (technology)                │
     │   - Ecosystem (concept)             │
     │   - API Design (concern)            │
     │ • Extracts relations:               │
     │   - React → has better → Ecosystem │
     │   - Vue → has simpler → API Design │
     │   - [contradiction implicitly]     │
     └────────┬────────────────────────────┘
              │
              ▼
     ┌──────────────────────────────┐
     │ PostgreSQL Stores Graph      │
     │ • Entities: React, Vue, ...  │
     │ • Relations: has, simplifies │
     │ • Mentions: links to memory  │
     │ • Job marked complete        │
     └────────┬─────────────────────┘
              │
              ▼
     ┌───────────────────────────────┐
     │ Insight Engine Runs           │
     │ • Detects: React vs Vue       │
     │   competing preference        │
     │ • Marks: HIGH IMPACT          │
     │   (decision point)            │
     │ • Flags: UPDATE PREFERENCE    │
     │   (unresolved tension)        │
     └────────┬──────────────────────┘
              │
              ▼
     ┌──────────────────────────────────────┐
     │ Next Time User Recalls:              │
     │ - recall_memories_v2("React Vue")    │
     │ - Returns both options + context     │
     │ - Highlights decision tension       │
     │ - Suggests: "Pick one, consolidate" │
     │                                      │
     │ Result: Better decision support! ✅  │
     └──────────────────────────────────────┘
```

---

## Summary

These diagrams show:

1. **Architecture**: How MCP, vector, and graph layers work together
2. **Performance**: Fire-and-forget design enables speed + intelligence
3. **Dual recall modes**: Vector (fast) + Graph (rich)
4. **Insight engine**: Detecting contradictions and stale decisions
5. **Temporal patterns**: Recency and frequency analysis (coming soon)
6. **Database design**: PostgreSQL as unified store
7. **Workflow**: From save to insight in one async flow

All designed to make memory I/O blazingly fast while revealing hidden patterns in your thoughts and decisions.
