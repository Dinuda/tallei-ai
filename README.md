# Tallei AI

Tallei is a persistent memory layer for AI assistants.

## Repository Layout

- `src/` - Express backend, MCP server, auth, memory services, and Postgres schema bootstrap.
- `dashboard/` - Next.js frontend and authenticated workspace UI.
- `mcp-bridge.js` - Claude Desktop stdio bridge for local MCP access.
- `scripts/setup-claude-mcp.mjs` - Helper for installing the Claude Desktop MCP config.
- `scripts/setup-chatgpt-actions.mjs` - Helper for ChatGPT Custom GPT Actions setup details and connectivity checks.

## Core Commands

From the repository root:

```bash
npm run dev
npm run build
npm run start
npm run setup:claude
npm run setup:chatgpt
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

## Setup Connectors

### Claude (MCP)

1. Open `/dashboard/setup` and select `Claude`.
2. Copy your MCP URL and connect it in Claude connectors.
3. Authorize the connector.

Optional local desktop helper:

```bash
npm run setup:claude
```

### ChatGPT 
1. Open `/dashboard/setup` and select `ChatGPT`.
2. Generate an API key inline (shown once).
3. Copy the OpenAPI URL: `https://<your-public-domain>/api/chatgpt/openapi.json`.
4. In ChatGPT GPT Builder, switch from `Create` to `Configure`.
5. Under `Actions`, create a new action and import from that OpenAPI URL.
6. Set auth as API key header `Authorization` with value `Bearer gm_...`.
7. Paste the provided GPT instruction template in `Configure` and publish.

CLI helper:

```bash
npm run setup:chatgpt
npm run setup:chatgpt -- --check --base-url https://<your-public-domain> --api-key gm_<key>
```

## Shared Memory Identity Model

Claude and ChatGPT share the same memory graph only when both are configured against the same Tallei user context (same account and corresponding API key scope).
