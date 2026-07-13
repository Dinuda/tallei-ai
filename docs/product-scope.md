# Product Scope (July 2026)

What Tallei ships today after the Conductor / Loops teardown.

## In scope

| Area | Description |
|------|-------------|
| **MCP memory I/O** | `save_memory`, `recall_memories`, `list_memories`, preferences, document notes |
| **ChatGPT Actions** | `prepare_response`, remember, recall, document upload |
| **Documents** | Document notes, blobs, search, Vertex embeddings (feature-flagged) |
| **Memory cleanup** | Admin pipeline + dashboard at `/dashboard/memory-cleanup` |
| **Dashboard** | Memories, documents, setup wizard, billing, MCP events |
| **Billing** | Lemon Squeezy integration |
| **Model gateway** | `src/model/` + `src/resilience/` for `chat` and `embed` purposes |
| **Integrations marketing** | Public landing + setup copy for cross-AI memory |

## Removed

| Area | Notes |
|------|-------|
| **Collab** | ChatGPT ↔ Claude turn-taking; see [ADR-013](adr/013-remove-collab-and-developer-workflows.md) |
| **Conductor / Loops** | Builder UI, `/api/loops`, loop specs, compiled plans; see [ADR-014](adr/014-loops-teardown.md) |
| **Temporal** | Worker, workflows, cron scheduling |
| **Composio / connectors** | OAuth toolkits, webhook triggers, connector accounts |
| **Workspace KB** | `loop_workspaces`, workspace memory, knowledge bases |
| **Loop miner** | Suggested loops from memory episodes |
| **Graph layer** | Entity/relation extraction and graph recall ([ADR-012](adr/012-remove-graph-layer.md)) |

Packages removed: `@tallei/conductor-tools`, `@tallei/composio-tools`, `@tallei/tallei-tools`, `@tallei/shared`. Only `@tallei/mcp-tools` remains.

## Kept for future rebuild

- `src/model/` — model registry, routing, streaming resolver
- `src/resilience/` — retry, timeout, circuit breaker
- `dashboard/src/components/ai-elements/` — conversation, tool, reasoning, prompt UI
- `dashboard/src/components/ui/` — shadcn primitives

## Boot behavior

On startup, `src/infrastructure/db/index.ts` drops legacy automation and collab tables (`REMOVED_AUTOMATION_TABLES`, `dropCollabArtifacts`). Existing deployments migrate automatically.

## HTTP routes (backend)

Mounted in `src/transport/http/app.ts`:

- `/api/auth`, `/api/oauth`, `/api/keys`
- `/api/memories`, `/api/documents`, `/api/chatgpt`
- `/api/integrations`, `/api/integration-updates`, `/api/billing`
- `/api/mcp/events`, `/api/mcp`
- `/mcp` (MCP protocol)
- `/health`

## Related

- [ADR-014: Loops teardown](adr/014-loops-teardown.md)
- [ADR-013: Collab removal](adr/013-remove-collab-and-developer-workflows.md)
- [Architecture](architecture.md)
- [setup.md](../setup.md)
