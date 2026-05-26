# Loop Miner — Episode & Loop Builder Architecture

## Overview

The **Loop Miner** is a background intelligence pipeline that analyzes a user's recent AI-assisted work history and discovers **repeated work patterns** (loops) that could be turned into automated workflows. It bridges three concepts:

| Concept | What it is | Example |
|---|---|---|
| **Events** | Raw activity logs (AI chats, collab tasks, memory records) | "Drafted changelog with Claude" |
| **Episodes** | Semantically grouped work sessions with extracted intent, output, and behavior | "Weekly changelog drafting — uses GitHub commits, outputs changelog, ~1hr" |
| **Loops** | Recurring episode clusters that share job-to-be-done, artifact, and action pattern | "Every week: review commits → draft changelog → publish" |
| **Workflow DNA** | Structured automation spec derived from an approved loop | Trigger: weekly; Sources: GitHub; Steps: review commits, draft notes, publish |

The pipeline runs either **daily** (`daily_intelligence`) or **manually**, producing `pending` workflow suggestions that users can activate.

For the current end-to-end runtime path and Mermaid flow diagrams, see [Loop Miner End-to-End](./flows/loop-miner-end-to-end.md).

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Loop Miner Pipeline                             │
│  (orchestration/loop-miner/)                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
            ┌───────────┐    ┌────────────┐    ┌─────────────┐
            │  Event     │    │  Episode   │    │   Loop      │
            │  Ingest    │───►│  Builder   │───►│  Detector   │
            │            │    │            │    │             │
            └────────────┘    └────────────┘    └──────┬──────┘
                                                       │
                              ┌────────────────────────┼────────────────┐
                              ▼                        ▼                ▼
                       ┌────────────┐           ┌─────────────┐   ┌──────────────┐
                       │   Loop     │           │     DNA     │   │  Workflow    │
                       │ Evaluator  │──────────►│  Generator  │──►│ Suggestion   │
                       │            │           │             │   │ (persisted)  │
                       └────────────┘           └─────────────┘   └──────────────┘
```

### Entry Point

```
src/orchestration/loop-miner/loop-miner.ts
  └─ runLoopMinerForUser(auth, options, deps?)
       ├─ creates run record
       ├─ calls episodeBuilder.execute()
       ├─ calls loopDetector.execute()
       ├─ calls loopEvaluator.execute()
       ├─ calls dnaGenerator.execute()
       └─ persists workflow suggestions
```

---

## Stage 1: Event Ingest

**File:** `src/infrastructure/repositories/loop-miner.repository.ts`

The repository pulls three event streams from PostgreSQL, merges them chronologically, and enriches them with importance metadata.

### Source Streams

| Source | Table | Role | Limits |
|---|---|---|---|
| `ai_activity_event` | `ai_activity_events` | User/assistant AI activity | 500 events |
| `collab_task` | `collab_tasks` | Collaboration task state changes | 300 tasks |
| `memory_record` | `memory_records` | Saved memories (facts, decisions, preferences) | 300 records |

### Memory Selection Heuristics

Not all memories become loop evidence. The repository applies a **decision log** that classifies each memory:

- **Fresh source imports** (`source_import = true`) → always included, high importance (`0.72`)
- **Unbucketed facts/decisions/preferences** → included (`0.64`)
- **Long-term / permanent bucket** → included (`0.45–0.6`)
- **Short-term / transient bucket** → excluded (`bucketed_memory_deprioritized`)
- **Decrypt failures** → excluded with trace

This decision log is surfaced in the run summary for debugging and prevents low-quality memories from diluting loop detection.

### Fallback Events

When a memory is included but no raw activity event exists for it, the repository fabricates a `memory_record` fallback event so the episode builder can still observe the work pattern. This is critical for imported ChatGPT memories that describe recurring workflows.

---

## Stage 2: Episode Builder

**File:** `src/orchestration/loop-miner/episode-builder.usecase.ts`

### Purpose
Group raw events into semantically coherent **work episodes** — single completed units of AI-assisted work.

### Two-Path Extraction

```
Events ─┬─► Deterministic extraction (cheap, no LLM)
        │      └─ explicit recurring workflow memories
        │      └─ imported memories with outputType + cadence
        │
        └─► LLM extraction (batched, budgeted)
               └─ everything else
