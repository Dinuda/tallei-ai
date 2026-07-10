# ADR-013: Remove Collab and Developer Workflows UI

**Status:** Accepted  
**Date:** 2026-07-10

---

## Context

Tallei shipped two overlapping cross-AI coordination surfaces:

1. **Collab** — ChatGPT ↔ Claude turn-taking via four MCP tools (`collab_check_turn`, `collab_take_turn`, `collab_list_pending`, `collab_create_task`), `/api/tasks`, ChatGPT Actions under `/api/chatgpt/collab/*`, dashboard UI at `/dashboard/collab` and `/dashboard/tasks`, and three Postgres tables (`collab_tasks`, `orchestration_sessions`, `user_task_preferences`).

2. **Developer Workflows** — an observability page at `/dashboard/developer/workflows` and `/api/developer` proxy. The backend routes and page were removed earlier (commit `93f42246`); only a dead sidebar link and dashboard API proxy remained.

**Loops + Conductor** is the durable replacement for multi-step automation. Collab duplicated orchestration concepts (roles, turns, handoffs) without Temporal durability, billing clarity, or a single spec model.

---

## Decision

Remove Collab entirely and finish cleaning up Developer Workflows leftovers.

### Deleted backend

- `src/services/collab/` (including `collab.service.ts`)
- `src/services/task-preferences.ts`
- `src/transport/http/routes/tasks.ts`
- `src/transport/http/routes/collab.ts` (was unmounted)

### Removed MCP surface

- Four collab MCP tools and their schemas in `packages/mcp-tools/defs.ts`
- Handlers, scope checks, and `collab_sessions` billing gate in `src/transport/mcp/tools/index.ts`
- Collab protocol instructions and `collab_task_id` logging in `src/transport/mcp/server.ts`
- OAuth scopes `collab:read` and `collab:write` from defaults (`oauth.ts`, `routes/oauth.ts`, `routes/mcp.ts`, `app.ts`)

### Removed ChatGPT / prepare integration

- All `/api/chatgpt/collab/*` handlers and `collab_continue` action from `src/transport/http/routes/chatgpt.ts`
- Collab branches from `src/transport/shared/chat-actions.ts` (`[COLLAB:*]` classifier, focused task context, collab memory recall)
- `collabTaskId` from MCP event logging and API responses
- Collab setup from `instructions/claude.md`, `instructions/chatgpt.md`, `scripts/setup-chatgpt-actions.mjs`, and `src/config/claude-connector-instructions.ts`

### Deleted dashboard

- `dashboard/app/dashboard/collab/` (entire tree)
- `dashboard/app/dashboard/tasks/` (re-export wrappers)
- `dashboard/app/dashboard/orchestrate/` (planning redirects)
- `dashboard/app/api/collab/`, `dashboard/app/api/tasks/`, `dashboard/app/api/developer/`
- Collab nav item, Workflows nav item, `collab` platform badge, MCP event task links, `collab-i.png` preload

### Database teardown (`initDb`)

`dropCollabArtifacts()` runs on boot when auto-migrate is enabled:

- `DELETE FROM memory_records WHERE memory_type = 'collab'`
- Drop `mcp_call_events.collab_task_id` (FK, index, column)
- `DROP TABLE orchestration_sessions`, `user_task_preferences`, `collab_tasks`

All `CREATE TABLE` / RLS blocks for those tables were removed from schema init.

### Memory model

- Removed `collab` from `memory-types.ts` and `memory.ts`
- Renamed ChatGPT import signals: `collab_ref` → `uuid_ref`, `collab_command` → `task_command`

---

## Rationale

**Product focus.** Collab and Loops solved similar problems; maintaining both increased surface area (MCP tools, Actions, dashboard, billing gates, import heuristics) without a clear user split.

**Operational cost.** Collab required custom turn state, attachment ingestion, ChatGPT Action payload limits, and cross-platform handoff copy — all outside the loop spec model.

**Dead UI.** Developer Workflows pointed at routes that no longer existed; Temporal execution (`src/temporal/*`) was never removed and does not depend on that page.

**Data policy.** Hard drop on deploy: existing collab tasks and collab-tagged memories are not migrated.

---

## Consequences

**Removed capabilities**

- Cross-AI collab tasks (ChatGPT ↔ Claude turn-taking)
- Four collab MCP tools and `/api/tasks`
- ChatGPT Actions: `collab_continue` and `/api/chatgpt/collab/*`
- Dashboard: Collab, Tasks, Orchestrate, Developer Workflows
- OAuth scopes `collab:read` / `collab:write` (existing tokens remain valid but tools are gone)

**Unchanged**

- Memory MCP tools (`save_memory`, `recall_memories`, preferences, documents, etc.)
- Developer section: **Memory Cleanup** and **Activity** (MCP events)

**Also removed (see ADR-014, ADR-015)**

- Loops + Conductor, Temporal worker, Composio connectors, browser automation, in-app operator scheduling

**Breaking change for external integrations**

Claude MCP connectors and ChatGPT Custom GPTs that call collab tools or actions will fail after deploy. Users should use memory/document tools directly.

---

## Verification

```bash
npm test
rg -i '\bcollab\b' --glob '!node_modules' --glob '!dist' --glob '!.git' --glob '!.next'
cd dashboard && npx tsc --noEmit
```

Expected: only `dropCollabArtifacts()` references `collab` in source (migration teardown). `/dashboard/tasks` and `/dashboard/developer/workflows` return 404.

---

## Related

- ADR-008: Frozen HTTP/MCP contract (collab tools/routes removed via intentional snapshot update)
- ADR-012: Remove graph layer (prior large feature removal)
- [ADR-014: Loops teardown](./014-loops-teardown.md)
- [Product scope](../product-scope.md)
