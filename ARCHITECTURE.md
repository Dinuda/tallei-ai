# Tallei Architecture

Tallei is a cross-AI ghost memory service: OAuth-gated MCP tools for save/recall, a Next.js dashboard, PostgreSQL + Qdrant for storage, and a model gateway for chat/embed workloads.

**Canonical architecture doc:** [docs/architecture.md](docs/architecture.md)

That document covers:

- Layer diagram (`transport` → `orchestration` → `infrastructure` → `providers` / `model` / `resilience`)
- MCP `save_memory` and `recall_memories` request flows (three-bucket recall)
- Provider adapter seam and resilience policy matrix
- Frozen public contract (MCP tool names, HTTP routes)

## Related docs

- [Product scope](docs/product-scope.md) — what is in/out of the repo today
- [ADR index](docs/README.md#architecture-decision-records) — design decisions including [ADR-012 graph removal](docs/adr/012-remove-graph-layer.md), [ADR-013 collab removal](docs/adr/013-remove-collab-and-developer-workflows.md), and [ADR-014 loops teardown](docs/adr/014-loops-teardown.md)
- [Three-bucket recall](docs/adr/011-three-bucket-recall.md) — recall latency and accuracy trade-offs

## Quick reference

| Concern | Location |
|---------|----------|
| HTTP routes | `src/transport/http/routes/` |
| MCP server | `src/transport/mcp/server.ts` |
| Memory orchestration | `src/orchestration/memory/` |
| Model gateway | `src/model/` |
| Resilience policies | `src/resilience/` |
| Config | `src/config/load.ts` |
| Dashboard | `dashboard/` |

For local development, see [setup.md](setup.md).
