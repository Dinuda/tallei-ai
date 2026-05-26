# Services Contributor Guide

Use this folder for orchestration-facing application services only.

## High-traffic files

- `workflow-automation.ts`: workflow suggestions, approvals, connectors, and daily automation entrypoints.
- `memory-cleanup.ts`: cleanup pipeline orchestration and admin reporting.
- `memory.ts`: memory save/recall service facade.

## Service Modules

- `chatgpt-import/`: ChatGPT import job orchestration + import artifact storage.
- `notifications/`: email templates, resend delivery, signup/payment notification flows.
- `collab/`: collaboration task orchestration service.
- `workflow-automation/`: daily intelligence internals and workflow builder submodule.

Top-level files like `chatgpt-import-jobs.ts`, `resend-email.ts`, `collab.ts`, and `workflow-builder.ts` are compatibility re-export shims.

## Editing rules

- Keep exported service APIs stable unless route contracts explicitly change.
- Split by responsibility into submodules under `src/services/<service-name>/` when logic grows.
- Route files should call service functions; avoid embedding business logic directly in transport.

## Daily flow

- Daily automation currently runs cleanup-first and has loop miner disabled by design.
- Daily orchestration internals live in `src/services/workflow-automation/daily-intelligence/`:
  - `pipeline.ts`: end-to-end orchestration
  - `state.repository.ts`: DB-backed claim/skip/completion helpers
  - `cleanup-policy.ts`: first-run throttling policy
  - `types.ts`: dependency contracts
  - `index.ts`: module entrypoint
