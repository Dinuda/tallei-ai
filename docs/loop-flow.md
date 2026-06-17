# Loop Flow: Builder → Run → Webhook

## Architecture Overview

The loop system has three layers plus Temporal orchestration:

```
loop-engine/       Design-time: specs, build contracts
loop-executor/     Lifecycle: workflow CRUD, verification, tool catalog
loop-runtime/      Execution: spec runner (loop_spec_v1)
                     └── spec-runner.ts     ← sole execution path
                     └── composio-trigger.ts ← webhook event triggers
src/temporal/      Orchestration: schedules + durable headless runs
                     └── workflows/loop-run.workflow.ts
                     └── activities/loop-run.activity.ts
                     └── schedules.ts
```

All new loops use the **spec-driven** engine (`loop_spec_v1`). Headless runs and cron schedules are executed by **self-hosted Temporal** when `TALLEI_TEMPORAL__ENABLED=true`. When Temporal is disabled, the API falls back to in-process fire-and-forget execution and the legacy 60s `spec-scheduler` poller.

| Trigger | Code path |
|---------|-----------|
| **Manual** | `startSpecManualLoopRun` → `createSpecLoopRun` → `startLoopRunWorkflow` |
| **Schedule** | Temporal Schedule (`upsertLoopSchedule` on activation) → `loopRunWorkflow` |
| **Webhook** | `handleComposioTriggerWebhook` → `createSpecLoopRun` → `startLoopRunWorkflow` |
| **Interactive chat** | `POST /loops/:id/run/chat` → `streamSpecRunChat` (not via Temporal) |

Developer visibility: dashboard **DEVELOPER → Workflows** (`/dashboard/developer/workflows`) reads `/api/developer/temporal/*`.

---

## 1. Builder Flow (Design → Activation)

The builder is an AI-guided wizard that walks users through designing, approving, verifying, and activating a loop workflow. The route handler is `src/transport/http/routes/loopBuilder.ts` mounted at `/api/loop-builder/*`.

### 1.1 Phase State Machine

A builder session progresses through these phases (defined in `sessions.ts`):

```
new ──► analyzing ──► resolving_requirements ──► intent_resolved
                              │                          │
                              │                          ▼
                              │                    spec_drafted
                              │                          │
                              │                          ▼
                              │                    spec_approved
                              │                          │
                              │                          ▼
                              │                     saved (verifying)
                              │                          │
                              │                          ▼
                              │                       (active)
                              │
                              ▼
                         (archived / failed)
```

### 1.2 Session Management

**File:** `src/services/loop-builder/sessions.ts`

Every builder session gets a Composio session (for tool discovery and OAuth) and a row in `workflow_builder_sessions`. Messages are stored in `workflow_builder_messages`.

Key exports:
- `createWorkflowBuilderSession` — new session with Composio session
- `updateWorkflowBuilderSession` — optimistic concurrency via `revision` counter
- `replaceWorkflowBuilderMessages` — atomic delete+reinsert of chat messages
- `phaseAfterRequirementsResolved` — phase transition helper

### 1.3 Intent Analysis & Tool Discovery

**Route:** `POST /api/loop-builder/chat` (main streaming chat)

The streaming chat runs an LLM loop with 14 MCP-style tools defined in `loopBuilder.ts:analyzerTools()`:

| Tool | Purpose |
|------|---------|
| `appSelection` | User selects a connector app (Gmail, HubSpot, etc.) |
| `getAvailableTools` | Discovers Composio actions for selected apps |
| `resolveBuildRequirement` | Resolves a connector/schedule/input requirement |
| `connectorSetup` | Opens OAuth flow for a connector |
| `scheduleSetup` | Sets cron schedule |
| `knowledgeBaseSetup` | Attaches knowledge bases |
| `artifactSetup` | Configures email templates |
| `requirementSetup` | Sets stable runtime inputs |
| `interactivePrompt` | UI-only clarification (choices, free text) |
| `draftSpec` | Generates the loop spec via LLM |
| `refineSpec` | Refines an existing spec |
| `approveSpec` | Approves the spec |
| `saveLoop` | Saves and creates the workflow |
| `runVerification` | Runs pre-activation checks |
| `confirmActivation` | Confirms verification and activates |

### 1.4 Dispatcher (Command Execution)

**File:** `src/services/loop-builder/dispatcher.ts`

All builder tools are executed asynchronously via a command queue (`workflow_builder_commands`). Commands are serialized per session using a promise chain.

Key exports:
- `dispatchWorkflowBuilderCommand` — enqueues a command, returns job ID
- `getWorkflowBuilderCommand` — polls command status/progress

Each command is wrapped in progress tracking via `runWithLoopBuilderProgress()`, which persists progress events and token usage to the DB.

### 1.5 Spec Generation

**File:** `src/services/loop-builder/specs.ts`

The LLM generates a `NoSlopSpec` — a behavioral specification capturing:
- Purpose, success criteria, guardrails, failure modes
- Agent roster (goals, done-when conditions)
- Delivery configuration (provider, target)
- Connector policies (allowed actions, risk levels)
- Schedule and input requirements

