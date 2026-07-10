# Tallei — Claude Project Guide

## Overview

Tallei is a cross-AI ghost memory system that bridges Claude, ChatGPT, and Gemini via:

- **MCP server** (Node.js/Express) — memory save/recall via vector search
- **Next.js dashboard** — memories, documents, connector setup, billing
- **PostgreSQL + Qdrant** — persistent store and vector index
- **Model gateway** (`src/model/`, `src/resilience/`) — chat and embed workloads

**Primary goal:** Make memory I/O blazingly fast so MCP tools never block.

**Removed (July 2026):** Conductor, Loops, Temporal, Composio, collab, workspace KB, loop-miner, browser automation. See [ADR-014](docs/adr/014-loops-teardown.md), [ADR-015](docs/adr/015-execution-engine-boundary.md), [ADR-013](docs/adr/013-remove-collab-and-developer-workflows.md), and [product scope](docs/product-scope.md).

---

## Architecture & Key Files

### Backend (`src/`)

| Path | Purpose |
|------|---------|
| `src/index.ts` | Process entry; boots composition root |
| `src/bootstrap/composition-root.ts` | Sole wiring point for services and transport |
| `src/transport/http/app.ts` | Express app + route mounts |
| `src/transport/http/routes/*.ts` | HTTP API handlers |
| `src/transport/mcp/server.ts` | MCP server + OAuth |
| `src/transport/mcp/tools/index.ts` | MCP tool handlers |
| `packages/mcp-tools/defs.ts` | MCP tool JSON schemas (contract-tested) |
| `src/services/memory.ts` | Memory save/recall facade; fire-and-forget saves |
| `src/orchestration/memory/` | Save/recall/list use cases |
| `src/infrastructure/recall/bucket-recall.ts` | Three-bucket recall |
| `src/infrastructure/db/index.ts` | PostgreSQL pool, schema init |
| `src/infrastructure/auth/` | JWT, OAuth token verification |
| `src/model/` | Model registry, routing, providers (`chat` / `embed` only) |
| `src/resilience/` | Retry, timeout, circuit breaker policies |
| `src/services/memory-cleanup.ts` | Admin memory cleanup pipeline |

### Frontend (`dashboard/`)

| Path | Purpose |
|------|---------|
| `dashboard/app/globals.css` | Theme CSS variables (lime accent `#7eb71b`) |
| `dashboard/app/(public)/page.tsx` | Landing page |
| `dashboard/app/dashboard/page.tsx` | Memory feed |
| `dashboard/app/dashboard/setup/page.tsx` | MCP connector wizard |
| `dashboard/app/dashboard/documents/page.tsx` | Document library |
| `dashboard/app/dashboard/memory-cleanup/page.tsx` | Cleanup admin UI |
| `dashboard/app/dashboard/mcp-events/page.tsx` | MCP activity log |
| `dashboard/app/dashboard/layout.tsx` | Sidebar nav + topbar |
| `dashboard/src/components/ai-elements/` | Reusable chat UI kit (kept for future rebuild) |
| `dashboard/src/components/ui/` | shadcn-style primitives |
| `dashboard/next.config.ts` | API rewrites (local vs backend proxy) |

---

## Model Gateway

- Purposes: `chat`, `embed` only
- Providers: OpenAI, Anthropic, Google, Ollama, OpenCode, NVIDIA
- Config: `TALLEI_LLM__*` and `TALLEI_EMBED__*` in `.env.example`
- Registry: `src/model/registry.ts`, routing: `src/model/routing.ts`
- Resilience wraps provider calls via `src/resilience/policies.ts`

## Packages

Workspace packages: `@tallei/mcp-tools` only. Build with `npm run build:packages`.

---

## Core Performance Optimizations

### Memory Service (`src/services/memory.ts`)

- **Fire-and-forget `saveMemory()`** — returns immediately; summarize → embed → store runs in background (~10–30ms p50)
- **Recall caches** — in-process LRU (10 min) + Redis exact match (120s) before bucket recall

### MCP Server (`src/transport/mcp/server.ts`)

- **OAuth token cache (10 min TTL)** — avoids repeated crypto/DB verification

**When adding MCP tools:** cache anything that hits OpenAI, Qdrant, or repeats within a short window.

---

## Design System

See `dashboard/app/globals.css` for CSS variables (`--bg`, `--accent`, `--surface`, etc.). Display font: DM Sans; body: Plus Jakarta Sans.

---

## Common Tasks

### Adding a new MCP tool

1. Add schema to `packages/mcp-tools/defs.ts`
2. Register handler in `src/transport/mcp/tools/index.ts`
3. Consider caching for expensive I/O
4. Update contract snapshot: `UPDATE_CONTRACT_SNAPSHOTS=true npm run test:contract`

### Adding a new API route

1. Create a route file under `src/transport/http/routes/`
2. Mount in `src/transport/http/app.ts`
3. Use existing auth middleware + scope checks
4. Update contract tests if the route is part of the frozen HTTP surface

### Deploying the MCP server

- Public URL: `TALLEI_HTTP__MCP_URL` or `NEXT_PUBLIC_API_BASE_URL` + `/mcp`
- Must be HTTPS for Claude.ai connectors
- Users copy the URL from `/dashboard/setup`

---

## Key Constraints

### Turn Protocol

**First turn:** Call `recall_memories` reflexively. **Subsequent turns:** only when the user references prior context or the task requires it.

### Save & Checkpoint

- Checkpoints on "save"/"checkpoint" or substantial output (>800 chars)
- Auto-save structured content as `document-note` with undo footer

### Don't Break Memory Performance

Never await the full save pipeline in the MCP handler. Test with `curl` — target sub-100ms foreground latency.

### Naming

- MCP tools: `snake_case`
- API routes: kebab-case
- React components: PascalCase

---

## Environment Variables

See [`.env.example`](.env.example) for canonical `TALLEI_*` keys. Legacy `DATABASE_URL`, `OPENAI_API_KEY`, etc. are mapped at boot via `src/config/env-aliases.ts`.

---

## Testing & Debugging

```bash
# MCP tool (needs OAuth bearer token)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall_memories","arguments":{"query":"user preferences","limit":5}}}'

# Dashboard
cd dashboard && npm run dev   # http://localhost:3001

# Full check
npm run build && npm run test:unit && cd dashboard && npx tsc --noEmit
```

---

## Documentation

- [setup.md](setup.md) — local dev
- [docs/architecture.md](docs/architecture.md) — canonical architecture
- [docs/product-scope.md](docs/product-scope.md) — current product boundary
- [docs/README.md](docs/README.md) — doc index

---

## Future Improvements

- [ ] Background job queue for more reliable memory persistence
- [ ] Incremental recall streaming
- [ ] Memory editing UI beyond delete
- [ ] Rate limiting on MCP tools
- [ ] Audit logging for memory access
