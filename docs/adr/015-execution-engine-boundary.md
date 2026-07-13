# ADR-015: Execution Engine Boundary

**Status:** Accepted (partially superseded)  
**Date:** 2026-07-10  
**Update:** The “execution engine TBD” portion is superseded by [ADR-016](016-work-execution-engine.md) for Tallei Work. Control-plane ownership in this ADR remains in force.

## Context

Tallei removed in-app loop scheduling (Temporal, Cloudflare wake workers, `tallei-tools` cron helpers, Composio connector execution). The product is repositioning toward a **sovereign AI workforce control plane**: memory, documents, MCP, model routing, and audit — with operator execution owned by a separate engine later.

## Decision

### Tallei control plane owns

- Encrypted memory and documents (Postgres/pgvector, Qdrant)
- MCP tools and OAuth (`/mcp`, `/api/memories`, `/api/documents`)
- Model gateway (`chat` / `embed` across OpenAI, Anthropic, Google, Ollama, OpenCode, NVIDIA)
- MCP activity logging (`/api/mcp/events`)
- Billing and dashboard setup for AI assistants (manual MCP copy-paste)

### Ingest async jobs (not operator scheduling)

Postgres-polled workers remain in-process for foundation data pipelines only:

- ChatGPT import (`src/services/chatgpt-import/`)
- Uploaded file ingest (`src/services/uploaded-file-ingest-jobs.ts`)
- Vertex document backfill (`src/services/vertex-document-backfill.ts`)

These use `setInterval` polling via `src/bootstrap/workers.ts`. They are **not** the workforce scheduler.

### Future execution engine owns

- Operator run lifecycle (start, retry, cancel, durable state)
- Cron and event-trigger schedules for operators
- Human-in-the-loop approvals for operator actions
- Cross-step tool orchestration beyond a single MCP turn

Tallei will expose APIs and audit hooks for the engine to call; the engine implementation (Temporal, custom, or other) is **TBD**.

### Explicitly not in Tallei

- In-app cron for operators
- Cloudflare loop scheduler / heartbeat workers
- Composio connector platform
- Browser automation for Claude onboarding
- Temporal worker in this repo

## Consequences

- Deployments are simpler: backend + dashboard on Cloud Run, no Temporal worker
- Scheduling claims in marketing must refer to the future engine, not current code
- Operator UI and tables are a follow-up project on top of this boundary

## References

- [ADR-014: Conductor / Loops teardown](./014-loops-teardown.md)
- [ADR-013: Remove collab and developer workflows](./013-remove-collab-and-developer-workflows.md)
