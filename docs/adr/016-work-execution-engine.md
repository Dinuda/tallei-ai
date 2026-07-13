# ADR-016: Work Execution Engine

**Status:** Proposed (Stage 0)  
**Date:** 2026-07-13  
**Supersedes:** the “execution engine TBD” decision in [ADR-015](015-execution-engine-boundary.md)  
**Does not supersede:** ADR-015’s control-plane ownership of memory, documents, MCP, model gateway, and frozen contracts

## Context

ADR-015 correctly split Tallei into a **control plane** (memory, documents, MCP, routing, audit) and a future **execution engine** for durable operator/agent runs. The engine implementation was left TBD after Temporal and Conductor were removed.

Tallei Work requires:

- Multi-step model/tool loops that survive process restarts
- Pause, resume, steer, cancel, and human approval waits
- At-least-once job delivery with tool idempotency
- A self-hostable stack that defaults to PostgreSQL
- No reintroduction of Temporal into this repository for Work MVP

## Decision

### Work execution engine = PostgreSQL + pg-boss + dedicated worker process

| Concern | Choice |
|---|---|
| Queue / leases / retries | **pg-boss** on the same PostgreSQL database |
| Run canonical history | Append-only `run_events` in PostgreSQL |
| Process split | `api` (enqueue, SSE, authz) + `worker` (execute) |
| Scheduler / cron | **Out of Work MVP**; add later as a separate track on the same queue |
| Temporal | **Not required** for Work MVP; may be reconsidered only if pg-boss proves insufficient for hosted scale |

### Control plane still owns

Unchanged from ADR-015:

- Encrypted memory and documents
- MCP tools and OAuth
- Model gateway and resilience policies
- Billing and frozen HTTP/MCP contracts

Work adds additive `/api/v1` APIs and Work tables; it does not replace the memory product.

### Ingest workers remain separate

ChatGPT import, uploaded-file ingest, and related `setInterval` pollers in `src/bootstrap/workers.ts` stay foundation data pipelines. They are **not** the Work agent runtime. Over time they may migrate onto pg-boss for ops consistency, but that is not a Work MVP blocker.

### Explicitly not in Work MVP

- Temporal worker in this repo
- Cloudflare wake schedulers
- Composio / connector platform
- Browser automation / desktop computer use
- Full artifact export suites (docs/sheets/slides/Sites)

## Consequences

### Positive

- One database to operate for self-host (Postgres)
- Resumability is an application property (`run_events`), not hidden in an external workflow engine
- Feature flag `work.agent_runtime` can disable enqueue/worker without affecting memory/MCP
- Matches open-source “run on your laptop” story with Ollama + Postgres

### Negative / risks

- Team must implement the agent state machine carefully (leases, idempotency, approval waits)
- pg-boss is weaker than Temporal for extremely complex workflow graphs — acceptable because Work is conversation/agent oriented, not a BPM engine
- SSE fan-out may need Redis later under load; start with Postgres polling + in-process fan-out

### Operational rule

Marketing and docs may describe **durable Work runs** once Stage 3 (runtime) is approved. Until then, scheduling and long-running agent claims must not imply production readiness.

## References

- [Tallei Work architecture (Stage 0)](../tallei-work-architecture.md)
- [ADR-015: Execution engine boundary](015-execution-engine-boundary.md)
- [ADR-014: Loops teardown](014-loops-teardown.md)
- [ChatGPT-like Work research note](../chatgpt-work-architecture.md)