```

#### Path A: Deterministic Extraction

If a `memory_record` event explicitly describes a recurring workflow (has `outputType`, `repeatable`, `likelyCadence`), the builder skips the LLM and creates an episode directly from the metadata. This is:
- **Fast** — zero AI calls
- **Reliable** — uses user-provided structure
- **Deterministic** — same input always yields same episode

#### Path B: LLM Extraction

Remaining events go through `gpt-4o-mini` (or configured model) with the `EPISODE_BUILDER_PROMPT`.

**Preprocessing:**
1. **Time-gap chunking** — split events by 4-hour gaps into chronological chunks
2. **Compaction** — truncate `contentSummary` to configurable char cap (`loopMinerEventSummaryCharCap`)
3. **Token-budget packing** — pack chunks into micro-batches that fit within `loopMinerPromptBudgetTokens` (~1200–2000 tokens), accounting for prompt base cost + per-item cost

**LLM output schema:**
```json
{
  "episodes": [{
    "title": "...",
    "summary": "...",
    "intent": {"label": "snake_case", "goal": "...", "confidence": 0.0–1.0},
    "sources": [{"type": "memory|document|conversation|integration|manual_input", "name": "...", "importance": 0.0–1.0}],
    "output": {"type": "newsletter|email|summary|proposal|code|changelog|unknown", "description": "..."},
    "toolNames": ["..."],
    "steps": ["..."],
    "styleHints": ["..."],
    "userBehavior": {"accepted": true|false|null, "edited": ..., "regenerated": ..., "ignored": ..., "approvalSignal": "approved|rejected|unclear"},
    "automationSignals": {"repeatable": true|false, "likelyCadence": "daily|weekly|monthly|event_based|unknown", "businessValue": 0.0–1.0, "automationReadiness": 0.0–1.0},
    "confidence": 0.0–1.0,
    "eventIds": ["e1", "e2"]
  }]
}
```

**Error handling:**
- Each batch is independent; one failing batch skips that batch but continues processing
- Application-level retry (`chatWithRetry`) catches `TimeoutError` / `ProviderTransientError` and retries once after 3s delay
- Failed batches emit warnings like `phase=episode_builder chunk=2/2 batch=1/1 reason=TimeoutError: ...`

**Persistence:** Episodes are saved to `episodes` + `episode_turns` tables with the run ID as foreign key.

---

## Stage 3: Loop Detector

**File:** `src/orchestration/loop-miner/loop-detector.usecase.ts`

### Purpose
Find clusters of episodes that represent the **same repeated work pattern**.

### Three-Layer Detection

The detector does **not** rely solely on an LLM. It uses a hybrid approach:

```
Layer 1: Structural matching (exact artifact + action signature)
Layer 2: Hybrid similarity (lexical + embedding + heuristic scoring)
Layer 3: LLM adversary + judge (semantic sanity check)
```

#### Step 1: Facet Extraction

Each episode is projected into a `WorkEpisodeFacet`:

| Facet field | Derived from |
|---|---|
| `jobToBeDone` | `episode.intent` |
| `artifactProduced` | `output.type` or `output.description` |
| `actionPattern` | `episode.steps` or `episode.intent` |
| `lexicalSignature` | Stemmed, stopword-filtered tokens from all evidence text |
| `embeddingText` | Condensed text for vector similarity (`intent + artifact + actions + sources`) |

#### Step 2: Embedding (Concurrency-Limited)

All facets are embedded via `text-embedding-3-small` (or configured embedding provider) in **batches of 5**. This prevents the thundering-herd connection errors that occur when firing 30+ embedding requests simultaneously.

Failures are non-fatal: the facet gets `vector = null` and falls back to lexical-only similarity.

#### Step 3: Group Generation (Heuristic)

Three grouping strategies run in order:

| Strategy | Condition | Confidence |
|---|---|---|
| **Memory action matching** | Memory episodes with same `artifactProduced` + matching action signature (≥2 tokens) | `0.64` / `0.72` if repeatable declared |
| **Artifact-source pattern** | Same artifact + action signature, artifact in allowlist (`newsletter`, `changelog`, `email`, `proposal`, `code`, `summary`) | `0.68` |
| **Hybrid similarity** | Union-find over Jaccard + cosine similarity with tuned thresholds | `0.5–0.92` |

**Similarity formula:**
```
score = vector*0.2 + action*0.28 + job*0.24 + artifact*0.14 + source*0.08 + tool*0.04 + time*0.02
```

With a **same-artifact-and-source boost** of `+0.66` when artifact similarity ≥ 0.9, source ≥ 0.5, and job ≥ 0.1.

**Pair threshold (`pairLooksLikeRepeatedWork`):**
- `score ≥ 0.42`, `jobSimilarity ≥ 0.18`, plus action/artifact/tool/source/vector gate
- OR very strong semantic: `score ≥ 0.58` and `jobSimilarity ≥ 0.26`

#### Step 4: LLM Consolidator + Adversary + Judge

For each candidate group, three LLM calls run sequentially:

1. **PatternConsolidator** — names the loop, explains shared job/artifact/actions (`maxTokens: 1800`)
2. **PatternAdversary** — challenges topical similarity, weak evidence, over-automation (`maxTokens: 1600`)
3. **PatternJudge** — final verdict: `approved_loop`, `approved_with_modification`, `monitor_pattern`, `rejected_topical_similarity`, `rejected_insufficient_evidence` (`maxTokens: 1700`)

**Fallbacks:** If any LLM call fails, the detector falls back to **heuristic implementations** that mirror the LLM logic using the already-computed confidence scores and evidence. This ensures the pipeline never blocks on a transient provider error.

**Output:** `CandidateLoop[]` + full `PatternTrace` for debugging.

---

## Stage 4: Loop Evaluator

**File:** `src/orchestration/loop-miner/loop-evaluator.usecase.ts`

### Purpose
Qualify detected loops against a higher bar before generating a workflow suggestion.

### What it evaluates
- **Verdict:** `automate` | `monitor` | `discard`
- **Automation readiness:** `full` | `partial` | `manual`
- **Estimated value:** `low` | `medium` | `high`
- **Risks:** list of concerns (e.g., "human judgment still central")
- **Cadence:** inferred schedule from episode time signals

### Input
The evaluator receives candidate loops **plus the full episode context** (up to 8 episodes per loop, turns compacted to 500 chars × 6 turns) so it can inspect actual work content, not just summaries.

### Batching
Like the episode builder, loops are packed by estimated token budget. A single LLM call can evaluate multiple loops in one batch.

### Gate
Only loops with verdict ≠ `discard` proceed to DNA generation.

---

## Stage 5: DNA Generator

**File:** `src/orchestration/loop-miner/dna-generator.usecase.ts`

### Purpose
Convert a qualified loop into a structured **WorkflowDNA** — the automation blueprint.

### Output Schema
```json
{
  "name": "Weekly changelog",
  "trigger": {"type": "schedule", "cadence": "weekly"},
  "sources": ["github"],
  "outputType": "changelog",
  "stepPattern": ["Review commits", "Draft notes", "Publish"],
  "style": "Concise, bullet-pointed",
  "approvalBehavior": "require_explicit_approval",
  "reasoning": "User repeats this every week with stable steps and artifact"
}
```

### Prompt Strategy
The `DNA_GENERATOR_PROMPT` instructs the model to synthesize the DNA from:
- The candidate loop (shared intent, sources, output)
- The evaluation (verdict, readiness, risks)
- The actual episode turns (real evidence, not summaries)

### Fallback Resolution
If the LLM returns malformed or mismatched DNA rows, the generator uses `resolveFallbackLoop` to map rows back to the correct qualified loop by episode-ID key or name.

---

## Stage 6: Workflow Suggestion Persistence

**File:** `src/infrastructure/repositories/loop-miner.repository.ts`

### Deduplication Guards
Before inserting a suggestion, the repository checks three conditions:

1. **Existing pending** suggestion with same fingerprint → skip
2. **Active/paused workflow** with same fingerprint → skip
3. **Dismissed suggestion** within 60 days with same fingerprint → skip (cooldown)

### Fingerprint
A SHA-256 hash of the JSON-serialized DNA. This makes suggestions idempotent across reruns.

### Metadata
Each suggestion stores:
- `loopMinerRunId`
- Full `dna`, `evaluation`, and `candidateLoop`
- `metadataHash` for integrity

---

## Domain Models

### EpisodeGraph

```
EpisodeRecord
├── id, sealedAt, turnCount
├── intent, sources, outputType, toolNames, steps, styleHints
├── userBehavior { accepted, edited, regenerated, ignored, approvalSignal }
├── automationSignals { repeatable, likelyCadence, businessValue, automationReadiness }
├── confidence, approved
├── eventIds[]
└── turns: EpisodeTurnRecord[]
    ├── role, contentSummary, sourceEventType, sourceEventId, createdAt
