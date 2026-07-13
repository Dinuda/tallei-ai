# Memory Orchestration Guide

This module contains memory-domain use cases and import pipelines.

## Where to edit

- Save/recall behavior: `save.usecase.ts`, `recall.usecase.ts`, `list.usecase.ts`
- Import pipeline: `chatgpt-import.usecase.ts` and `chatgpt-bulk-*`
- Ranking/classification helpers: `chatgpt-import-*.usecase.ts`, `memory-classification.ts`

## Guardrails

- Keep use cases isolated from transport concerns.
- New behavior should land as `*.usecase.ts` and be composed by service layer.
- Reuse shared classification/ranking helpers; avoid duplicate prompt parsing logic.
