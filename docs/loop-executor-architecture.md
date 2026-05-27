# Loop Executor Architecture

## Overview

The loop-executor turns a saved loop definition into a Paperclip-style multi-agent run:

- a CEO agent produces the strategy
- IC agents execute in sequence as discrete heartbeats
- each agent writes into a shared task/comment thread
- the run is event-driven and stateful in PostgreSQL
- loops can be grouped into workspaces for operator organization

This document describes the current implementation, not an aspirational design. The code already implements the CEO/IC split, the checkout + comments protocol, the scheduler, and workspace grouping.

## What This Architecture Is

The executor is a small workflow runtime built on top of:

- `workflows` rows as loop definitions
- `workflow_runs` rows as run instances
- `loop_run_tasks` rows as ordered agent checkpoints
- `loop_run_comments` as the shared communication log
- `loop_run_events` as the event stream for observability and debugging

The system is intentionally linear:

1. create or load a workflow definition
2. start a run
3. generate the CEO strategy
4. wait for human approval
5. execute IC agents one at a time
6. synthesize the final output
7. optionally wait for final approval

## Core Concepts

### CEO

The CEO is the coordinator, not a worker. It is responsible for:

- interpreting the loop goal
- ordering the agent tasks
- defining handoff expectations
- preserving approval constraints
- synthesizing the final result from the thread

The CEO never directly performs the specialist work.

### IC Agents

IC agents are dynamically spawned per run. They are **not** fixed roles like "Topic Researcher" baked into the loop definition.

Each run gets a CEO-proposed roster stored on the run:

- `metadata_json.loop_executor.proposedRoster`
- optional `approvedRoster` after operator edits

Each agent has:

- an `id`
- a display `name`
- a `task`
- zero or more tools from the loop tool catalog

Initial catalog entries:

| Tool ref | Purpose |
|----------|---------|
| `internal.llm_only` | Pure LLM completion |
| `internal.memory_search` | Vector memory recall |
| `composio.gmail.create_draft` | Approval-gated Gmail draft prep |
| `composio.gmail.send_email` | Approval-gated Gmail send |

See [tool-catalog.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/tool-catalog.ts).

### Heartbeats

CEO and IC execution are represented as discrete heartbeats:

- `runCeoStrategyHeartbeat()` creates the strategy and proposed roster (no tasks yet)
- operator approves/edits roster, then tasks are materialized
- `runAgentHeartbeat()` checks out one task, executes it, writes the result, and triggers the next step
- `runCeoFinalizeHeartbeat()` gathers the thread and closes the run

Heartbeats are dispatched through durable `loop_heartbeat_jobs` rows (internal poll worker or Cloudflare wake proxy).

## Definition Model

Loop definitions are versioned with `loop_executor_v2`.

The canonical definition shape includes:

- `goal`
- `schedule.cron`
- `schedule.timezone`
- `schedulerTarget` (`internal` or `cloudflare`)
- `allowedIntegrations`
- optional `allowedToolRefs`
- `ceo`
- `draftPolicy`

Agent rosters are **not** stored on the workflow. They are proposed fresh each run by the CEO and edited on the run detail page before strategy approval.

See:

- [types.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/types.ts)
- [creator.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/creator.ts)

### Tool catalog and policy

Tools are catalog entries, not job titles. Each agent binds 0–N catalog refs.

Validation rules:

- unknown refs are rejected
- integrations must be allowed on the loop definition
- missing connectors produce warnings during roster edit, but block agent execution
- external tools respect `draftPolicy.requireDraftBeforeExternalAction`

## Execution Protocol

### 1. Workflow creation

Loop creation happens through the internal loop creator surface and writes a workflow row with:

- a generated title
- a deterministic fingerprint
- the serialized loop definition in `metadata_json.loopDefinition`
- the schedule in `schedule_rrule`
- the first `next_run_at`

If the natural-language parser succeeds, the loop may get inferred `allowedIntegrations` and `allowedToolRefs`. The CEO still proposes the actual agent roster on every run.

### 2. Run creation

Starting a run inserts a `workflow_runs` row with:

- `status = running`
- `run_mode = manual | scheduled`
- `scheduled_for` if the run is scheduled
- executor metadata in `metadata_json`

### 3. CEO strategy heartbeat

`runCeoStrategyHeartbeat()` does three things:

1. builds a structured strategy + agent roster using the CEO prompt and tool catalog
2. stores `proposedRoster` on the run metadata (does **not** insert tasks yet)
3. transitions the run to `waiting_for_strategy_approval`

It also stores:

- the strategy text in `workflow_runs.strategy_output`
- a CEO comment in `loop_run_comments`
- a `ceo_strategy_ready` event in `loop_run_events`

### 4. Strategy approval and roster editing

While waiting for strategy approval:

- `GET /api/workflows/runs/:runId/roster`
- `PUT /api/workflows/runs/:runId/roster`

The operator approves the strategy with:

- `POST /api/workflows/runs/:runId/approve-strategy`
- optional JSON body `{ roster: [...] }`

Approval materializes `loop_run_tasks` rows from the approved roster and enqueues the first agent heartbeat.

### 5. Agent checkout + comments protocol

IC agents do not write directly into a shared blob. They follow a checkout protocol:

- the task must be `todo`
- the run must be `strategy_approved` or `running`
- the task is locked with `FOR UPDATE SKIP LOCKED`
- the task transitions to `in_progress`
- the agent reads the current comment thread
- the agent writes its output as a new comment
- the agent writes structured output to `loop_run_tasks.output_json`
- the task transitions to `done`
- an `agent_completed` event is emitted