```

### LoopGraph

```
CandidateLoop
├── loopName
├── episodeIds[]
├── sharedIntent, sharedSources, sharedOutputType
├── reasoning, patternConfidence, patternStatus

PatternCandidateGroup
├── id, episodeIds[]
├── title, sharedJob, sharedArtifact
├── sharedActions[], sharedSources[], sharedTools[]
├── evidenceSummary, confidence, cadenceSignal, generationReason
└── facets: WorkEpisodeFacet[]
```

### WorkflowDNA

```
WorkflowDNA
├── name
├── trigger: { type: "schedule"|"event", cadence: string }
├── sources[], outputType, stepPattern[], style
├── approvalBehavior: "auto" | "require_explicit_approval"
└── reasoning
```

---

## Resilience & Error Handling

| Layer | Policy | Details |
|---|---|---|
| **Provider calls** | `composePolicy` | Timeout + retry + circuit breaker per provider |
| **Chat policy** | 10s timeout, 2 retries, 500ms–2s jitter, circuit: 5 failures / 30s cooldown |
| **Embed policy** | 5s timeout, 3 retries, 300ms–1.5s jitter, circuit: 8 failures / 20s cooldown |
| **Episode builder** | App-level `chatWithRetry` | 2 attempts, 3s linear delay for timeouts & transients |
| **Loop detector embeddings** | Concurrency limit | 5 parallel at a time |

### Fail-Safe Behaviors

- **Episode batch fails** → skip batch, continue with others, emit warning
- **Consolidator fails** → fallback to `fallbackLoop()` from candidate group
- **Adversary fails** → fallback to `heuristicAdversary()` using confidence + evidence
- **Judge fails** → fallback to `heuristicJudge()` using adversary + group data
- **Evaluator fails** → skip loop, do not discard
- **DNA generator fails** → skip DNA for that loop

---

## Prompt Engineering Philosophy

The Loop Miner uses **task-specific system prompts** rather than a single monolithic prompt. Each phase has a narrow, well-defined role:

| Phase | Prompt file | Role |
|---|---|---|
| Episode Builder | `EPISODE_BUILDER_PROMPT` | Group events into work sessions |
| Pattern Consolidator | `PATTERN_CONSOLIDATOR_PROMPT` | Name and describe repeated patterns |
| Pattern Adversary | `PATTERN_ADVERSARY_PROMPT` | Challenge weak candidates |
| Pattern Judge | `PATTERN_JUDGE_PROMPT` | Final approve/reject with status |
| Loop Evaluator | `LOOP_EVALUATOR_PROMPT` | Qualify loops for automation |
| DNA Generator | `DNA_GENERATOR_PROMPT` | Build structured workflow spec |

All prompts:
- Request **JSON-only** output (`responseFormat: "json_object"`)
- Include concrete examples and rejection criteria
- Do **not** require explicit cadence language for approval
- Emphasize **behavioral repetition** over topical similarity

---

## Key Design Decisions

1. **Deterministic + LLM hybrid extraction** — Fast path for structured memories; slow path for unstructured activity.
2. **Token-budget packing** — Every LLM phase respects a configurable prompt budget, allowing the pipeline to scale to large event volumes without exceeding context windows.
3. **Three-layer loop detection** — Structural → hybrid similarity → LLM judge. This catches obvious patterns cheaply while still using LLMs for nuanced semantic judgment.
4. **Heuristic fallbacks for all LLM phases** — The pipeline degrades gracefully when the provider is flaky.
5. **Fingerprint-based deduplication** — Prevents suggestion spam and supports cooldowns.
6. **Full pattern trace** — Every run records candidate groups, adversary findings, and judge decisions for observability and iterative improvement.
7. **Memory decision log** — Transparently surfaces why each memory was included or excluded, aiding debugging of loop quality.

---

## File Map

```
src/orchestration/loop-miner/
├── loop-miner.ts              # Entry point: runLoopMinerForUser()
├── episode-builder.usecase.ts # Stage 2: event → episode
├── loop-detector.usecase.ts   # Stage 3: episode → loop candidates
│   ├── pattern consolidator
│   ├── pattern adversary
│   └── pattern judge
├── loop-evaluator.usecase.ts  # Stage 4: loop qualification
├── dna-generator.usecase.ts   # Stage 5: loop → WorkflowDNA
├── types.ts                   # Domain models
├── prompts.ts                 # All system prompts
├── utils.ts                   # Chunking, compaction, token packing, normalization
├── model.ts                   # Model selection per phase
└── loop-miner.ts              # Wiring + run orchestration

src/infrastructure/repositories/
└── loop-miner.repository.ts   # Event ingest, episode persist, suggestion dedup
```