Key functions:
- `draftLoopSpec` — calls `generateSpecJson()` with OpenAI, retries up to 2 times
- `refineLoopSpec` — runs `generateSpecJson()` with feedback context
- `approveLoopSpec` — validates semantics, renders markdown, sets `approved`
- `hydrateLoopSpecJson` — parses and validates spec JSON against draft/approved schema

The spec is stored in the `loop_specs` table and carries a `NoSlopSpecSnapshot` when approved.

### 1.6 Build Contract

**File:** `src/services/loop-engine/build-contract.ts`

The build contract is a structured set of requirements that must be resolved before activation:

| Requirement kind | What it resolves |
|-----------------|------------------|
| `connector` | Which app accounts are connected |
| `trigger_schedule` | Cron or event trigger |
| `stable_input` | Fixed runtime parameters |
| `grounding` | Knowledge bases / Google Docs attached |
| `artifact_contract` | Email template bundle |
| `review_policy` | Pre-send approval gate |

Key exports:
- `deriveLoopBuildContract` — creates the contract from discovered tools + user selections
- `resolveBuildRequirement` — marks a requirement as resolved with chosen value
- `assertBuildContractReady` — throws if any required requirement is unresolved

### 1.7 Workflow Creation

**File:** `src/services/loop-builder/intent-resolver.ts`

When the user saves the loop:
1. `saveLoopFromSpec()` constructs a `RunnableSpec` bundle containing the approved spec snapshot, discovered tool contracts, build contract, and schedule
2. Calls `createLoopFromRunnableSpec()` in `loop-executor/creator.ts` which persists the workflow with `definition_version = 'loop_spec_v1'` and stores the `runnableSpec` in `metadata_json`

The workflow row carries:
- `status = 'active'`
- `definition_version = 'loop_spec_v1'`
- `metadata_json` with `{ runnSpec: RunnableSpec }`
- `schedule_rrule` and `next_run_at` if scheduled
- `workspace_id` if assigned

### 1.8 Verification

**File:** `src/services/loop-executor/verification.ts`

Before a loop runs, it must pass verification:
1. **Connector availability** — checks that selected connector accounts are connected
2. **Grounding probes** — verifies knowledge bases and workspace memory are accessible
3. **Dry-run probes** — executes safe read-only actions to validate payload/output schemas
4. **Trigger check** — registers Composio webhook triggers if event-driven

The verification record is stored in `workflow_verification_runs` with status `pending` → `running` → `failed` / `awaiting_confirmation` → `confirmed`.

---

## 2. Run Flow (Spec-Driven Execution)

### 2.1 Entry Points

A spec-driven loop run can be started from three entry points:

| Entry point | Code path | Source |
|-------------|-----------|--------|
| **Manual** (dashboard) | `startSpecManualLoopRun` → `createSpecLoopRun` → `startLoopRunWorkflow` | User clicks "Run" |
| **Schedule** (cron) | Temporal Schedule → `loopRunWorkflow` (or `spec-scheduler` fallback) | Cron / Temporal |
| **Webhook** (event) | `handleComposioTriggerWebhook` → `createSpecLoopRun` → `startLoopRunWorkflow` | External service event |

### 2.2 Run Lifecycle

A run goes through these statuses:

```
queued ──► running ──► succeeded
                │
                ├──► failed
                │
                ├──► waiting_for_approval
                │       │
                │       ▼
                │    (resumed → running)
                │
                └──► cancelled
```

### 2.3 Spec Runner (Core Executor)

**File:** `src/services/loop-runtime/spec-runner.ts`

**Headless execution path:**
1. `createSpecLoopRun` inserts a `loop_engine_runs` row with status `queued`, publishes `run_queued` event
2. A user message is injected: `"Execute the loop: {spec.goal}"`
3. `executeSpecRun` is called:
   - Sets status to `running`
   - Calls `buildSpecRunTools()` to create the tool registry
   - Calls `buildSpecRunSystemPrompt()` to assemble instructions
   - Creates `streamText()` with the AI SDK, bound to 12 max steps
   - In headless mode, silently consumes the stream
   - On completion, persists messages and sets status to `succeeded`

**Streaming (interactive) path:**
1. Route `POST /loops/:workflowId/run/chat` in `workflows.ts` receives `{ runId, messages }`
2. Calls `streamSpecRunChat()` which validates messages, persists them, then calls `executeSpecRun` in stream mode
3. The response is streamed back via `pipeUIMessageStreamToResponse`

**Retry path:**
1. `POST /runs/:runId/retry` resets status to `queued`, clears messages and errors
2. Fire-and-forget headless execution via `runSpecLoopHeadless`

### 2.4 Tools Available to the LLM

**File:** `src/services/loop-runtime/spec-run-tools.ts`

| Tool | Trigger | Executes |
|------|---------|----------|
| `searchMemory` | LLM on any turn | `runGroundedKnowledgeSearch` (Tallei memory + workspace memory) |
| `searchWeb` | LLM on any turn | `runExaWebSearch` (Exa public web search) |
| `finalizeRun` | LLM when goal achieved | Persists to workspace memory, marks run `succeeded` |
| `search_{toolkit}` | LLM per external toolkit | `runComposioToolkitPrompt` (HubSpot, Salesforce, etc.) |
| `action_{toolkit}_{action}` | LLM for write actions | `executeApprovedComposioAction` (needs user approval) |

