# Loop Run Architecture Review

## Builder → Runner Seam (loop_spec_v1)

Spec-driven loops use a strict three-layer boundary. Do not add LLM structure decisions at the runner or duplicate tool-role logic outside the shared classifier.

| Layer | Owner | Source of truth |
|-------|--------|-----------------|
| **Design** | Loop builder (`LoopBuildContract`) | User-approved requirements: connectors, schedule, review policy, artifacts |
| **Compile** | `runner-spec-compiler.ts` via `buildRunnerSpecFromBuildContract` | Deterministic agent graph, gates, tool assignments — no LLM |
| **Execute** | `spec-run-agent-runner.ts` | Reads persisted `LoopDefinition` only; LLM operates inside compiled agents |

### Rules

1. **`LoopBuildContract` is the only user-authored truth.** Never edit agent structure independently in the runner.
2. **`compileRunnerSpecFromBuildContract` is the only structure compiler.** `specs.ts` delegates to it; do not reimplement compile logic elsewhere.
3. **`tool-roles.ts` is the only tool-role classifier.** Both the compiler and `compileSpecRunPlan` import it — do not re-derive send/write/draft/delivery heuristics.
4. **Persisted definitions embed slim tool contract refs** (toolRef + routing metadata) and inline artifact templates at save time. `hydrateDefinitionForExecution` expands slim agent-graph defaults **and** rehydrates Composio schemas from the local `composio-catalog`. Builder sessions remain the source of full discovery data during build only.
5. **Slim/hydrate is transport, not semantics.** `definition-slim.ts` / `definition-hydration.ts` expand persisted shape; they must not re-decide agent tools or gates.

### Boundary band-aids (classified)

| File | Verdict | Role |
|------|---------|------|
| `src/services/loop-engine/tool-roles.ts` | **Keep** | Single classifier for compiler + run plan |
| `src/services/loop-builder/runner-spec-compiler.ts` | **Keep** | Deterministic compile API |
| `src/services/loop-builder/tool-call-repair.ts` | **Keep** | Model tool-call entropy at runtime |
| `src/services/loop-builder/tool-input-json-repair.ts` | **Keep** | Model JSON entropy at runtime |
| `src/services/loop-runtime/definition-hydration.ts` | **Keep** | Slim-definition expansion only |
| `src/services/loop-runtime/definition-slim.ts` | **Keep** | Lossless persistence transport |
| `dashboard/.../spec-run-transcript-hydration.ts` | **Keep (UI)** | Run transcript reconstruction — out of compile seam |
| `dashboard/src/lib/spec-run-stream-guard.ts` | **Keep (UI)** | Stream dedup — out of compile seam |
| `dashboard/src/lib/spec-run-run-merge.ts` | **Keep (UI)** | Run projection merge — out of compile seam |

---

## 1. Overall Architecture

### 1.1 Core Concepts

| Entity | Description | Persisted In |
|--------|-------------|------------|
| **Workflow** | The recurring blueprint (goal, schedule, tools, preset). One per loop. | `workflows` table |
| **Run** | A single execution instance of a workflow. | `workflow_runs` table |
| **Task** | One agent execution within a run. | `loop_run_tasks` table |
| **Heartbeat Job** | Async unit of work that drives a run forward. | `loop_heartbeat_jobs` table |
| **Comment** | Agent output or human note attached to a run/task. | `loop_run_comments` table |
| **Event** | Audit log of what happened during a run. | `loop_run_events` table |
| **Artifact** | Structured output from a plan stage (dynamic plans only). | `loop_run_artifacts` table |

### 1.2 Execution Model — Heartbeat-Driven

The loop executor does **not** use a long-running process per run. Instead it uses a **heartbeat** pattern:

1. A run is created in `workflow_runs` with status `running`.
2. A **heartbeat job** is enqueued in `loop_heartbeat_jobs` (e.g., `ceo_strategy`).
3. A **scheduler** or **worker** polls `loop_heartbeat_jobs` for pending jobs and executes them.
4. Each heartbeat execution updates DB state and, if more work is needed, enqueues the *next* heartbeat job.
5. This repeats until the run reaches a terminal state (`completed`, `blocked`, `waiting_for_approval`, etc.).

