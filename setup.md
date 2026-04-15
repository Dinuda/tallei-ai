# Local Development Setup

This guide sets up Tallei locally for development.

## 1) Prerequisites

- Node.js 22+ (recommended to match production image)
- npm
- Docker Desktop (recommended for local Postgres)
- OpenAI API key
- Google OAuth credentials (for login and OAuth flows)

## 2) Install Dependencies

From repo root:

```bash
npm install
```

From dashboard directory:

```bash
cd dashboard
npm install
cd ..
```

## 3) Start Local Database

The repo ships a Postgres container:

```bash
docker compose up -d
```

This starts local Postgres at `localhost:5432` with default credentials from [`docker-compose.yml`](./docker-compose.yml).

## 4) Configure Environment

Create backend env file:

```bash
cp .env.example .env
```

Create dashboard env file:

```bash
cp dashboard/.env.example dashboard/.env.local
```

Minimum required backend values in `.env`:

- `INTERNAL_API_SECRET`
- `DATABASE_URL`
- `OPENAI_API_KEY`
- `JWT_SECRET`
- `PUBLIC_BASE_URL`
- `FRONTEND_URL`
- `MCP_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

Recommended local values:

- `PORT=3000`
- `HOST=127.0.0.1`
- `PUBLIC_BASE_URL=http://localhost:3001`
- `FRONTEND_URL=http://localhost:3001`
- `MCP_URL=http://localhost:3001/mcp`
- `DATABASE_URL=postgresql://tallei:tallei@localhost:5432/tallei`

Minimum dashboard values in `dashboard/.env.local`:

- `NEXTAUTH_URL=http://localhost:3001`
- `AUTH_URL=http://localhost:3001`
- `AUTH_TRUST_HOST=true`
- `NEXTAUTH_SECRET=<random>`
- `GOOGLE_CLIENT_ID=<same as backend>`
- `GOOGLE_CLIENT_SECRET=<same as backend>`
- `BACKEND_URL=http://127.0.0.1:3000`
- `API_PROXY_TARGET=http://127.0.0.1:3000`
- `INTERNAL_API_SECRET=<must match backend>`
- `NEXT_PUBLIC_APP_URL=http://localhost:3001`

If you want graph features locally, you can also enable:

- `GRAPH_EXTRACTION_ENABLED=true`
- `DASHBOARD_GRAPH_V2_ENABLED=true`
- `RECALL_V2_ENABLED=true`

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

Build checks:

```bash
npm run build
cd dashboard && npm run build
```

Proxy sanity checks (dashboard -> backend):

```bash
curl -i http://localhost:3001/health
```

## 8) Optional: Local Connector Testing

For external OAuth/MCP testing from Claude/ChatGPT, use a public tunnel and update:

- `PUBLIC_BASE_URL`
- `FRONTEND_URL`
- `MCP_URL`
- `NEXTAUTH_URL`
- `NEXT_PUBLIC_APP_URL`
- `GOOGLE_REDIRECT_URI`

## 9) Common Local Issues

- `Missing required env var ...`
  - Ensure `.env` and `dashboard/.env.local` are both present and complete.
- Dashboard fails to proxy API routes:
  - Confirm `API_PROXY_TARGET` and `BACKEND_URL` point to `http://127.0.0.1:3000`.
- OAuth callback mismatch:
  - Ensure Google OAuth redirect URIs exactly match your local URL values.
