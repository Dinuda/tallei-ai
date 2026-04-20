# Documentation

## Core Architecture & Design

Start here to understand the system:

- **[Technical Architecture](../ARCHITECTURE.md)** — Deep dive into the graph-aware memory system, async extraction pipeline, dual recall modes, and performance optimizations
- **[Architecture Diagrams](./DIAGRAMS.md)** — Visual walkthroughs of the system with ASCII diagrams:
  - High-level architecture
  - Fire-and-forget save flow
  - Dual recall modes (vector + graph)
  - Contradiction detection
  - Entity relationship graphs
  - Database schema

## Memory Model Update (April 2026)

- Memory records are now typed (`preference`, `fact`, `event`, `decision`, `note`) with pinning and supersede support.
- Recall is preference-first and type-aware (decay + similarity floor + context dedup).
- New MCP preference tools:
  - `save_preference`
  - `list_preferences`
  - `forget_preference`
- `recall_memories` now supports optional type filters via `types`.
- ChatGPT Actions importer URL:
  - `/chatgpt/actions/openapi.json`

## Deployment & Operations

- Production deployment:
  - [Cloud Run Guide](./production/cloudrun/README.md)
  - [Flow (Step-by-step)](./production/cloudrun/flow.md)
  - [Domains and DNS](./production/cloudrun/dns.md)
  - [Troubleshooting](./production/cloudrun/troubleshooting.md)
  - [Production Changelog](./production/cloudrun/changelog.md)

## Getting Started

- Local development:
  - [Local Setup](../setup.md)
