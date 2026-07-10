# Local Development Setup

This guide sets up Tallei locally for development.

## 1) Prerequisites

- Node.js 22+ (recommended to match production image)
- npm
- Docker Desktop (recommended for local Postgres)
- OpenAI API key (or Ollama for local model mode)
- Google OAuth credentials (for login and OAuth flows)

## 2) Install Dependencies

From repo root (npm workspaces include `dashboard` and `packages/mcp-tools`):

```bash
npm install --legacy-peer-deps
```

If you hit peer dependency conflicts with `mem0ai`, `--legacy-peer-deps` is the supported workaround.

## 3) Start Local Database

The repo ships a Postgres container:

```bash
docker compose up -d
```

This starts local Postgres at `localhost:5432` with default credentials from [`docker-compose.yml`](./docker-compose.yml).

On first boot the backend drops legacy automation and collab tables if they still exist. See [ADR-014](docs/adr/014-loops-teardown.md) and [ADR-013](docs/adr/013-remove-collab-and-developer-workflows.md).

## 4) Configure Environment

Create backend env file:

```bash
cp .env.example .env
```

Create dashboard env file:

```bash
cp dashboard/.env.example dashboard/.env.local
```

Canonical keys use the `TALLEI_*` prefix (see [`.env.example`](.env.example)). Legacy names like `DATABASE_URL` and `OPENAI_API_KEY` are auto-mapped at boot.

Minimum required backend values:

- `TALLEI_HTTP__INTERNAL_API_SECRET`
- `TALLEI_DB__URL`
- `TALLEI_AUTH__JWT_SECRET`
- `TALLEI_LLM__OPENAI_API_KEY` (unless `TALLEI_LLM__LOCAL_MODEL_MODE=true` with Ollama)
- `TALLEI_HTTP__PUBLIC_BASE_URL`
- `TALLEI_HTTP__FRONTEND_URL`
- `TALLEI_HTTP__MCP_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

Recommended local values:

- `TALLEI_HTTP__PORT=3000`
- `TALLEI_HTTP__HOST=127.0.0.1`
- `TALLEI_HTTP__PUBLIC_BASE_URL=http://localhost:3001`
- `TALLEI_HTTP__FRONTEND_URL=http://localhost:3001`
- `TALLEI_HTTP__MCP_URL=http://localhost:3001/mcp`
- `TALLEI_DB__URL=postgresql://tallei:tallei@localhost:5432/tallei`
- `TALLEI_LLM__LOCAL_MODEL_MODE=true`
- `TALLEI_LLM__PROVIDER=ollama`

Minimum dashboard values in `dashboard/.env.local`:

- `NEXTAUTH_URL=http://localhost:3001`
- `AUTH_URL=http://localhost:3001`
- `AUTH_TRUST_HOST=true`
- `NEXTAUTH_SECRET=<random>`
- `GOOGLE_CLIENT_ID=<same as backend>`
- `GOOGLE_CLIENT_SECRET=<same as backend>`
- `BACKEND_URL=http://127.0.0.1:3000`
- `API_PROXY_TARGET=http://127.0.0.1:3000`
- `INTERNAL_API_SECRET=<must match TALLEI_HTTP__INTERNAL_API_SECRET>`
- `NEXT_PUBLIC_APP_URL=http://localhost:3001`

Optional recall tuning:

- `TALLEI_MISC__RECALL_HYBRID_SIMILARITY_FLOOR=0.35`

## 5) Run Backend

From repo root:

```bash
npm run dev
```

Health check:

```bash
curl -i http://127.0.0.1:3000/health
```

## 6) Run Dashboard

From a second terminal:

```bash
cd dashboard
npm run dev
```

Open:

- `http://localhost:3001`

## 7) Local Verification

Build and typecheck:

```bash
npm run build
npm run test:unit
cd dashboard && npx tsc --noEmit
```

Proxy sanity check (dashboard → backend):

```bash
curl -i http://localhost:3001/health
```

## 8) Optional: Local Connector Testing

For external OAuth/MCP testing from Claude/ChatGPT, use a public tunnel and update:

- `TALLEI_HTTP__PUBLIC_BASE_URL`
- `TALLEI_HTTP__FRONTEND_URL`
- `TALLEI_HTTP__MCP_URL`
- `NEXTAUTH_URL`
- `NEXT_PUBLIC_APP_URL`
- `GOOGLE_REDIRECT_URI`

For ChatGPT Actions import, use:

- `http://<your-public-host>/chatgpt/actions/openapi.json`

Instruction templates:

- Claude: `instructions/claude.md`
- ChatGPT: `instructions/chatgpt.md`

## 9) Common Local Issues

- `Missing required env var ...`
  - Ensure `.env` and `dashboard/.env.local` are both present and complete.
- Dashboard fails to proxy API routes:
  - Confirm `API_PROXY_TARGET` and `BACKEND_URL` point to `http://127.0.0.1:3000`.
- OAuth callback mismatch:
  - Ensure Google OAuth redirect URIs exactly match your local URL values.
- `npm install` peer dependency errors:
  - Retry with `npm install --legacy-peer-deps`.