**Job types:**
- `ceo_strategy` — CEO plans the roster.
- `agent` — Execute one agent task.
- `ceo_finalize` — CEO synthesizes final output after all agents complete.
- `distribution` — Send the broadcast / Resend delivery.

### 1.3 Scheduling & Cron

**Two schedulers run independently (both in-process `setInterval`):**

| Scheduler | File | Purpose | Poll Interval |
|-----------|------|---------|---------------|
| **Workflow Scheduler** | `scheduler.ts` | Finds workflows whose `next_run_at <= NOW()`, creates a new run, and advances `next_run_at` via the cron rule. | `config.loopExecutorPollMs` |
| **Heartbeat Worker** | `heartbeat-worker.ts` | Claims pending `loop_heartbeat_jobs` and executes them. | `config.loopExecutorHeartbeatPollMs` |

**Cron parsing:** `cron.ts` implements a 5-field cron parser (minute, hour, day-of-month, month, day-of-week) in UTC. `nextCronRunAt()` computes the next trigger by brute-force scanning forward minute-by-minute (max 5 years).

**Important:** `startLoopExecutorScheduler()` and `startLoopHeartbeatWorker()` are called at app boot. They are **no-ops** if `config.loopExecutorScheduler !== "internal"` or `config.loopExecutorHeartbeatDispatch !== "internal"`, respectively.

### 1.4 Run Lifecycle (Status Machine)

```
running
   └─► ceo_strategy heartbeat
       ├─► [preset] → strategy_approved  (auto, no human gate)
       └─► [no preset] → waiting_for_strategy_approval
           └─► user approves → strategy_approved

strategy_approved
   └─► agent heartbeat (task 0)
       ├─► next agent → running → agent heartbeat (task N)
       └─► last agent done → ceo_finalize

running (agent heartbeats continue)
   └─► all agents done → ceo_finalize

ceo_finalize
   ├─► [no draft required] → completed
   └─► [draft required] → waiting_for_approval
       └─► user approves → waiting_for_contact_list
           └─► user uploads CSV → executing_action
               └─► distribution heartbeat → completed | blocked
```

### 1.5 What Gets Updated During a Run

**Per heartbeat, the executor typically updates:**
- `workflow_runs.status` — the run state machine.
- `workflow_runs.metadata_json` — run state (`loop_executor` key) including roster, approvals, delivery info, errors.
- `workflow_runs.draft_output` — the final synthesized output (e.g., newsletter body).
- `workflow_runs.strategy_output` — CEO plan text.
- `workflow_runs.connector_action_status` — delivery status (e.g., `distribution_pending`, `completed`).
- `loop_run_tasks` — task status (`todo` → `in_progress` → `done` / `blocked`), output_json, error_json.
- `loop_run_comments` — one comment per agent output + CEO comments + user comments.
- `loop_run_events` — audit trail (strategy_ready, agent_completed, broadcast_sent, etc.).
- `loop_run_artifacts` — for dynamic-plan definitions only.
- `loop_heartbeat_jobs` — job status (`pending` → `processing` → `done` / `failed`).
- `workflows.metadata_json` — after delivery, the workflow itself gets a `lastDeliveryBatch` / `lastDeliveryAction` snapshot for future runs.

### 1.6 What Does NOT Get Updated

- **Workflow definition** (`workflows.metadata_json.loopDefinition`) is **immutable** during a run. The run reads the definition at `loadRunContext()` time; edits to the workflow do not affect an in-flight run.
- **Previous runs** are never touched.
- **Memory/vector store** is read by agents (e.g., `internal.memory_search`) but not written by the loop executor itself.
- **User auth / tenant settings** are not modified.

### 1.7 Heartbeat Job Details

**`heartbeat-jobs.ts`** — DB operations:
- `enqueueLoopHeartbeatJob` — INSERT … ON CONFLICT (`idempotency_key`) DO UPDATE. Idempotency keys are:
  - `{runId}:agent:{taskId}`
  - `{runId}:distribution:{suffix}`
  - `{runId}:ceo_strategy`
  - `{runId}:ceo_finalize`
