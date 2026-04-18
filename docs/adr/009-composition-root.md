# ADR-009 — Composition root as sole wiring location

**Status**: Accepted  
**Date**: 2026-04-18

## Context

The original codebase constructed service instances at module scope:

```typescript
// src/services/llmClient.ts  (old)
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// src/services/summarizer.ts  (old)
import { openai } from "./llmClient.js";
// ... uses openai directly
```

This pattern has several problems:
1. **Untestable without mocking the module.** There is no injection point — tests must either mock the whole `llmClient` module (fragile, Jest-specific) or actually call OpenAI.
2. **Config read at import time.** If the module is imported before env vars are loaded, the OpenAI client is constructed with `undefined` as the API key.
3. **Hidden coupling.** Any module can import `openai` from `llmClient.ts`, making dependencies invisible in the type system.
4. **Circular dependency risk.** Module-level singletons that import from each other create evaluation order issues.

## Decision

All service instances are constructed exactly once, in `src/bootstrap/composition-root.ts`. The function `buildContainer(config: Config): AppServices` is the sole location that wires dependencies together.

Rules:
- No `new ServiceClass()` outside `src/bootstrap/`.
- Services receive their dependencies as constructor arguments typed by an interface (the `Deps` pattern used in every use case class).
- Config is passed into `buildContainer` — it is never read from `process.env` inside a service.
- `src/bootstrap/container.ts` holds the typed `AppServices` shape so the Express app and MCP server receive only what they need (not the whole container).

## Consequences

- Every use case is testable by passing a stub `Deps` object — no mocking frameworks required.
- `eslint-plugin-boundaries` bans imports from `bootstrap/` outside of `src/index.ts` and `src/patch.ts`.
- Module-level `new OpenAI()` is a lint error outside `src/providers/ai/`.
- Cold-start time is unchanged — construction is O(1) objects, not O(connections).
- The container is hand-rolled (no DI framework). The `AppServices` interface documents every top-level dependency explicitly.
