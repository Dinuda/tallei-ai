# Services Contributor Guide

Application services called from HTTP routes, MCP tools, and orchestration use cases.

## High-traffic modules

| Module | Role |
|--------|------|
| `memory.ts` | Save/recall facade; caching; fire-and-forget saves |
| `memory-cleanup.ts` | Admin cleanup pipeline orchestration |
| `documents.ts` | Document notes, blobs, search |

## Service packages

| Directory | Role |
|-----------|------|
| `chatgpt-import/` | ChatGPT export import jobs and artifact storage |
| `notifications/` | Email templates and outbound delivery |

## Top-level files

- `uploaded-file-ingest.ts` / `uploaded-file-ingest-jobs.ts` — file ingest from ChatGPT/OpenAI refs
- `chatgpt-import-jobs.ts` — bulk import job runner
- `vertex-document-backfill.ts` — Vertex document embedding backfill

## Editing rules

- Keep exported service APIs stable unless route/MCP contracts change.
- Split growing modules under `src/services/<name>/` by responsibility.
- Route handlers stay thin — call one service or use-case function per action.
- Do not reintroduce loop/conductor/composio/collab service layers; see [ADR-014](../../docs/adr/014-loops-teardown.md).

## Related docs

- Orchestration use cases: `src/orchestration/memory/`
- Infrastructure repos: `src/infrastructure/repositories/`
- [Architecture](../../docs/architecture.md)
