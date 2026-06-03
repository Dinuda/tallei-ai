# Services Contributor Guide

Use this folder for orchestration-facing application services only.

## High-traffic files

- `approval-tokens.ts`: approval token creation, lookup, and consumption shared by loop gates and notifications.
- `connectors/`: connector account/auth integrations, including Composio.
- `memory-cleanup.ts`: cleanup pipeline orchestration and admin reporting.
- `memory.ts`: memory save/recall service facade.

## Service Modules

- `chatgpt-import/`: ChatGPT import job orchestration + import artifact storage.
- `notifications/`: email templates, resend delivery, signup/payment notification flows.
- `collab/`: collaboration task orchestration service.
- `loop-executor/`: loop workflow execution, approvals, tools, and scheduling.

## Editing rules

- Keep exported service APIs stable unless route contracts explicitly change.
- Split by responsibility into submodules under `src/services/<service-name>/` when logic grows.
- Route files should call service functions; avoid embedding business logic directly in transport.