- `claimLoopHeartbeatJobs` — SELECT `pending` rows with `next_attempt_at <= NOW()` FOR UPDATE SKIP LOCKED; sets `status = 'processing'` and `attempts += 1`.
- `failLoopHeartbeatJob` — if `attempts < max_attempts`, requeues with exponential backoff (`min(30 * attempts, 300)` seconds). Otherwise marks `failed`.
- `completeLoopHeartbeatJob` — marks `done`.

**`run-heartbeat.ts`** — `scheduleHeartbeat()`:
1. Enqueues the job via `enqueueLoopHeartbeatJob()`.
2. Immediately attempts to **run the job in-process** via dynamic imports (`runAgentHeartbeat`, `runCeoStrategyHeartbeat`, etc.).
3. If in-process succeeds, marks job `done`.
4. If it fails, the job remains pending for the background worker to retry.

**`heartbeat-dispatch.ts`** — background batch processor:
- Claims up to `config.loopExecutorHeartbeatBatchSize` (max 25) pending jobs.
- Executes each job in parallel via `Promise.all`.
- On failure, calls `failLoopHeartbeatJob` and `markRunBlocked` if max attempts reached.

---

## 2. Newsletter Preset Deep Dive

### 2.1 How the Preset Is Selected

`resolveLoopPreset()` in `presets/registry.ts` checks in order:
1. `definition.presetId` explicitly matches `newsletter` or `newsletter_v1`.
2. If no explicit preset, the definition `goal` contains the word `newsletter` (case-insensitive).
3. If the definition allows `internal.resend_broadcast` in `allowedToolRefs`.

If any match, `newsletterPreset` is used.

### 2.2 The Fixed Roster (5 Agents)

`buildNewsletterPresetRoster()` in `presets/newsletter.ts` returns a hardcoded CEO strategy and a fixed agent pipeline. The strategy text includes pinned memory records (seeded weekly links) and a default topic hypothesis.

| Seq | Agent ID | Name | What It Does | Tools |
|-----|----------|------|--------------|-------|
| 0 | `search_agent` | Search Agent | Searches memory for previous newsletters, voice, style, and ranks three topic candidates. | `internal.memory_search` |
| 1 | `web_search_agent` | Web Search Agent (or Seeded Source Agent) | Gathers source-grounded evidence. If `config.loopExecutorNewsletterLiveWebSearchEnabled` is true, it does live web search against allowed domains. Otherwise it uses the hardcoded `NEWSLETTER_DEV_SOURCE_LINKS` list. | `internal.web_search` (live) or `internal.llm_only` (dev) |
| 2 | `research_agent` | Research Agent | Synthesizes search outputs into a writer briefing: selected topic, why now, core arguments, source links, tone/structure guidance. | `internal.llm_only` |
| 3 | `writer` | Writer | Writes the subscriber-facing newsletter draft. **Must** adopt the voice/style found by Search Agent. Line 1 must be `Subject: <email subject>`. | `internal.llm_only` |
| 4 | `approval_handoff` | Approval Handoff | Sends the final draft for operator approval and prepares email builder / render tools. | `internal.email_approval_request`, `internal.email_builder_compose`, `internal.email_builder_render` |

### 2.3 Preset Execution Flow

**Step 1 — `executeLoopWorkflow()` (`executor.ts:1077`)**
- A new `workflow_runs` row is inserted with:
  - `status = 'running'`
  - `run_mode = 'scheduled'` or `'manual'`
  - `scheduled_for` (if scheduled)
  - `metadata_json` seeded with `loop_definition_version` and `scheduler_target`.
- A status notification is sent (best-effort, catch-swallowed).
- A `ceo_strategy` heartbeat is scheduled.

**Step 2 — `runCeoStrategyHeartbeat()` (`executor.ts:61`)**
- `loadRunContext(runId)` loads the run + workflow definition.
- `buildCeoStrategyOutput()` is called.
  - Because the definition resolves to the newsletter preset, `buildNewsletterPresetRoster()` is invoked directly.
  - No LLM call is made for strategy in this preset.
