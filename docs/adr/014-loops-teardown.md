# ADR-014: Conductor / Loops Teardown

**Status:** Accepted  
**Date:** 2026-07-10

## Context

Tallei had grown a large automation surface: Conductor (loop authoring chat), Loops engine, Temporal scheduling, Composio connectors, workspace KB, and loop-miner suggestions. This competed with the core product — fast, accurate cross-AI memory — for maintenance and operational complexity.

## Decision

Strip Conductor, Loops, Temporal, Composio, browser automation, and related packages/tables/env from the repo. Keep memory/MCP, model gateway, resilience, and reusable dashboard UI (`ai-elements/`, `ui/`).

### Deleted

- `src/loops/`, `src/temporal/`, `src/integrations/composio/`, `src/integrations/connectors/`
- Conductor services, workspace memory, knowledge-base stubs, web-search, planner/orchestrator
- HTTP routes: loops, approvals, workspaces, connectors, knowledge-bases, workspace-memory, composio webhooks
- Packages: `conductor-tools`, `tallei-tools`, `composio-tools`, `shared`
- Dashboard: loops pages, conductor components, API proxies, loop marketing
- Deploy/docs: Temporal workers, loop Cloudflare workers, conductor/loop docs

### Kept

- `src/model/`, `src/resilience/` — trimmed to `chat` / `embed` purposes only
- `packages/mcp-tools/`
- `src/orchestration/memory/`, memory cleanup
- `dashboard/src/components/ai-elements/`, `ui/`
- Ingest job workers (ChatGPT import, upload ingest, Vertex backfill)

## Consequences

### Positive

- Smaller dependency graph (no `@temporalio/*`, `@composio/*`)
- Single workspace package (`mcp-tools`)
- Documentation and onboarding align with memory-core product
- Boot drops legacy loop tables via `REMOVED_AUTOMATION_TABLES`

### Negative

- No loop authoring, scheduling, or connector execution in-repo; see [ADR-015](./015-execution-engine-boundary.md) for the future engine boundary
- Production deployments must not expect `/api/loops` or Temporal worker

### Follow-up (out of scope for this ADR)

- Execution engine for operator schedules — [ADR-015](./015-execution-engine-boundary.md)
- Skill-based operator UI on top of `ai-elements` + model gateway

## References

- [Product scope](../product-scope.md)
- [ADR-012: Remove graph layer](./012-remove-graph-layer.md)
- Teardown implementation plan (July 2026)
