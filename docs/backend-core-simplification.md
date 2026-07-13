# Backend Core Simplification (Contributor-Focused)

This document defines the practical refactor strategy for keeping backend code understandable and composable.

## Goals

- No external API contract changes.
- Smaller modules with predictable responsibilities.
- Conservative cleanup: remove only proven-unused code.
- Keep tests/build/dependency checks green after each phase.

## Phase breakdown

1. Stabilize boundaries and split oversized files behind compatibility exports.
2. Remove high-confidence dead code and isolate uncertain legacy helpers.
3. Improve contributor ergonomics with module READMEs + architecture checks.

## Guardrails

- `npm run deps:rules`: dependency direction checks.
- `npm run size:check`: warns for oversized files and growth of known legacy large files.
- `npm run architecture:check`: combined architecture checks.

## Naming conventions

- `*.usecase.ts`: behavior/use-case logic.
- `*.repository.ts`: persistence adapters.
- `*.types.ts`: shared contracts.
- Route handlers should remain thin and delegate to service/use-case modules.