- `validateAgentRoster()` checks that the preset's agents only use allowed tools.
- **Because a preset exists**, the code takes the **auto-approve branch** (`executor.ts:76`):
  - `materializeTasksFromRoster()` inserts 5 rows into `loop_run_tasks` (status `todo`, seq 0–4).
  - `workflow_runs` is updated:
    - `status = 'strategy_approved'`
    - `strategy_output = ceoOutput.strategyText`
    - `waiting_for_strategy_approval = FALSE`
    - `metadata_json.loop_executor` patched with `approvedRoster`, `rosterApprovedAt`, `strategyReadyAt`.
  - An event `preset_roster_started` is inserted.
  - The first agent task heartbeat is scheduled.

**→ No human strategy approval is required for the newsletter preset.**

**Step 3 — Agent Heartbeats (`runAgentHeartbeat()` at `executor.ts:227`)**
- `checkoutTask()` uses `FOR UPDATE OF t SKIP LOCKED` to atomically claim the next `todo` task as `in_progress`.
- `workflow_runs.status` is set to `running` if it was `strategy_approved`.
- For the first 4 agents (`search_agent` through `writer`), the agent is executed via `runLoopAgent()` (`agent-runner.ts`).
  - Agent output is inserted into `loop_run_comments` (author = agent ID).
  - Task output is saved to `loop_run_tasks.output_json`.
  - Event `agent_completed` is inserted.
  - The next agent heartbeat is scheduled via `scheduleHeartbeat()`.

**Step 4 — The Approval Handoff (`approval_handoff` agent)**
- The `approval_handoff` agent runs with tools `internal.email_approval_request`, `internal.email_builder_compose`, `internal.email_builder_render`.
- If the agent calls `email_approval_request`, `runLoopAgent()` returns `emailApprovalSent: true` plus an `approvalRequest` object.
- In `executor.ts:419`, `applyEmailApprovalResult()` is called:
  - `workflow_runs` is updated:
    - `status = 'waiting_for_email_approval'`
    - `draft_output = artifactBody` (the newsletter body)
    - `connector_action_status = 'pending_approval'`
    - `metadata_json.loop_executor` patched with `approvalRequest` and `artifactBody`.
  - Event `run_approval_email_sent` is inserted.
- **The run now pauses for human approval.**

**Step 5 — Human Approval (`approval.ts`)**
- A user can approve via:
  - UI: `approveLoopRunFromUi()` → `transitionRunToDelivery()`
  - Email token: `approveLoopRunApprovalToken()` → `transitionRunToDelivery()`
- `transitionRunToDelivery()` (`approval.ts:56`) updates:
  - `workflow_runs.status = 'waiting_for_contact_list'`
  - `metadata_json.loop_executor` patched with:
    - `approvalDecision` (approvedAt, channel)
    - `pendingInput` (id=`delivery_recipients`, kind=`csv`, status=`pending`, instructions to upload CSV)
- **The run now waits for the recipient list.**

**Step 6 — Recipient Upload (`uploadDeliveryRecipients()` at `approval.ts:157`)**
- Parses CSV via `parseContactListCsv()` (email required, name optional; max 5,000 rows; deduplicates by email).
- Stashes the contact list as a document via `stashDocument()` (gets a `refHandle` and optional `lotRef`).
- Determines if React Email is enabled (newsletter preset is always treated as React Email eligible).
- `workflow_runs` is updated:
  - `status = 'executing_action'`
  - `connector_action_status = 'distribution_pending'`
  - `metadata_json.loop_executor` patched with:
    - `pendingInput` → status `submitted`
    - `deliveryRecipients` (contacts, count, documentRef, lotRef)
    - `deliveryTemplateId` (if provided)
    - `deliveryAction` (kind=`send_broadcast`, status=`in_progress`, counts)
- Event `delivery_recipients_uploaded` is inserted.
- A `distribution` heartbeat is scheduled.

**Step 7 — Distribution Heartbeat (`runDistributionHeartbeat()` at `distribution.ts:60`)**
- Only runs if `workflow_runs.status === 'executing_action'`.
- Loads contacts from `metadata_json.loop_executor.deliveryRecipients`.
- Determines the delivery body:
  - `deliveryContentBody` from metadata, or `artifactBody`, or `draft_output`.
