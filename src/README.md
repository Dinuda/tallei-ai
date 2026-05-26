# Backend Layout Convention

This repo is in a staged simplification. Existing folders remain valid, but new backend code should follow this convention:

- `src/feature/*`: domain flows and use cases (business behavior)
- `src/adapters/*`: external systems (DB, providers, webhooks, infra boundaries)
- `src/app/*`: orchestration/wiring between feature and adapters

During migration, current folders (`services`, `orchestration`, `infrastructure`, `transport`) are still authoritative. Prefer adding small modules and compatibility re-exports instead of large rewrites.

## Naming convention (current)

- Behavior modules: `*.usecase.ts`
- Persistence modules: `*.repository.ts`
- Shared contracts: `*.types.ts`
- Feature entrypoints: `index.ts`
- Compatibility shims for renamed internals should keep previous filenames as re-export-only modules.

## Module size rule

- Target: ~200-350 LOC per module.
- If logic grows beyond this, split by responsibility before adding features.

## Entrypoint rule

- Keep route handlers thin.
- Move non-trivial behavior to one orchestrator/use-case call.
- Avoid mixing persistence, transport parsing, and business logic in one file.
