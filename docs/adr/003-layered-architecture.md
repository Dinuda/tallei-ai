# ADR-003 — Layered architecture + dependency rules

**Status**: Accepted  
**Date**: 2026-04-18

## Context

`src/services/memory.ts` (1015 lines at peak) mixed quota enforcement, caching logic, OpenAI calls, Qdrant writes, Redis cache invalidation, shadow-read diffing, dual-write orchestration, and HTTP-level error formatting in a single module. Changes to any one concern required reading the whole file. There were no enforced boundaries preventing new code from repeating this pattern.

## Decision

The codebase is re-layered into a strict DAG:

```
transport → orchestration → providers / infrastructure → domain
           ↘                                            ↗
             resilience, observability, config, shared
```

**Dependency rules** (enforced by `eslint-plugin-boundaries` + `dependency-cruiser`):

| Layer | May import |
|---|---|
| `domain` | `shared` only — no I/O, no Node built-ins |
| `shared` | nothing |
| `config` | `shared` |
| `resilience` | `shared`, `observability` |
| `observability` | `shared`, `config` |
| `providers/ai` | `resilience`, `shared`, `observability`, `config` |
| `infrastructure` | `domain` (types only), `resilience`, `shared`, `observability`, `config` |
| `orchestration` | `domain`, `providers`, `infrastructure`, `resilience`, `shared`, `observability`, `config` |
| `transport` | `orchestration`, `domain`, `shared`, `observability`, `config`, `resilience` |
| `bootstrap` | Everything — sole wiring point |

Module-level singletons are banned outside `bootstrap/composition-root.ts`. All services are constructor-injected.

## Consequences

- `memory.ts` collapses from 1015 lines to 63 lines (a thin feature-flagged routing barrel).
- Each use case is a class with an explicit `Deps` interface — fully testable with stub deps, no mocking frameworks needed.
- `npm run deps:check` (madge) and `npm run deps:rules` (dependency-cruiser) enforce the rules in CI. A new violation is a build failure.
- The folder tree is described exactly in `docs/architecture.md`.
