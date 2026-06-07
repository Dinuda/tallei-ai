# Stable Loop Runtime

## Scope

`loop_engine_v3` is the only executable loop definition. The first stable runtime supports:

- manual runs;
- sequential architect-generated agent graphs;
- dashboard-only input, review, and memory-confirmation gates;
- versioned reviewed artifacts;
- bounded retries and lease recovery.

It does not support scheduling, presets, email approval, contact uploads, outbound delivery,
dynamic plans, or UI-driven progression.

## Source Of Truth

Execution state lives only in the durable runtime tables:

| Table | Responsibility |
|---|---|
| `loop_engine_runs` | Authoritative run status, definition snapshot, context, and current step |
| `loop_engine_step_attempts` | Immutable execution and retry attempts |
| `loop_engine_commands` | Durable idempotent work queue with leases and delayed retries |
| `loop_engine_gates` | Human decisions bound to a specific step attempt |
| `loop_engine_artifacts` | Versioned structured outputs |
| `loop_engine_events` | Append-only audit timeline, never execution state |

The dashboard, artifacts, comments, and events cannot advance a run.

## Manual Run Flow

```text
POST /loops/:workflowId/runs
  -> validate the saved loop_engine_v3 definition
  -> snapshot the definition and create a queued run
  -> enqueue idempotent start_run command

worker claims start_run
  -> create first immutable step attempt
  -> enqueue execute_step

worker claims execute_step
  -> lease the attempt
  -> execute stable tools and agent
  -> evaluate the result
  -> persist artifact
  -> create gate, queue retry, queue next step, or queue finalize_run

worker claims finalize_run
  -> verify no pending gate exists
  -> mark run succeeded
```

Only the server worker claims and processes commands. Claims use row locks with
`FOR UPDATE SKIP LOCKED`, a lease owner, and a lease expiry. Expired command and attempt
leases are reclaimed before new work is dispatched.

## Gates

The dashboard can submit only explicit authenticated decisions:

```http
POST /runs/:runId/gates/:gateId/approve
POST /runs/:runId/gates/:gateId/input
POST /runs/:runId/gates/:gateId/reject
```

Approving or submitting input records the gate decision and enqueues exactly one
`continue_after_gate` command using a unique idempotency key. Repeated submissions return
the existing decision.

An input gate creates a new attempt for the paused step. A review or memory-confirmation
gate completes the paused attempt and advances to the next step. Rejection blocks the run
until an operator explicitly retries the failed step.

## Retries And Recovery

- Every retry is a new immutable step attempt.
- Attempt identity is unique by `(run_id, step_index, attempt)`.
- Command identity is unique by `idempotency_key`.
- Transient command failures are delayed and bounded.
- Expired command leases return to `pending`.
- Expired running attempt leases return to `queued`.
- Retrying an operator-blocked step invalidates downstream artifacts and cancels stale
  downstream attempts.
- Cancelling a run cancels pending commands and active attempts.

## API Projection

```http
GET /runs/:runId
```

This returns the authoritative run projection with attempts, gates, artifacts, and events.
The dashboard may poll this endpoint, but polling never mutates execution state.

## Key Files

| File | Responsibility |
|---|---|
| `src/services/loop-runtime/runtime.ts` | Run creation, command worker, gates, retries, leases, and projection |
| `src/services/loop-runtime/types.ts` | Strict stable-runtime definition validation |
| `src/services/loop-runtime/memory.ts` | Run-context and gate-decision memory handling |
| `src/services/loop-runtime/tool-registrations.ts` | Stable tool handlers |
| `src/infrastructure/db/index.ts` | Durable runtime schema and hard-cutover initialization |
| `src/transport/http/routes/workflows.ts` | Small command-oriented HTTP API |
| `src/bootstrap/workers.ts` | Stable runtime worker lifecycle |
| `dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/page.tsx` | Read-only projection viewer and explicit operator actions |

## Legacy Cutover

At startup, non-v3 workflows are archived and their active legacy runs are cancelled.
The old runtime workers, progression routes, approval links, delivery handlers, presets,
newsletter UI, and dashboard auto-resume behavior have been removed.
