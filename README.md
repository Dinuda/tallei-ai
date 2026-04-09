# Tallei AI

Tallei is a persistent memory layer for AI assistants.

## Repository Layout

- `src/` - Express backend, MCP server, auth, memory services, and Postgres schema bootstrap.
- `dashboard/` - Next.js frontend and authenticated workspace UI.
- `mcp-bridge.js` - Claude Desktop stdio bridge for local MCP access.
- `scripts/setup-claude-mcp.mjs` - Helper for installing the Claude Desktop MCP config.

## Core Commands

From the repository root:

```bash
npm run dev
npm run build
npm run start
npm run setup:claude
```

## Dashboard Commands

From `dashboard/`:

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Environment

See `.env.example` for the required variables. The backend validates required secrets at startup, so a missing value fails fast instead of producing partial state.

### Hosted Production Stack

- **Relational + auth data**: Supabase Postgres (`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
- **Vector search**: Qdrant Cloud (`QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION_NAME`)
- **Distributed cache + rate limits**: Redis (`REDIS_URL`)
- **Memory encryption key**: `MEMORY_MASTER_KEY` (+ optional `KMS_KEY_ID`)

Dual-write and shadow-read migration controls:

- `MEMORY_DUAL_WRITE_ENABLED`
- `MEMORY_SHADOW_READ_ENABLED`