- Resolves the formatter: `newsletterDeliveryFormatter` (because it is a newsletter preset).
- `sanitizeSubscriberBody()` strips internal instructions, approval cues, contact-list notes, and "Lenny" voice leaks.
- `formatNewsletterForEmail()` parses the markdown into:
  - `subject` (extracted from `Subject:` line or first bold/heading)
  - `text` (cleaned markdown body)
  - `html` (Substack-style inline HTML with headings, lists, intro italics, sign-offs, unsubscribe footer)
- `formatNewsletterForBroadcast()` is called:
  - By default, it uses **React Email** (`newsletter-react-email.ts`).
  - It maps the template ID (e.g., `01-barebone-feature-announcement`) to a React Email template and renders server-side HTML/text.
  - If `useReactEmail` is false, it falls back to a basic HTML wrapper with Resend unsubscribe tags.
- **Resend integration** (`resend-broadcast.ts`):
  - Resolves Resend marketing credentials.
  - Ensures a metrics webhook exists for open/click tracking.
  - Builds tracking diagnostics (HTML byte size, Gmail clipping risk, etc.).
  - Creates a Resend segment (audience list) named `Tallei {title} {runId}`.
  - **Syncs contacts in batches of 15** (`contactBatchSize`):
    - `upsertResendContactInSegment()` is called per contact.
    - If not all contacts are synced, a new `distribution` heartbeat is scheduled with `delaySeconds: 2` and `idempotencySuffix: contacts-{processedCount}`.
    - `workflow_runs.status` remains `executing_action`.
    - `connector_action_status` becomes `distribution_pending`.
  - Once all contacts are synced, `createAndSendResendBroadcast()` is called with:
    - `segmentId`
    - `subject`
    - `html` (React Email or custom builder HTML)
    - `text` (plain text version)
    - `name` (broadcast name)
  - If broadcast fails, run becomes `blocked`.
  - If broadcast succeeds, `finalizeDistributionRun()` is called.

**Step 8 — Finalize (`finalizeDistributionRun()` at `distribution.ts:375`)**
- `workflow_runs` is updated:
  - `status = 'completed'` or `'blocked'` (if any recipient failed or it was a dry run)
  - `draft_output = deliveryBody` (final sanitized body)
  - `connector_action_status = 'completed'` or `'partial_failure'`
  - `metadata_json.loop_executor` patched with `deliveryBatch` and `deliveryAction` (final counts, broadcastId, timestamps).
- A CEO comment is inserted with a summary:
  - Final output + distribution summary (success/failure counts, Resend broadcast ID, dry-run notice if applicable).
- Event `ceo_finalized` and `broadcast_sent` are inserted.
- The parent `workflows` row is updated with `lastDeliveryBatch`, `lastDeliveryRecipients`, and `lastDeliveryAction` so the next scheduled run can reference them.
- A status notification is sent (best-effort).

### 2.4 What Is Updated (Newsletter-Specific)

| Step | Table(s) | Fields / Rows Changed |
|------|----------|----------------------|
| Run start | `workflow_runs` | Insert row with `running`, `metadata_json`, `scheduled_for` |
| CEO strategy | `workflow_runs` | `status → strategy_approved`, `strategy_output`, `metadata_json` (roster, timestamps) |
| CEO strategy | `loop_run_tasks` | Insert 5 rows (seq 0–4, status `todo`) |
| CEO strategy | `loop_run_events` | Event `preset_roster_started` |
| Each agent | `loop_run_tasks` | `status → in_progress → done`, `output_json`, `completed_at` |
| Each agent | `loop_run_comments` | Insert comment (author = agent ID, body = output) |
| Each agent | `loop_run_events` | Event `agent_completed` |
| Approval handoff | `workflow_runs` | `status → waiting_for_email_approval`, `draft_output`, `connector_action_status → pending_approval`, `metadata_json` (approvalRequest, artifactBody) |
| Approval handoff | `loop_run_events` | Event `run_approval_email_sent` |
| Human UI approval | `workflow_runs` | `status → waiting_for_contact_list`, `metadata_json` (approvalDecision, pendingInput) |
| CSV upload | `workflow_runs` | `status → executing_action`, `connector_action_status → distribution_pending`, `metadata_json` (deliveryRecipients, pendingInput submitted, deliveryAction) |
| CSV upload | `loop_run_events` | Event `delivery_recipients_uploaded` |
| Distribution (contact sync) | `workflow_runs` | `metadata_json` (distribution in-progress, deliveryAction syncing_contacts) |
| Distribution (contact sync) | `loop_heartbeat_jobs` | Re-enqueue `distribution` with 2s delay |
| Distribution (send) | `workflow_runs` | `status → completed/blocked`, `draft_output`, `connector_action_status`, `metadata_json` (deliveryBatch, deliveryAction) |
| Distribution (send) | `workflows` | `metadata_json` (lastDeliveryBatch, lastDeliveryRecipients, lastDeliveryAction) |
| Distribution (send) | `loop_run_comments` | CEO comment with final summary |
| Distribution (send) | `loop_run_events` | Events `ceo_finalized`, `broadcast_sent` |

