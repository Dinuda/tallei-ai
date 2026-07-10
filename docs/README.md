# Documentation

Start here to understand Tallei after the memory-core refactor.

## Product & Architecture

- **[Product Scope](./product-scope.md)** — what ships today vs what was removed
- **[Technical Architecture](./architecture.md)** — layered backend, MCP save/recall flows, model gateway, frozen contracts
- **[Current Memory Retrieval](./memory-retrieval-current.md)** — `list_memories` vs `recall_memories`, bucket recall tuning

## Runtime Flows

- **[Flows index](./flows/README.md)** — end-to-end operational paths
- [Memory Cleanup](./flows/memory-cleanup-end-to-end.md)
- [Vertex Document Embeddings](./flows/vertex-document-embeddings.md)

## Architecture Decision Records

| ADR | Topic |
|-----|-------|
| [001](./adr/001-provider-adapter-interface.md) | Provider adapter interface |
| [002](./adr/002-single-provider-resilience.md) | Single-provider resilience |
| [003](./adr/003-layered-architecture.md) | Layered architecture |
| [004](./adr/004-remove-legacymemory.md) | Remove LegacyMemory |
| [005](./adr/005-config-schema-zod.md) | Config schema (Zod) |
| [006](./adr/006-structured-logging-metrics.md) | Structured logging & metrics |
| [007](./adr/007-feature-flagged-shadow-cutover.md) | Feature-flagged shadow cutover |
| [008](./adr/008-frozen-http-mcp-contract.md) | Frozen HTTP/MCP contract |
| [009](./adr/009-composition-root.md) | Composition root |
| [010](./adr/010-embedding-cache-in-infrastructure.md) | Embedding cache in infrastructure |
| [011](./adr/011-three-bucket-recall.md) | Three-bucket recall |
| [012](./adr/012-remove-graph-layer.md) | Remove graph layer |
| [013](./adr/013-remove-collab-and-developer-workflows.md) | Remove collab and developer workflows |
| [014](./adr/014-loops-teardown.md) | Conductor / Loops teardown |
| [015](./adr/015-execution-engine-boundary.md) | Execution engine boundary |

## Deployment & Operations

- [Cloud Run Guide](./production/cloudrun/README.md)
- [Flow (step-by-step)](./production/cloudrun/flow.md)
- [Domains and DNS](./production/cloudrun/dns.md)
- [Troubleshooting](./production/cloudrun/troubleshooting.md)
- [Production Changelog](./production/cloudrun/changelog.md)

## Getting Started

- [Local Setup](../setup.md)
- [Root README](../README.md)
