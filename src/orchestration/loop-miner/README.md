# Loop Miner Guide

Loop miner detects repeated work patterns and proposes automations.

## Main flow

1. Ingest evidence events
2. Detect loop candidates
3. Build episodes
4. Evaluate + implementability filter
5. Generate workflow DNA
6. Persist suggestions

## Where to edit

- Main runtime: `loop-miner.ts`
- Detection logic: `loop-detector.usecase.ts`
- Episode building: `episode-builder.usecase.ts`
- Shared domain contracts and helpers: `core/loop-miner.types.ts`, `core/loop-miner-prompts.ts`, `core/loop-miner-helpers.ts`, `core/loop-miner-models.ts`

## Contributor rule

- Keep each phase implementation isolated; avoid cross-phase coupling.
- Prefer adding phase-specific helpers over growing a catch-all helper module.
