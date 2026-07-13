# Transport Shared Guide

This folder contains shared transport-facing logic used by HTTP/MCP routes.

## Focus files

- `chat-actions.ts`: shared action parsing/execution helpers for chat-facing routes.
- `chatgpt-action-events.ts`: action telemetry helpers.
- `integration-assets.ts`: integration metadata/version assets.

## Editing rule

- Keep transport schema/validation and mapping logic here.
- Push business behavior into services/orchestration modules.
- Avoid importing route handlers into shared transport helpers.