This is the core collaboration protocol.

### 6. Sequential chaining

After one agent finishes:

- if a next task exists, the executor immediately fires the next agent heartbeat
- if there is no next task, the CEO finalizer runs

This makes the run deterministic and auditable. The sequence is driven by task order, not by arbitrary model decisions.

### 7. Finalization

`runCeoFinalizeHeartbeat()`:

- checks for blocked tasks
- synthesizes the final output from the full comment thread
- inspects whether any draft payloads were produced
- updates the run to `waiting_for_approval` or `completed`
- writes a final CEO comment
- emits a `ceo_finalized` event

If a draft was produced and the draft policy requires approval, the run stops at `waiting_for_approval`.

## Event-Driven State Model

The execution is event-driven in two ways:

1. state changes are persisted as rows and events
2. the next step is triggered from the current step rather than by a separate central coordinator loop

The event stream is stored in `loop_run_events`. The comment thread is the human-readable audit trail. The task table is the checkpoint state.

Important events include:

- `workflow.started`
- `ceo_strategy_ready`
- `strategy_approved`
- `agent_checked_out`
- `agent_completed`
- `ceo_finalized`
- `run_blocked`

## Workspace Model

Workspaces are lightweight organizational groupings for loops.

### What a workspace is

A workspace is a user- and tenant-scoped container for grouping related loops.

### What it is not

It is not an execution queue, not a tenancy boundary, and not a separate permission system.

### Data model

- `loop_workspaces` stores the workspace record
- `workflows.workspace_id` points at the workspace
- `ON DELETE SET NULL` preserves loops if the workspace is removed

### API surface

- `GET /api/workflows/workspaces`
- `POST /api/workflows/workspaces`
- `POST /api/workflows/workspaces/assign-loop`

See:

- [workspace.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/workspace.ts)
- [routes/workflows.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/transport/http/routes/workflows.ts)

## Scheduling

The executor supports two scheduling modes:

- `internal` scheduler: the Node worker polls for due workflows
- `cloudflare` scheduler: a Cloudflare cron wakes the backend endpoint

Both paths resolve to the same dispatch function: `dispatchDueLoopWorkflows()`.

### Internal scheduler

The internal scheduler:

- polls on `TALLEI_LOOP_EXECUTOR__POLL_MS`
- claims due workflows with `FOR UPDATE SKIP LOCKED`
- computes and stores the next run time
- dispatches the run

### Cloudflare scheduler

The Cloudflare worker simply POSTs to the backend wake endpoint. It does not execute the loops itself.

See:

- [scheduler.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/scheduler.ts)
- [loop-scheduler-worker.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/deploy/cloudflare/loop-scheduler-worker.ts)
- [config/load.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/config/load.ts)

## Public Surfaces

The UI already exposes the loop architecture in three places:

- the internal loop creator
- the newsletter loop bootstrap page
- the run detail page with agent rows and chat steering

The run detail page is intentionally opinionated:

- top-level artifact panel
- CEO status
- agent list
- action banner for approval or skip
- chat drawer for operator steering

See:

- [dashboard/app/dashboard/workflows/internal-loops/page.tsx](/Users/dinudayaggahavita/Documents/work/tallei-ai/dashboard/app/dashboard/workflows/internal-loops/page.tsx)
- [dashboard/app/dashboard/loops/newsletter/page.tsx](/Users/dinudayaggahavita/Documents/work/tallei-ai/dashboard/app/dashboard/loops/newsletter/page.tsx)
- [dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/page.tsx](/Users/dinudayaggahavita/Documents/work/tallei-ai/dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/page.tsx)

## What Is Implemented

Implemented now:

- CEO strategy generation with per-run dynamic roster
- tool catalog with internal + Composio Gmail entries
- roster editor on run detail page
- task materialization on strategy approval
- ordered IC execution via `agent_spec` + `assigned_tools`
- checkout + lock protocol
- comments as the shared execution thread
- event log per run
- sequential heartbeat chaining
- strategy approval gate
- final approval gate
- internal scheduler
- Cloudflare wake proxy
- workspace grouping
- run/task/comment read APIs
- admin-facing loop creator UI

## What Is Still Missing

Not implemented yet:

- a durable queue or external task broker
- concurrent IC execution
- real external publish/send actions
- autonomous recovery for blocked runs
- cross-workspace execution policy
- deeper event replay tooling
- a dedicated “restart from checkpoint” mechanism for stale runs

## Design Constraints

The current architecture intentionally keeps the loop executor simple:

- tools are assigned per agent from a catalog, not hardcoded roles
- one agent finishes before the next begins
- all important state is persisted
- approval is explicit
- external actions are draft-only unless a human approves

This keeps the system auditable and makes it safe to expose through the dashboard.

## Code Map

- [types.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/types.ts)
- [creator.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/creator.ts)
- [executor.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/executor.ts)
- [tool-catalog.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/tool-catalog.ts)
- [integration-registry.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/integration-registry.ts)
- [scheduler.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/scheduler.ts)
- [workspace.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/services/loop-executor/workspace.ts)
- [routes/workflows.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/transport/http/routes/workflows.ts)
- [db/index.ts](/Users/dinudayaggahavita/Documents/work/tallei-ai/src/infrastructure/db/index.ts)