### 2.5 What Is NOT Updated (Newsletter-Specific)

- **No LLM strategy call:** The preset bypasses the CEO LLM entirely (`buildNewsletterPresetRoster()` returns a hardcoded strategy and agents).
- **No `waiting_for_strategy_approval`:** The preset auto-materializes tasks and skips the human strategy gate.
- **No agent graph / plan edits:** The 5-agent roster is fixed; the user cannot modify the sequence via the UI for a preset run.
- **No dynamic artifacts:** The newsletter preset does not use the dynamic plan artifact system (`loop_run_artifacts` are not used, except implicitly via the `approval_handoff` agent's output).
- **Memory store is read-only:** The `search_agent` reads memory via `internal.memory_search`, but the loop executor does not write new memories at the end of the run.
- **No external action task row:** The `approval_handoff` is an agent task, not an `external_action` stage; the actual Resend broadcast happens in the `distribution` heartbeat, not in an agent heartbeat.

### 2.6 React Email Templates

`formatNewsletterForBroadcast()` in `presets/newsletter.ts` uses `newsletter-react-email.ts` by default. Available templates:

| Template ID | Label |
|-------------|-------|
| `01-barebone-feature-announcement` | Barebone / Feature announcement (default) |
| `02-matte-feature-announcement` | Matte / Feature announcement |
| `03-protocol-feature-announcement` | Protocol / Feature announcement |
| `02-matte-product-update` | Matte / Product update |
| `04-tech-newsletter` | Tech / Newsletter |
| `05-skin-newsletter` | Skin / Editorial |
| `06-codepen-challenge` | CodePen / Challenge |
| `07-stackoverflow-tips` | Stack Overflow / Tips |

The template is chosen via `normalizeNewsletterTemplateId()`, which defaults to `01-barebone-feature-announcement`.

### 2.7 Hardcoded Frontend Integration

The dashboard (`dashboard/app/dashboard/loops/page.tsx`) contains a **hardcoded** newsletter loop card:
- `hardcodedNewsletterLoop()` returns a synthetic `LoopInsight` object with IDs like `hardcoded-newsletter-loop-v1`, `hardcoded-newsletter-research`, etc.
- It appears in the UI even if the user has not created a newsletter workflow yet.
- When the user clicks "Run loop" on this card:
  1. It searches existing workflows for a `newsletter` preset with the Lenny goal.
  2. If found, it uses that workflow's `workspaceId`.
  3. If not found, it creates a new workflow via the API with:
     - `goal = LENNY_NEWSLETTER_LOOP_GOAL`
     - `cron = HARDCODED_NEWSLETTER_CRON` (`0 9 * * 1` — 9:00 UTC every Monday)
     - `preset_id = "newsletter"`
     - `allowedToolRefs = NEWSLETTER_ALLOWED_TOOL_REFS` (includes `resend_broadcast` and `react_email_template`)
  4. Then it immediately executes the loop via `executeLoopWorkflow`.

### 2.8 Delivery Formatting & Sanitization

**`sanitizeSubscriberBody()`** (`newsletter.ts:310`) is aggressive about removing non-subscriber content:
- Cuts at the first internal cue phrase (e.g., "please review this draft", "upload a CSV", "once approved", "prepare it for distribution").
- Cuts at markdown headers like `## Operator approval email`, `## Next steps`, `## Contact list`, `## Handoff`.
- Removes lines that are just placeholders (`[insert ... here]`), publicist labels, draft labels, or leaked instructions about "Lenny's voice".
- Removes unsupported CTA phrases like "Read more here." or "Explore the details."
- Collapses excessive newlines.

**`formatNewsletterForEmail()`** (`newsletter.ts:407`) converts sanitized markdown to inline HTML:
- Extracts `Subject:` line into metadata.
- Detects italic intro paragraphs (`*text*`) and renders with `font-style:italic`.
- Detects sign-offs (`That's all for this week`, `Thanks for reading`, `See you next`) and adds top margin.
- Converts headings (`#`, `##`, `###`) to styled `<h2>`, `<h3>`, `<h4>`.
- Converts numbered items (`1) Title`) to bold headings.
- Converts bullet lists (`- item`) to `<ul>` with styled `<li>`.
- Wraps everything in a table-based email layout (640px max width, mobile-friendly) with:
  - Subscribe forwarding line
  - Date stamp
  - Body content
  - Unsubscribe / preferences footer

### 2.9 Configuration & Feature Flags

| Config / Flag | File | Effect |
|---------------|------|--------|
| `loopExecutorNewsletterLiveWebSearchEnabled` | `config/index.ts` | If `true`, the `web_search_agent` uses live `internal.web_search` against allowed domains. If `false`, it uses the hardcoded seeded source list (`NEWSLETTER_DEV_SOURCE_LINKS`). |
| `loopExecutorScheduler` | `config/index.ts` | Must be `"internal"` for the cron scheduler to start. |
| `loopExecutorHeartbeatDispatch` | `config/index.ts` | Must be `"internal"` for the heartbeat worker to start. |
| `loopExecutorPollMs` | `config/index.ts` | Workflow scheduler polling interval. |
| `loopExecutorHeartbeatPollMs` | `config/index.ts` | Heartbeat worker polling interval. |
| `loopExecutorSchedulerBatchSize` | `config/index.ts` | Max workflows claimed per scheduler tick. |
| `loopExecutorHeartbeatBatchSize` | `config/index.ts` | Max heartbeat jobs claimed per worker tick. |

---

## 3. Summary of Data Flow

```
[Scheduled Cron] or [Manual UI Click]
        │
        ▼
   executeLoopWorkflow()
        │
        ▼
  workflow_runs INSERT (status=running)
        │
        ▼
  scheduleHeartbeat(ceo_strategy)
        │
        ▼
  runCeoStrategyHeartbeat()
   ├─ preset bypasses LLM
   ├─ inserts 5 tasks
   ├─ status → strategy_approved
   └─ scheduleHeartbeat(agent, task=0)
        │
        ▼
  runAgentHeartbeat() × 4
   ├─ checkout task
   ├─ runLoopAgent()
   ├─ insert comment + output
   └─ scheduleHeartbeat(agent, next)
        │
        ▼
  runAgentHeartbeat() × 1 (approval_handoff)
   ├─ may trigger email approval
   ├─ status → waiting_for_email_approval
   └─ (PAUSED)
        │
        ▼
  [Human approves via UI or email]
        │
        ▼
  status → waiting_for_contact_list
        │
        ▼
  [Human uploads CSV]
        │
        ▼
  uploadDeliveryRecipients()
   ├─ parse CSV
   ├─ status → executing_action
   └─ scheduleHeartbeat(distribution)
        │
        ▼
  runDistributionHeartbeat()
   ├─ sync contacts to Resend (batch 15)
   ├─ (may re-schedule distribution)
   ├─ send Resend broadcast
   └─ finalizeDistributionRun()
        │
        ▼
  status → completed / blocked
   draft_output = final body
   workflow updated with last delivery snapshot
```

---

*Document generated from source code in `src/services/loop-executor/` and `dashboard/app/dashboard/loops/page.tsx`.*
