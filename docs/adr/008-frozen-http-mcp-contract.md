# ADR-008 — Frozen HTTP/MCP public contract

**Status**: Accepted  
**Date**: 2026-04-20

## Context

Tallei has active external consumers that cannot be notified of breaking changes in real time:
- **Claude.ai connector** — uses the MCP server at a fixed URL. Claude.ai discovers tools by name and calls them by name. A renamed tool is a broken connector.
- **ChatGPT Actions** — uses the HTTP REST API with a fixed OpenAPI spec imported into ChatGPT. A changed path or method breaks the action.

Internal refactoring (module paths, env var names, constructor signatures) is safe to change freely. The external surface is not.

## Decision

The following are permanently frozen. Changes require a versioning strategy and a deprecation window communicated to affected users.

**MCP tool names + `inputSchema`** (in `src/transport/mcp/schemas.ts`):
```
save_memory, save_preference, recall_memories, recall_memories_v2,
list_memory_entities, explain_memory_connection, memory_graph_insights,
list_memories, list_preferences, delete_memory, forget_preference
```

**HTTP route paths + methods** (in `src/transport/http/routes/`):
All routes currently defined — paths and HTTP methods are frozen.

**Contract tests** (`test/contract/routes.test.ts`, `test/contract/mcp-tools.test.ts`) snapshot the full set of routes and tool schemas. Any drift from the golden snapshot fails CI. To add a new tool or route, the golden snapshot must be deliberately updated in the same PR, making the change explicit and reviewable.

## Consequences

- Adding a new MCP tool requires updating the golden snapshot intentionally — accidental renames are caught.
- Removing or renaming a tool requires a deprecation notice and a transition period with both names active.
- The contract test suite runs in under 2 seconds (no I/O — it just introspects the router and MCP server builder) and is the cheapest CI gate.
- Internal reorganisation (Phase 4 folder moves) does not affect contract tests, confirming the surface is stable.
