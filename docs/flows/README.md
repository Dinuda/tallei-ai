# Runtime Flows

This section documents the operational flows that are easiest to lose track of when the code gets large.

Use these pages when you want the full end-to-end path, not just a module summary.

## Core Flows

- [Loop Miner End-to-End](./loop-miner-end-to-end.md)
- [Memory Cleanup End-to-End](./memory-cleanup-end-to-end.md)
- [Vertex Document Embeddings and Search](./vertex-document-embeddings.md)

## Mermaid Sources

- Standalone `.mmd` files live in [docs/flows/diagrams](./diagrams/README.md)
- Render SVGs with `npm run docs:render`

## Reading Order

1. Start with the flow page for the feature you are changing.
2. Jump from the flow page into the code map at the bottom.
3. Use the architecture docs for the broader layering and dependency rules.

## Related References

- [Architecture Overview](../architecture.md)
- [System Diagrams](../DIAGRAMS.md)
- [Loop Miner Architecture](../loop-miner-architecture.md)
- [Backend Core Simplification](../backend-core-simplification.md)