The LLM is prompted with a system prompt built from the spec's agents, guardrails, success criteria, and delivery config.

### 2.5 Run Projection

**File:** `src/services/loop-runtime/spec-run-editorial-projection.ts`

The dashboard fetches runs via `getSpecRunEditorialProjection()` which returns a backward-compatible view mimicking the v2 runtime's multi-step format. It synthesizes:

- A single synthetic step (`spec_runner` agent)
- One final artifact (`final.result`)
- The run's event log
- An `operatorView` (null for spec runs; no human-in-loop interactions)

The raw API is:
- `GET /runs/:runId` → editorial projection (falls back to legacy projection for v2 runs)
- `GET /runs/:runId/messages` → raw chat message log
- `GET /loops/:workflowId/runs` → list of run projections (routes to `listSpecLoopRuns` or `listLoopRuntimeRuns` based on `definition_version`)
- `GET /loops/:workflowId/triggers` → trigger activity view

---

## 3. Webhook & Schedule Flow

### 3.1 Orchestration

When `TALLEI_TEMPORAL__ENABLED=true`:

- **Schedules:** `upsertLoopSchedule()` in `src/temporal/schedules.ts` on loop activation
- **Headless runs:** `startLoopRunWorkflow()` in `src/temporal/start-loop-run.ts`
- **Worker:** `npm run temporal:worker` (polls task queue `tallei-loops`)

When Temporal is disabled, `src/bootstrap/workers.ts` starts `startSpecLoopScheduler()` as a 60s fallback poller.

### 3.2 Schedule Flow (Temporal enabled)

1. On verification confirm, `confirmWorkflowVerification()` calls `upsertLoopSchedule()` with cron + timezone from the build contract.
2. Temporal Schedule ID: `loop-schedule:{tenantId}:{workflowId}`.
3. Each tick starts `loopRunWorkflow`, which creates a Postgres run (if needed) and executes `executeSpecRunHeadless` in an activity.

### 3.3 Schedule Flow (Temporal disabled fallback)

**File:** `src/services/loop-runtime/spec-scheduler.ts`

1. Every 60s, `tickSpecScheduledRuns()` queries due `loop_spec_v1` workflows.
2. For each due workflow: `createSpecLoopRun` + `runSpecLoopHeadless`.
   - Resolves auth via `resolveLoopRunAuth` (loads workspace context from workflow metadata)
   - Calls `createSpecLoopRun(auth, workflowId, { source: "schedule", label })`
   - Updates `last_scheduled_at` and `next_run_at` (via `nextCronRunAt`)
   - Fires `runSpecLoopHeadless(auth, workflowId, runId)` — fire-and-forget
3. On error, logs but does not crash the tick

### 3.4 Webhook / Event Flow

**File:** `src/services/loop-runtime/composio-trigger.ts`

1. External service fires a webhook to `POST /api/connectors/composio/webhook`
2. `handleComposioTriggerWebhook` validates the envelope, deduplicates, and resolves auth
3. `createSpecLoopRun` + `startLoopRunWorkflow` (Temporal or in-process fallback)

### 3.5 Composio Trigger Registration

When verification confirms an event-driven loop:
- A Composio trigger is registered via `registerComposioTrigger({ toolkit, triggerSlug })`
- The mapping `(trigger_instance_id, workflow_id)` is stored in `workflow_connector_triggers`
- Subsequent webhook events matching this trigger instance are routed to the workflow

---

## 4. Module Dependency Map

```
HTTP Routes
  │
  ├── /api/loop-builder/*  →  loop-builder/{dispatcher, sessions, specs, intent-resolver}
  │                              ├── loop-engine/{build-contract, spec-contracts}
  │                              └── loop-executor/{creator, verification, cron}
  │
  ├── /api/workflows/*      →  loop-runtime/{spec-runner, composio-trigger}
  │                              └── temporal/{start-loop-run, schedules}
  │
  ├── /api/developer/temporal/* → Temporal visibility (running, schedules, history)
  │
  └── workers               →  spec-scheduler (fallback when Temporal disabled)
```

---

## 5. Key Files Reference

| Path | Purpose |
|------|---------|
| `src/temporal/worker.ts` | Temporal worker entry |
| `src/temporal/workflows/loop-run.workflow.ts` | Durable loop run workflow |
| `src/temporal/activities/loop-run.activity.ts` | Headless spec execution activity |
| `src/temporal/schedules.ts` | Schedule upsert/delete |
| `src/services/loop-runtime/spec-runner.ts` | Core spec-driven execution |
| `src/services/loop-runtime/composio-trigger.ts` | Webhook event handling |
| `src/services/loop-runtime/spec-scheduler.ts` | Fallback cron poller |
| `src/transport/http/routes/developerTemporal.ts` | Developer visibility API |
| `dashboard/app/dashboard/developer/workflows/page.tsx` | Developer Workflows UI |
